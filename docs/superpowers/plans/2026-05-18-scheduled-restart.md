# Scheduled Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily scheduled restart of the `copilot-api` systemd service at a configurable time (default 02:00), via a sibling `copilot-api-restart.service` driven by a small bash scheduler script.

**Architecture:** A dedicated long-running systemd service (`copilot-api-restart.service`) runs `scripts/restart-scheduler.sh`. The script reads `RESTART_TIME` from `.env`, sleeps until the next occurrence, runs `systemctl restart copilot-api`, and exits. systemd `Restart=always` brings it back, re-reading `.env` each cycle. `RESTART_TIME=off` puts the script into `exec sleep infinity` so it stays alive without restarting anything.

**Tech Stack:** bash 3.2 (macOS-compatible), POSIX/BSD `date`, systemd unit files, `sed`-based template rendering. Tests use `bun test` shelling out to bash via `Bun.$`, mirroring the existing `tests/install-script.test.ts` and `tests/crash-handler-script.test.ts` pattern.

**Note on spec deviation:** The spec mentioned standalone `bash tests/restart-scheduler.test.sh`. We use the existing bun-test harness instead (`tests/restart-scheduler.test.ts` + `Bun.$`) for codebase consistency. Test substance (cases, behavior matrix) is unchanged.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/systemd/copilot-api-restart.service.template` | Create | systemd unit template for the scheduler. |
| `scripts/restart-scheduler.sh` | Create | Scheduler loop body. Exposes `compute_delta_seconds` as a sourced function for tests. |
| `scripts/install.sh` | Modify | Render both unit templates, seed `RESTART_TIME` in `.env`, enable+start scheduler unit. New `__USER_MODE__` placeholder. |
| `scripts/uninstall.sh` | Modify | Remove scheduler unit before main unit, reset-failed both. |
| `scripts/.env.example` | Modify | Document `RESTART_TIME` with default `02:00`. |
| `tests/restart-scheduler.test.ts` | Create | Unit tests for the scheduler script (delta math, off/empty, systemctl dispatch). |
| `tests/install-script.test.ts` | Modify | Assert new placeholders, scheduler unit rendering, `RESTART_TIME` seeded in `.env`, `--render-only` prints both units. |
| `tests/helpers/shell-fixtures.ts` | Modify | Copy the new `restart-scheduler.sh` and scheduler template alongside existing files. |

---

## Task 1: Add scheduler systemd unit template

**Files:**
- Create: `scripts/systemd/copilot-api-restart.service.template`

- [ ] **Step 1: Create the template file**

Path: `scripts/systemd/copilot-api-restart.service.template`

```ini
# release-schema=1
[Unit]
Description=Copilot API scheduled restart (daily)
After=__SERVICE_NAME__.service

[Service]
Type=simple
User=__USER__
WorkingDirectory=__RELEASE_DIR__
# Leading `-` makes the env file optional, matching the main unit.
EnvironmentFile=-__RELEASE_DIR__/.env
Environment=SERVICE_NAME=__SERVICE_NAME__
Environment=USER_MODE=__USER_MODE__
ExecStart=__RELEASE_DIR__/scripts/restart-scheduler.sh

# Each scheduler iteration runs once and exits cleanly (exit 0) after
# triggering a restart. Restart=always cycles us back so the script
# re-reads .env and computes the next target. RestartSec=5s bounds the
# retry loop in the bad-config case (exit 1).
Restart=always
RestartSec=5s
StartLimitBurst=0
StartLimitIntervalSec=0

# Separate log file to keep main-service logs uncluttered.
StandardOutput=append:__RELEASE_DIR__/copilot-api-restart.log
StandardError=append:__RELEASE_DIR__/copilot-api-restart.log
SyslogIdentifier=__SERVICE_NAME__-restart

NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Verify the file exists**

Run: `ls -l scripts/systemd/copilot-api-restart.service.template`
Expected: file is present, size > 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/systemd/copilot-api-restart.service.template
git commit -m "feat(systemd): add scheduler unit template for daily restart"
```

---

## Task 2: Create restart-scheduler.sh with sourceable compute_delta_seconds (RED test first)

**Files:**
- Create: `scripts/restart-scheduler.sh` (skeleton only)
- Create: `tests/restart-scheduler.test.ts` (first failing test for `compute_delta_seconds`)
- Modify: `tests/helpers/shell-fixtures.ts` (copy `restart-scheduler.sh` into the fixture)

- [ ] **Step 1: Write the failing test**

Path: `tests/restart-scheduler.test.ts`

```ts
import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

/**
 * Run a tiny bash snippet that sources restart-scheduler.sh and invokes
 * `compute_delta_seconds`. The script must support being sourced without
 * running its main loop.
 */
async function runComputeDelta(
  scriptsDir: string,
  hhmm: string,
  nowHms: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const scriptPath = path.join(scriptsDir, "restart-scheduler.sh")
  const proc = await $`bash -c ${"source " + scriptPath + " && compute_delta_seconds " + JSON.stringify(hhmm) + " " + JSON.stringify(nowHms)}`
    .quiet()
    .nothrow()
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

describe("compute_delta_seconds", () => {
  test("02:00 at 01:00:00 returns 3600", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const res = await runComputeDelta(fx.scriptsDir, "02:00", "01:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("3600")
  })
})
```

- [ ] **Step 2: Add scheduler copy to the shell fixture**

Modify `tests/helpers/shell-fixtures.ts` — add `"restart-scheduler.sh"` to the loop that copies scripts:

```ts
  for (const name of [
    "crash-handler.sh",
    "install.sh",
    "uninstall.sh",
    "restart-scheduler.sh",
  ]) {
```

- [ ] **Step 3: Create the skeleton scheduler script**

Path: `scripts/restart-scheduler.sh`

```bash
#!/bin/bash
# Scheduler for daily copilot-api restart.
#
# Reads RESTART_TIME (HH:MM, 24h local time, or "off") from the environment
# (populated by systemd's EnvironmentFile=.env). Sleeps until the next
# occurrence, then runs `systemctl restart $SERVICE_NAME` and exits 0.
# systemd's Restart=always brings this script back for the next iteration.
#
# Sourceable: when sourced from a test harness, `main` is NOT invoked,
# so callers can exercise `compute_delta_seconds` in isolation.

set -euo pipefail

# --- compute_delta_seconds HHMM [NOW_HMS] ----------------------------------
# Prints the number of seconds from NOW_HMS (default: current wall clock)
# until the next HH:MM. If HH:MM has already passed today, returns
# delta + 86400 (tomorrow). Exits 2 on invalid input.
compute_delta_seconds() {
  local hhmm="$1"
  local now="${2:-$(date +%H:%M:%S)}"

  case "$hhmm" in
    [0-9][0-9]:[0-9][0-9]) : ;;
    *)
      echo "invalid RESTART_TIME (expected HH:MM): $hhmm" >&2
      return 2
      ;;
  esac

  local th tm nh nm ns
  # 10# defeats bash's octal interpretation of leading zeros (e.g. "08").
  th=$((10#${hhmm%:*}))
  tm=$((10#${hhmm#*:}))
  if [ "$th" -gt 23 ] || [ "$tm" -gt 59 ]; then
    echo "invalid RESTART_TIME (hour 0-23, minute 0-59): $hhmm" >&2
    return 2
  fi

  nh=$((10#${now%%:*}))
  local rest="${now#*:}"
  nm=$((10#${rest%%:*}))
  ns=$((10#${rest#*:}))

  local target=$(( th * 3600 + tm * 60 ))
  local current=$(( nh * 3600 + nm * 60 + ns ))
  local delta=$(( target - current ))
  if [ "$delta" -le 0 ]; then
    delta=$(( delta + 86400 ))
  fi
  echo "$delta"
}

# --- main ------------------------------------------------------------------
main() {
  # Placeholder; filled in in a later task. Kept as a no-op so the script
  # remains executable but does nothing harmful if accidentally run.
  echo "restart-scheduler.sh: main() not yet implemented" >&2
  exit 0
}

# Only call main when executed directly, not when sourced.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/restart-scheduler.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/restart-scheduler.sh tests/restart-scheduler.test.ts tests/helpers/shell-fixtures.ts
git commit -m "feat(scheduler): add restart-scheduler.sh skeleton with compute_delta_seconds"
```

---

## Task 3: Cover all compute_delta_seconds cases

**Files:**
- Modify: `tests/restart-scheduler.test.ts`

- [ ] **Step 1: Add the remaining test cases**

Append inside the existing `describe("compute_delta_seconds", ...)` block in `tests/restart-scheduler.test.ts`:

```ts
  test("02:00 at exactly 02:00:00 returns 86400 (already passed → tomorrow)", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "02:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("86400")
  })

  test("02:00 at 01:59:30 returns 30", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "01:59:30")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("30")
  })

  test("02:00 at 23:59:00 returns 7260", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:00", "23:59:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("7260")
  })

  test("00:00 at 12:00:00 returns 43200", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "00:00", "12:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("43200")
  })

  test("08:00 (leading zero) does not trigger octal interpretation", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "08:00", "07:00:00")
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("3600")
  })

  test("25:00 fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "25:00", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })

  test("02:99 fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "02:99", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })

  test("abc fails validation with exit 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const res = await runComputeDelta(fx.scriptsDir, "abc", "12:00:00")
    expect(res.exitCode).toBe(2)
    expect(res.stderr).toContain("invalid RESTART_TIME")
  })
```

- [ ] **Step 2: Run the suite to verify all pass**

Run: `bun test tests/restart-scheduler.test.ts`
Expected: 8 pass (the original + 7 new).

- [ ] **Step 3: Commit**

```bash
git add tests/restart-scheduler.test.ts
git commit -m "test(scheduler): cover full compute_delta_seconds case matrix"
```

---

## Task 4: Implement scheduler main() — off/empty handling (TDD)

**Files:**
- Modify: `tests/restart-scheduler.test.ts`
- Modify: `scripts/restart-scheduler.sh`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `tests/restart-scheduler.test.ts`:

```ts
describe("main() — off/empty", () => {
  test("RESTART_TIME=off enters suspended sleep mode", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    // Replace `sleep` and `systemctl` with stubs by prepending a fake PATH.
    // The fake `sleep` writes its argument and exits, so the script doesn't
    // actually block. The fake `systemctl` should NOT be called.
    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\necho \"SLEEP $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\necho \"SYSTEMCTL $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "off",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const calls = await Bun.file(path.join(fx.releaseDir, "calls.log")).text()
    expect(calls).toContain("SLEEP infinity")
    expect(calls).not.toContain("SYSTEMCTL")
    expect(proc.stdout.toString() + proc.stderr.toString()).toContain(
      "scheduled restart disabled",
    )
  })

  test("RESTART_TIME unset behaves like off", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\necho \"SLEEP $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SERVICE_NAME: "copilot-api",
      USER_MODE: "0",
    }
    delete (env as Record<string, string | undefined>).RESTART_TIME

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env(env)
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const calls = await Bun.file(path.join(fx.releaseDir, "calls.log")).text()
    expect(calls).toContain("SLEEP infinity")
  })

  test("RESTART_TIME='' (empty) behaves like off", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()
    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\necho \"SLEEP $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const calls = await Bun.file(path.join(fx.releaseDir, "calls.log")).text()
    expect(calls).toContain("SLEEP infinity")
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test tests/restart-scheduler.test.ts -t 'off/empty'`
Expected: 3 fail (main is still the stub).

- [ ] **Step 3: Implement off/empty handling in main()**

Replace the `main()` function in `scripts/restart-scheduler.sh` with:

```bash
main() {
  local restart_time="${RESTART_TIME:-}"

  case "$restart_time" in
    ""|off|OFF|Off)
      echo "RESTART_TIME=$restart_time — scheduled restart disabled (sleeping)" >&2
      # `exec` replaces this shell with `sleep`, so systemd sees a quiet
      # idle process. No iteration will fire until the unit is restarted.
      exec sleep infinity
      ;;
  esac

  # Remaining cases handled in later tasks.
  echo "restart-scheduler.sh: scheduled-mode main() not yet implemented" >&2
  exit 0
}
```

- [ ] **Step 4: Run the off/empty tests to verify they pass**

Run: `bun test tests/restart-scheduler.test.ts -t 'off/empty'`
Expected: 3 pass.

- [ ] **Step 5: Run the full suite to verify no regressions**

Run: `bun test tests/restart-scheduler.test.ts`
Expected: 11 pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/restart-scheduler.sh tests/restart-scheduler.test.ts
git commit -m "feat(scheduler): handle RESTART_TIME=off/empty with sleep infinity"
```

---

## Task 5: Implement scheduler main() — invalid input branch (TDD)

**Files:**
- Modify: `tests/restart-scheduler.test.ts`
- Modify: `scripts/restart-scheduler.sh`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block:

```ts
describe("main() — invalid RESTART_TIME", () => {
  test("99:99 exits 1 with error message", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "99:99",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(1)
    expect(proc.stderr.toString()).toContain("invalid RESTART_TIME")
  })
})
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `bun test tests/restart-scheduler.test.ts -t 'invalid RESTART_TIME'`
Expected: 1 fail (no validation in main yet).

- [ ] **Step 3: Add validation to main()**

Replace `main()` in `scripts/restart-scheduler.sh`:

```bash
main() {
  local restart_time="${RESTART_TIME:-}"

  case "$restart_time" in
    ""|off|OFF|Off)
      echo "RESTART_TIME=$restart_time — scheduled restart disabled (sleeping)" >&2
      exec sleep infinity
      ;;
  esac

  # Validate by trying to compute a delta. compute_delta_seconds writes the
  # number to stdout on success, and a message to stderr + exit 2 on failure.
  local delta
  if ! delta="$(compute_delta_seconds "$restart_time")"; then
    # Validation failed; exit 1 lets systemd Restart=always + RestartSec=5s
    # bound the retry rate (5s between attempts) so a bad config doesn't
    # busy-loop. compute_delta_seconds already wrote the error to stderr.
    exit 1
  fi

  # Remaining cases handled in the next task.
  echo "restart-scheduler.sh: schedule/sleep/restart not yet implemented (delta=$delta)" >&2
  exit 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/restart-scheduler.test.ts -t 'invalid RESTART_TIME'`
Expected: 1 pass.

- [ ] **Step 5: Run the full suite**

Run: `bun test tests/restart-scheduler.test.ts`
Expected: 12 pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/restart-scheduler.sh tests/restart-scheduler.test.ts
git commit -m "feat(scheduler): exit 1 on invalid RESTART_TIME for bounded retry"
```

---

## Task 6: Implement scheduler main() — sleep + systemctl restart dispatch (TDD)

**Files:**
- Modify: `tests/restart-scheduler.test.ts`
- Modify: `scripts/restart-scheduler.sh`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
describe("main() — schedule + dispatch", () => {
  test("USER_MODE=0 calls system systemctl restart", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    // Fake `sleep` records its arg and returns immediately (skip the wait).
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\necho \"SLEEP $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )
    // Fake `systemctl` records its full argv.
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\necho \"SYSTEMCTL $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "02:00",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const calls = await Bun.file(path.join(fx.releaseDir, "calls.log")).text()
    // Sleep is called with a positive integer number of seconds.
    expect(calls).toMatch(/SLEEP \d+/)
    // System mode → no --user flag.
    expect(calls).toContain("SYSTEMCTL restart copilot-api")
    expect(calls).not.toContain("--user")
  })

  test("USER_MODE=1 calls systemctl --user restart", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\necho \"SYSTEMCTL $*\" >> " +
        JSON.stringify(path.join(fx.releaseDir, "calls.log")) +
        "\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "02:00",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "1",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const calls = await Bun.file(path.join(fx.releaseDir, "calls.log")).text()
    expect(calls).toContain("SYSTEMCTL --user restart copilot-api")
  })

  test("logs next-restart line on entry and trigger line on fire", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "02:00",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    const all = proc.stdout.toString() + proc.stderr.toString()
    expect(all).toMatch(/scheduled next restart at 02:00 \(in \d+s\)/)
    expect(all).toContain("triggering restart of copilot-api")
  })

  test("propagates exit 0 even when systemctl returns non-zero", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "restart-scheduler.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "sleep"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    // systemctl fails — scheduler must still exit 0 so it doesn't churn.
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 3\n",
      { mode: 0o755 },
    )

    const proc = await $`${path.join(fx.scriptsDir, "restart-scheduler.sh")}`
      .env({
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RESTART_TIME: "02:00",
        SERVICE_NAME: "copilot-api",
        USER_MODE: "0",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test tests/restart-scheduler.test.ts -t 'schedule \\+ dispatch'`
Expected: 4 fail.

- [ ] **Step 3: Implement the sleep + restart path**

Replace `main()` in `scripts/restart-scheduler.sh`:

```bash
main() {
  local restart_time="${RESTART_TIME:-}"
  local service_name="${SERVICE_NAME:-copilot-api}"
  local user_mode="${USER_MODE:-0}"

  case "$restart_time" in
    ""|off|OFF|Off)
      echo "RESTART_TIME=$restart_time — scheduled restart disabled (sleeping)" >&2
      exec sleep infinity
      ;;
  esac

  local delta
  if ! delta="$(compute_delta_seconds "$restart_time")"; then
    exit 1
  fi

  echo "scheduled next restart at $restart_time (in ${delta}s)" >&2

  # Record target time in epoch seconds so we can detect host suspend
  # after sleep returns.
  local target_epoch
  target_epoch=$(( $(date +%s) + delta ))

  # Block until target. `set -e` is on, so a signal-interrupted sleep that
  # exits non-zero would propagate; we explicitly tolerate that with `|| true`
  # so systemd's TERM-on-stop doesn't trip the trap into a "failed" state.
  sleep "$delta" || true

  # Wall-clock-jump / host-suspend guard: if we woke up more than an hour
  # PAST target (clock jumped forward or host was suspended), skip this
  # firing — restarting at a random "catch-up" time isn't what the user
  # asked for. systemd Restart=always brings us back, the next iteration
  # recomputes the next normal occurrence.
  #
  # We deliberately do NOT guard against the "woke early" case: in
  # production, that only happens when systemd sends SIGTERM to stop the
  # unit, and the actual kill races our exit anyway.
  local overshoot
  overshoot=$(( $(date +%s) - target_epoch ))
  if [ "$overshoot" -gt 3600 ]; then
    echo "wall-clock check: woke ${overshoot}s past target — skipping (likely suspend/jump)" >&2
    exit 0
  fi

  echo "triggering restart of $service_name" >&2
  if [ "$user_mode" = "1" ]; then
    systemctl --user restart "$service_name" || true
  else
    systemctl restart "$service_name" || true
  fi

  # Exit 0 unconditionally. systemd Restart=always relaunches us for the
  # next iteration. Bubbling up systemctl's exit code would mask the
  # success/failure distinction we want: scheduler did its job, the main
  # unit's own log is the source of truth for whether the restart worked.
  exit 0
}
```

- [ ] **Step 4: Run the dispatch tests to verify they pass**

Run: `bun test tests/restart-scheduler.test.ts -t 'schedule \\+ dispatch'`
Expected: 4 pass.

- [ ] **Step 5: Run the full suite to verify no regressions**

Run: `bun test tests/restart-scheduler.test.ts`
Expected: 16 pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/restart-scheduler.sh tests/restart-scheduler.test.ts
git commit -m "feat(scheduler): sleep until target then dispatch systemctl restart"
```

---

## Task 7: Update install.sh to render the scheduler unit

**Files:**
- Modify: `scripts/install.sh`
- Modify: `tests/install-script.test.ts`
- Modify: `tests/helpers/shell-fixtures.ts`

- [ ] **Step 1: Update fixture to copy the new template**

In `tests/helpers/shell-fixtures.ts`, the fixture currently only copies the main template via the test's `seedSystemdTemplate` helper. Update **the test** in step 3 below to seed both templates — no change needed in `shell-fixtures.ts` itself for this step (the fixture only copies `.sh` files, not templates).

- [ ] **Step 2: Write the failing test**

In `tests/install-script.test.ts`, find the existing `seedSystemdTemplate` function and replace it to copy both templates:

```ts
async function seedSystemdTemplate(releaseDir: string) {
  const dst = path.join(releaseDir, "scripts", "systemd")
  await mkdir(dst, { recursive: true })
  await cp(
    path.join(ROOT, "scripts", "systemd", "copilot-api.service.template"),
    path.join(dst, "copilot-api.service.template"),
  )
  await cp(
    path.join(ROOT, "scripts", "systemd", "copilot-api-restart.service.template"),
    path.join(dst, "copilot-api-restart.service.template"),
  )
}
```

Then add a new test inside the existing `describe("install.sh", ...)` block:

```ts
  test("--render-only prints both units separated by '# ---'", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only --user testuser --name copilot-api-test`
        .cwd(fx.releaseDir)
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    const out = proc.stdout.toString()

    // Main unit assertions (existing — duplicated here for the new test's
    // own readability rather than relying on the other test).
    expect(out).toContain("Description=Copilot API (GitHub Copilot")

    // Separator + scheduler unit.
    expect(out).toContain("# ---")
    expect(out).toContain("Description=Copilot API scheduled restart")
    expect(out).toContain(
      `ExecStart=${fx.releaseDir}/scripts/restart-scheduler.sh`,
    )
    expect(out).toContain("SyslogIdentifier=copilot-api-test-restart")
    expect(out).toContain("Environment=USER_MODE=0")
    expect(out).toContain("Restart=always")

    // No unrendered placeholders.
    expect(out).not.toContain("__USER__")
    expect(out).not.toContain("__RELEASE_DIR__")
    expect(out).not.toContain("__SERVICE_NAME__")
    expect(out).not.toContain("__USER_MODE__")
  })

  test("--render-only with --user-mode sets USER_MODE=1", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --render-only --user-mode --user testuser`
        .cwd(fx.releaseDir)
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("Environment=USER_MODE=1")
  })
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `bun test tests/install-script.test.ts -t 'both units'`
Expected: 1 fail (separator + scheduler not rendered yet).

Run: `bun test tests/install-script.test.ts -t 'USER_MODE=1'`
Expected: 1 fail.

- [ ] **Step 4: Update install.sh**

Modify `scripts/install.sh`. Locate the existing `render_unit()` function (lines ~57-64) and replace it, plus update the `--render-only` block:

```bash
# --- Render units (pure functions: template + vars -> stdout) ---------------
RESTART_TEMPLATE="$SCRIPT_DIR/systemd/copilot-api-restart.service.template"

render_main_unit() {
  sed \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__RELEASE_DIR__|${RELEASE_DIR}|g" \
    -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
    "$TEMPLATE"
}

render_restart_unit() {
  sed \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__RELEASE_DIR__|${RELEASE_DIR}|g" \
    -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
    -e "s|__USER_MODE__|${USER_MODE}|g" \
    "$RESTART_TEMPLATE"
}

if [ "$RENDER_ONLY" -eq 1 ]; then
  render_main_unit
  # Separator so consumers (and the test suite) can split the stream.
  echo
  echo "# ---"
  echo
  render_restart_unit
  exit 0
fi
```

Also add a check for the new template alongside the existing one. Find:

```bash
if [ ! -f "$TEMPLATE" ]; then
  echo "Error: template not found at $TEMPLATE" >&2
  exit 1
fi
```

Add immediately after:

```bash
if [ ! -f "$RESTART_TEMPLATE" ]; then
  echo "Error: template not found at $RESTART_TEMPLATE" >&2
  exit 1
fi
```

- [ ] **Step 5: Run the render tests to verify they pass**

Run: `bun test tests/install-script.test.ts -t 'both units'`
Expected: 1 pass.

Run: `bun test tests/install-script.test.ts -t 'USER_MODE=1'`
Expected: 1 pass.

- [ ] **Step 6: Run the full install-script suite to confirm no regression**

Run: `bun test tests/install-script.test.ts`
Expected: all existing + 2 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/install.sh tests/install-script.test.ts
git commit -m "feat(install): render copilot-api-restart unit alongside main"
```

---

## Task 8: install.sh seeds RESTART_TIME and writes/enables/starts the scheduler unit

**Files:**
- Modify: `scripts/install.sh`
- Modify: `tests/install-script.test.ts`

This task wires the side-effect path: `write_unit` writes the scheduler unit too, `ensure_env_file` seeds `RESTART_TIME`, and `enable`/`start` are extended. Because the existing tests only exercise `--render-only` (real `systemctl` is unsafe in CI), we add tests against a fake `systemctl` shim and an env-file-only assertion.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("install.sh", ...)` block in `tests/install-script.test.ts`:

```ts
  test("seeds RESTART_TIME='02:00' into a fresh .env", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    // Fake systemctl so `install.sh` proceeds past require_systemd and the
    // enable/start side effects. Also fake `loginctl` for --user-mode safety.
    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "loginctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    // Point unit_path at a writable temp dir via --user-mode (writes to
    // $HOME/.config/systemd/user/) and HOME override.
    const fakeHome = path.join(fx.releaseDir, "home")
    await $`mkdir -p ${fakeHome}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --user-mode --no-start --user testuser --name copilot-api-test`
        .cwd(fx.releaseDir)
        .env({
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        })
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)

    const envContents = await Bun.file(
      path.join(fx.releaseDir, ".env"),
    ).text()
    expect(envContents).toContain('RESTART_TIME="02:00"')
  })

  test("does not overwrite an existing RESTART_TIME in .env", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    // Pre-seed .env with a custom value.
    await Bun.write(
      path.join(fx.releaseDir, ".env"),
      'COPILOT_API_ARGS=""\nRESTART_TIME="03:30"\n',
    )

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "loginctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const fakeHome = path.join(fx.releaseDir, "home")
    await $`mkdir -p ${fakeHome}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --user-mode --no-start --user testuser`
        .cwd(fx.releaseDir)
        .env({
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        })
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)
    const envContents = await Bun.file(
      path.join(fx.releaseDir, ".env"),
    ).text()
    expect(envContents).toContain('RESTART_TIME="03:30"')
    expect(envContents).not.toContain('RESTART_TIME="02:00"')
  })

  test("writes both unit files in --user-mode", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "loginctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const fakeHome = path.join(fx.releaseDir, "home")
    await $`mkdir -p ${fakeHome}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --user-mode --no-start --user testuser --name copilot-api-test`
        .cwd(fx.releaseDir)
        .env({
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        })
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)

    const mainUnit = path.join(
      fakeHome,
      ".config/systemd/user/copilot-api-test.service",
    )
    const restartUnit = path.join(
      fakeHome,
      ".config/systemd/user/copilot-api-test-restart.service",
    )
    expect(await Bun.file(mainUnit).exists()).toBe(true)
    expect(await Bun.file(restartUnit).exists()).toBe(true)

    const restartContents = await Bun.file(restartUnit).text()
    expect(restartContents).toContain("Environment=USER_MODE=1")
    expect(restartContents).toContain(
      `ExecStart=${fx.releaseDir}/scripts/restart-scheduler.sh`,
    )
  })

  test("calls systemctl enable+start for both units", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    // systemctl that records its argv to a log.
    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    const logPath = path.join(fx.releaseDir, "systemctl-calls.log")
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(logPath)}\nexit 0\n`,
      { mode: 0o755 },
    )
    await Bun.write(
      path.join(fakeBin, "loginctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const fakeHome = path.join(fx.releaseDir, "home")
    await $`mkdir -p ${fakeHome}`.quiet()

    const proc =
      await $`${path.join(fx.scriptsDir, "install.sh")} --user-mode --user testuser --name copilot-api-test`
        .cwd(fx.releaseDir)
        .env({
          ...process.env,
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        })
        .quiet()
        .nothrow()

    expect(proc.exitCode).toBe(0)

    const calls = await Bun.file(logPath).text()
    expect(calls).toContain("enable copilot-api-test")
    expect(calls).toContain("enable copilot-api-test-restart")
    expect(calls).toContain("start copilot-api-test")
    expect(calls).toContain("start copilot-api-test-restart")
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/install-script.test.ts -t 'RESTART_TIME'`
Expected: fail (no seeding logic yet).

Run: `bun test tests/install-script.test.ts -t 'both unit files'`
Expected: fail.

Run: `bun test tests/install-script.test.ts -t 'enable\\+start for both'`
Expected: fail.

- [ ] **Step 3: Add the install logic**

In `scripts/install.sh`:

**(3a)** Add a constant near the top of the side-effect section (right after `require_systemd`):

```bash
RESTART_SERVICE_NAME="${SERVICE_NAME}-restart"
```

**(3b)** Update `unit_path()` to take an optional service-name arg:

```bash
unit_path() {
  local name="${1:-$SERVICE_NAME}"
  if [ "$USER_MODE" -eq 1 ]; then
    echo "$HOME/.config/systemd/user/${name}.service"
  else
    echo "/etc/systemd/system/${name}.service"
  fi
}
```

**(3c)** Update `check_existing_schema()` to take a path arg, then loop over both units:

```bash
check_existing_schema() {
  local target="$1"
  if [ ! -f "$target" ]; then return 0; fi
  local existing
  existing="$(grep -E '^# release-schema=' "$target" | head -n1 | cut -d= -f2)"
  if [ -z "$existing" ]; then
    echo "Notice: existing $target has no release-schema marker; replacing it."
  elif [ "$existing" != "$RELEASE_SCHEMA_VERSION" ]; then
    echo "Notice: existing $target has release-schema=$existing; this release is $RELEASE_SCHEMA_VERSION. Replacing."
  fi
}
```

**(3d)** Extend `ensure_env_file()` to seed `RESTART_TIME` idempotently. Replace the function with:

```bash
ensure_env_file() {
  local example="$RELEASE_DIR/.env.example"
  local target="$RELEASE_DIR/.env"
  if [ ! -f "$target" ]; then
    if [ -f "$example" ]; then
      cp "$example" "$target"
      echo "Created $target from .env.example. Edit it to customize args, then:"
      echo "  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME"
    else
      printf 'COPILOT_API_ARGS=""\n' > "$target"
    fi
  fi
  # Seed RESTART_TIME if absent. grep -q makes this idempotent across re-runs
  # and preserves any operator-set value.
  if ! grep -qE '^RESTART_TIME=' "$target"; then
    printf 'RESTART_TIME="02:00"\n' >> "$target"
  fi
  chmod 600 "$target"
}
```

**(3e)** Replace the existing `write_unit()` with a generalized helper plus calls for both units:

```bash
write_unit() {
  local target="$1"
  local render_fn="$2"
  mkdir -p "$(dirname "$target")"
  "$render_fn" > "$target.tmp"
  mv "$target.tmp" "$target"
  chmod 644 "$target"
  echo "Installed unit at $target"
}
```

**(3f)** Update the bottom orchestration block. Find the existing tail (after `require_systemd`/`check_existing_schema`/`ensure_env_file`/`write_unit`/`enable_linger_if_needed`/`systemctl_cmd daemon-reload`/etc.) and replace it with:

```bash
require_systemd
check_existing_schema "$(unit_path "$SERVICE_NAME")"
check_existing_schema "$(unit_path "$RESTART_SERVICE_NAME")"
ensure_env_file
write_unit "$(unit_path "$SERVICE_NAME")" render_main_unit
write_unit "$(unit_path "$RESTART_SERVICE_NAME")" render_restart_unit
enable_linger_if_needed

systemctl_cmd daemon-reload
if [ "$NO_START" -eq 1 ]; then
  systemctl_cmd enable "$SERVICE_NAME"
  systemctl_cmd enable "$RESTART_SERVICE_NAME"
  echo "Enabled $SERVICE_NAME and $RESTART_SERVICE_NAME (not started; --no-start was passed)."
else
  systemctl_cmd enable "$SERVICE_NAME"
  systemctl_cmd enable "$RESTART_SERVICE_NAME"
  systemctl_cmd try-restart "$SERVICE_NAME" || true
  systemctl_cmd try-restart "$RESTART_SERVICE_NAME" || true
  systemctl_cmd start "$SERVICE_NAME"
  systemctl_cmd start "$RESTART_SERVICE_NAME"
  echo "Enabled and started $SERVICE_NAME and $RESTART_SERVICE_NAME."
fi

cat <<EOF

Useful commands:
  systemctl status $SERVICE_NAME
  systemctl status $RESTART_SERVICE_NAME
  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f
  journalctl -u $RESTART_SERVICE_NAME -f
  ls -lt $RELEASE_DIR/crashes/ | head

Scheduled restart:
  Configure RESTART_TIME in $RELEASE_DIR/.env (HH:MM 24h local, or "off").
  After changing it, apply with:
    $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $RESTART_SERVICE_NAME
EOF
```

- [ ] **Step 4: Run the failing tests to verify they now pass**

Run: `bun test tests/install-script.test.ts`
Expected: all (existing + 4 new) pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh tests/install-script.test.ts
git commit -m "feat(install): seed RESTART_TIME and enable scheduler unit"
```

---

## Task 9: Update uninstall.sh to remove the scheduler unit

**Files:**
- Modify: `scripts/uninstall.sh`
- Create: `tests/uninstall-script.test.ts`

There is no existing uninstall test. Adding one is cheap and covers the new behavior.

- [ ] **Step 1: Write the failing test**

Path: `tests/uninstall-script.test.ts`

```ts
import { $ } from "bun"
import { describe, test, expect, afterEach } from "bun:test"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  const fn = cleanup
  cleanup = null
  if (fn !== null) await fn()
})

describe("uninstall.sh", () => {
  test("removes both main and restart units and reset-failed both", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "uninstall.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    const logPath = path.join(fx.releaseDir, "systemctl-calls.log")
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(logPath)}\nexit 0\n`,
      { mode: 0o755 },
    )

    // Pre-create both unit files in a fake user-mode HOME so unit_path
    // resolves to writable locations.
    const fakeHome = path.join(fx.releaseDir, "home")
    const userUnitDir = path.join(fakeHome, ".config/systemd/user")
    await $`mkdir -p ${userUnitDir}`.quiet()
    const mainUnit = path.join(userUnitDir, "copilot-api.service")
    const restartUnit = path.join(userUnitDir, "copilot-api-restart.service")
    await Bun.write(mainUnit, "# release-schema=1\n[Service]\n")
    await Bun.write(restartUnit, "# release-schema=1\n[Service]\n")

    const proc = await $`${path.join(fx.scriptsDir, "uninstall.sh")} --user-mode`
      .env({
        ...process.env,
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(await Bun.file(mainUnit).exists()).toBe(false)
    expect(await Bun.file(restartUnit).exists()).toBe(false)

    const calls = await Bun.file(logPath).text()
    expect(calls).toContain("disable --now copilot-api")
    expect(calls).toContain("disable --now copilot-api-restart")
    expect(calls).toContain("daemon-reload")
    expect(calls).toContain("reset-failed copilot-api")
    expect(calls).toContain("reset-failed copilot-api-restart")
  })

  test("succeeds even when scheduler unit was never installed", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "uninstall.sh")}`.quiet()

    const fakeBin = path.join(fx.releaseDir, "fakebin")
    await $`mkdir -p ${fakeBin}`.quiet()
    await Bun.write(
      path.join(fakeBin, "systemctl"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    )

    const fakeHome = path.join(fx.releaseDir, "home")
    const userUnitDir = path.join(fakeHome, ".config/systemd/user")
    await $`mkdir -p ${userUnitDir}`.quiet()
    // Only the main unit exists.
    await Bun.write(
      path.join(userUnitDir, "copilot-api.service"),
      "# release-schema=1\n[Service]\n",
    )

    const proc = await $`${path.join(fx.scriptsDir, "uninstall.sh")} --user-mode`
      .env({
        ...process.env,
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test tests/uninstall-script.test.ts`
Expected: fail (uninstall.sh only knows about the main unit).

- [ ] **Step 3: Update uninstall.sh**

Replace `scripts/uninstall.sh` entirely with:

```bash
#!/bin/bash
set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: uninstall.sh [OPTIONS]

Remove the copilot-api systemd units (main + scheduled-restart). Does NOT
touch release/, .env, logs, crashes/, or persisted tokens under
~/.local/share/copilot-api/.

Options:
  --name <service>   systemd unit name (default: copilot-api)
  --user-mode        Operate on ~/.config/systemd/user/ instead of system-wide
  -h, --help         Show this help
EOF
}

SERVICE_NAME="copilot-api"
USER_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name)      SERVICE_NAME="$2"; shift 2 ;;
    --user-mode) USER_MODE=1; shift ;;
    -h|--help)   print_help; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_help >&2; exit 2 ;;
  esac
done

RESTART_SERVICE_NAME="${SERVICE_NAME}-restart"

systemctl_cmd() {
  if [ "$USER_MODE" -eq 1 ]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

unit_path() {
  local name="${1:-$SERVICE_NAME}"
  if [ "$USER_MODE" -eq 1 ]; then
    echo "$HOME/.config/systemd/user/${name}.service"
  else
    echo "/etc/systemd/system/${name}.service"
  fi
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found. Nothing to uninstall." >&2
  exit 1
fi

MAIN_TARGET="$(unit_path "$SERVICE_NAME")"
RESTART_TARGET="$(unit_path "$RESTART_SERVICE_NAME")"

if [ ! -f "$MAIN_TARGET" ] && [ ! -f "$RESTART_TARGET" ]; then
  echo "No copilot-api units found; nothing to do."
  exit 0
fi

# Stop scheduler first so it can't fire mid-uninstall.
if [ -f "$RESTART_TARGET" ]; then
  systemctl_cmd disable --now "$RESTART_SERVICE_NAME" 2>/dev/null || true
  rm -f "$RESTART_TARGET"
  echo "Removed $RESTART_TARGET."
fi

if [ -f "$MAIN_TARGET" ]; then
  systemctl_cmd disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$MAIN_TARGET"
  echo "Removed $MAIN_TARGET."
fi

systemctl_cmd daemon-reload
systemctl_cmd reset-failed "$SERVICE_NAME" 2>/dev/null || true
systemctl_cmd reset-failed "$RESTART_SERVICE_NAME" 2>/dev/null || true

echo "Preserved (not touched): release/, release/.env, release/copilot-api.log, release/crashes/, ~/.local/share/copilot-api/"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/uninstall-script.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/uninstall.sh tests/uninstall-script.test.ts
git commit -m "feat(uninstall): remove scheduler unit and reset-failed both"
```

---

## Task 10: Document RESTART_TIME in .env.example

**Files:**
- Modify: `scripts/.env.example`

- [ ] **Step 1: Append the documentation block**

Edit `scripts/.env.example` — add at the bottom:

```sh

# Daily restart of the copilot-api service (handled by copilot-api-restart.service).
# Format: HH:MM in 24-hour local time. Set to "off" to disable scheduled restarts.
# After changing this value, apply with:
#   systemctl restart copilot-api-restart   (or: systemctl --user restart copilot-api-restart)
RESTART_TIME="02:00"
```

- [ ] **Step 2: Verify**

Run: `tail -5 scripts/.env.example`
Expected: shows the RESTART_TIME line.

- [ ] **Step 3: Commit**

```bash
git add scripts/.env.example
git commit -m "docs(env): document RESTART_TIME for scheduled daily restart"
```

---

## Task 11: Full regression + shellcheck pass

**Files:**
- None (verification only).

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass (no regressions in unrelated suites).

- [ ] **Step 2: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: both succeed.

- [ ] **Step 3: Run shellcheck on all shell scripts**

Run: `shellcheck scripts/*.sh`
Expected: no errors. (If `shellcheck` is not installed: `brew install shellcheck`.)

- [ ] **Step 4: Manual --render-only smoke test**

Run: `bash scripts/install.sh --render-only --user $USER --name copilot-api-test`
Expected: outputs two unit files separated by `# ---`, all placeholders substituted. Visually confirm:
- Main unit has `ExecStart=/bin/sh -c '.../bin/copilot-api start $COPILOT_API_ARGS'`.
- Scheduler unit has `ExecStart=.../scripts/restart-scheduler.sh`, `Environment=USER_MODE=0`, `Restart=always`.

- [ ] **Step 5: No commit needed**

This task is verification only.

---

## Task 12: Linux deployment verification (manual, on Linux box)

**Files:**
- None (operational verification).

This runs on the actual Linux deploy host after the next release. Do not skip.

- [ ] **Step 1: Re-install from release tarball**

```bash
cd release && sudo ./scripts/install.sh
```

Verify: both `copilot-api` and `copilot-api-restart` units installed and active.

```bash
systemctl status copilot-api copilot-api-restart
```

- [ ] **Step 2: Confirm scheduler logs the next firing**

```bash
journalctl -u copilot-api-restart --since '1 min ago'
```

Expected: a line like `scheduled next restart at 02:00 (in NNNNNs)`.

- [ ] **Step 3: Trigger a short-fuse restart**

```bash
# Set to 2 minutes from now (Linux GNU date).
NEW_TIME="$(date -d '+2 minutes' +%H:%M)"
sudo sed -i "s/^RESTART_TIME=.*/RESTART_TIME=\"$NEW_TIME\"/" /path/to/release/.env
sudo systemctl restart copilot-api-restart
```

Wait ~3 minutes, then:

```bash
journalctl -u copilot-api --since '3 min ago'
```

Expected: a `Stopped` + `Started` pair within the 3-minute window.

- [ ] **Step 4: Restore default and disable test**

```bash
sudo sed -i 's/^RESTART_TIME=.*/RESTART_TIME="02:00"/' /path/to/release/.env
sudo systemctl restart copilot-api-restart
```

- [ ] **Step 5: Test disable**

```bash
sudo sed -i 's/^RESTART_TIME=.*/RESTART_TIME="off"/' /path/to/release/.env
sudo systemctl restart copilot-api-restart
sleep 60
systemctl status copilot-api-restart
```

Expected: `active (running)`, no restart of main service. Restore `02:00` after.

- [ ] **Step 6: Test invalid value**

```bash
sudo sed -i 's/^RESTART_TIME=.*/RESTART_TIME="99:99"/' /path/to/release/.env
sudo systemctl restart copilot-api-restart
sleep 15
journalctl -u copilot-api-restart --since '20 sec ago'
```

Expected: repeated `invalid RESTART_TIME` errors every ~5 seconds (RestartSec=5s). Restore `02:00` after.

- [ ] **Step 7: Verify uninstall**

```bash
sudo ./scripts/uninstall.sh
systemctl status copilot-api copilot-api-restart 2>&1 | grep -i "could not be found\|not-found"
```

Expected: both units reported as not-found. Re-run `install.sh` to restore.
