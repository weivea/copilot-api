# Process Keepalive & Crash Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained systemd-based supervisor inside the release tarball so that the bun-compiled binary auto-restarts on crash and every abnormal exit produces a structured report on disk.

**Architecture:** Add three shell scripts (`install.sh`, `uninstall.sh`, `crash-handler.sh`) and one systemd unit template (`copilot-api.service.template`) to the release artifact. `install.sh` renders the template into `/etc/systemd/system/copilot-api.service` (or `~/.config/systemd/user/...` for `--user-mode`), enables the unit, and starts it. systemd's `Restart=on-failure` provides keepalive; `ExecStopPost=crash-handler.sh` writes a self-contained report to `<release>/crashes/<UTC>.txt` on every abnormal exit. `start.sh / stop.sh / restart.sh` get a thin shim at the top: when `/etc/systemd/system/copilot-api.service` exists, they `exec systemctl <verb> copilot-api`. Application source under `src/` is not touched.

**Tech Stack:** bash 3.2+ compatible shell, systemd unit syntax (Linux only), Bun test runner with `Bun.$` for shell-script integration tests, existing tsdown packaging via `scripts/package.ts`.

**Spec:** `docs/superpowers/specs/2026-05-12-process-keepalive-design.md`

---

## File Structure

**New files** (each has one clear responsibility):

| Path | Responsibility |
|---|---|
| `scripts/install.sh` | Render systemd unit template, install it, `enable --now`. Idempotent. |
| `scripts/uninstall.sh` | Disable + stop + remove the unit. Leaves `release/`, `.env`, `crashes/` alone. |
| `scripts/crash-handler.sh` | systemd `ExecStopPost`. Writes `crashes/<UTC>.txt` on abnormal exits, rotates to 50. |
| `scripts/systemd/copilot-api.service.template` | systemd unit template with `__USER__`, `__RELEASE_DIR__`, `__SERVICE_NAME__` placeholders. |
| `scripts/.env.example` | Sample `.env` shipped in release, documents `COPILOT_API_ARGS`, `PORT`. |
| `tests/install-script.test.ts` | Bun tests covering `install.sh` flag parsing & template rendering. |
| `tests/crash-handler-script.test.ts` | Bun tests covering `crash-handler.sh` exit-result matrix and rotation. |
| `tests/helpers/shell-fixtures.ts` | Helpers to spawn scripts in temp dirs with controlled env. |

**Modified files:**

| Path | Change |
|---|---|
| `scripts/start.sh` | Prepend systemd-detection shim at top. |
| `scripts/stop.sh` | Same shim. |
| `scripts/restart.sh` | Same shim. |
| `scripts/package.ts` | Add new scripts/template/example to the release copy list. |
| `.gitignore` | Add `crashes/`, `release/.env`, `release/`. |
| `README.md` | Add "Production deployment with systemd (Linux)" section. |

**Decomposition rationale:** Scripts are split by responsibility (install / uninstall / crash) rather than bundled into one big `service.sh`, so each is small enough to reason about end-to-end and test in isolation. The `.template` file is a separate artifact (not heredoc'd in `install.sh`) so we can diff it against fixtures cleanly.

**Bash compatibility constraint:** All shell code must run under bash 3.2 (macOS default) so devs can run unit tests locally. No associative arrays, no `${var,,}`, no `mapfile`. We use `sed` for template substitution instead of `envsubst` (which isn't installed by default on macOS).

---

## Task 1: Add gitignore entries for runtime artifacts

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add ignore patterns**

Open `.gitignore` and append after the existing `copilot-api.log` line:

```gitignore
# systemd keepalive runtime artifacts
crashes/
release/
release/.env
```

`release/` is already a build output (created by `scripts/package.ts`); listing it makes intent explicit. `crashes/` and `release/.env` are runtime-only and must never be committed.

- [ ] **Step 2: Verify**

Run: `git check-ignore -v release/.env release/crashes/anything.txt`
Expected: both paths report ignore matches; non-zero exit code only if you didn't add them correctly.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore systemd keepalive runtime artifacts (crashes/, release/.env)"
```

---

## Task 2: Create the systemd unit template

**Files:**
- Create: `scripts/systemd/copilot-api.service.template`

- [ ] **Step 1: Create the directory and template file**

```bash
mkdir -p scripts/systemd
```

Create `scripts/systemd/copilot-api.service.template` with this exact content:

```ini
# release-schema=1
[Unit]
Description=Copilot API (GitHub Copilot -> OpenAI/Anthropic proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__USER__
WorkingDirectory=__RELEASE_DIR__
EnvironmentFile=__RELEASE_DIR__/.env
ExecStart=/bin/sh -c '__RELEASE_DIR__/bin/copilot-api start $COPILOT_API_ARGS'
ExecStopPost=__RELEASE_DIR__/scripts/crash-handler.sh

# Keepalive: restart on abnormal exit (signal, non-zero code, OOM, etc.)
# but not on a clean systemctl stop. 5s pause avoids tight crash-loops.
# StartLimitBurst=0 disables systemd's built-in throttle (default would
# fail-stop after 5 restarts in 10s, which is too aggressive here).
Restart=on-failure
RestartSec=5s
StartLimitBurst=0
StartLimitIntervalSec=0

# Logging: append to release/copilot-api.log AND journald simultaneously.
StandardOutput=append:__RELEASE_DIR__/copilot-api.log
StandardError=append:__RELEASE_DIR__/copilot-api.log
SyslogIdentifier=__SERVICE_NAME__

# Make SERVICE_NAME visible to ExecStopPost (systemd does not inject it).
Environment=SERVICE_NAME=__SERVICE_NAME__

# Resource & basic hardening.
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

Notes on the template:
- Placeholders use `__VAR__` (double-underscore) to avoid clashing with shell `$VAR` syntax that systemd itself expands at runtime (for `$COPILOT_API_ARGS`).
- `ExecStart` wraps the binary in `/bin/sh -c '…'` so systemd's environment expansion of `$COPILOT_API_ARGS` actually word-splits — `ExecStart=` directly does not perform shell-style splitting on a single variable.
- `Restart=on-failure` means: signal kill, non-zero exit, watchdog, or OOM trigger restart; clean `systemctl stop` does not.
- `release-schema=1` is the version marker `install.sh` greps for.

- [ ] **Step 2: Commit**

```bash
git add scripts/systemd/copilot-api.service.template
git commit -m "feat(deploy): add systemd unit template with on-failure restart"
```

---

## Task 3: Write failing test for crash-handler skipping clean exits

**Files:**
- Create: `tests/helpers/shell-fixtures.ts`
- Create: `tests/crash-handler-script.test.ts`

- [ ] **Step 1: Create shell-fixtures helper**

Create `tests/helpers/shell-fixtures.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..", "..")

/**
 * Build a temp `release/` skeleton mirroring what the packaged tarball
 * looks like, so `crash-handler.sh` and `install.sh` can run against it
 * without touching the real repo.
 */
export async function makeReleaseFixture(): Promise<{
  releaseDir: string
  scriptsDir: string
  cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(path.join(tmpdir(), "copilot-api-fixture-"))
  const releaseDir = path.join(base, "release")
  const scriptsDir = path.join(releaseDir, "scripts")
  await mkdir(scriptsDir, { recursive: true })
  await mkdir(path.join(releaseDir, "bin"), { recursive: true })

  // Copy the real shell scripts so tests run against the actual code.
  for (const name of [
    "crash-handler.sh",
    "install.sh",
    "uninstall.sh",
  ]) {
    const src = path.join(ROOT, "scripts", name)
    const dst = path.join(scriptsDir, name)
    try {
      await cp(src, dst)
    } catch {
      // Some tests may run before all scripts exist; ignore missing.
    }
  }
  // Stub binary so install.sh's existence checks pass.
  await writeFile(path.join(releaseDir, "bin", "copilot-api"), "#!/bin/sh\n", {
    mode: 0o755,
  })
  return {
    releaseDir,
    scriptsDir,
    cleanup: async () => {
      const { rm } = await import("node:fs/promises")
      await rm(base, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 2: Write the first failing test**

Create `tests/crash-handler-script.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { readdir } from "node:fs/promises"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  if (cleanup) await cleanup()
  cleanup = undefined
})

describe("crash-handler.sh", () => {
  test("exits 0 and writes nothing when SERVICE_RESULT=success", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "success",
        EXIT_CODE: "exited",
        EXIT_STATUS: "0",
        MAINPID: "12345",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)

    // crashes/ should not exist or should be empty.
    let entries: string[] = []
    try {
      entries = await readdir(path.join(fx.releaseDir, "crashes"))
    } catch {
      /* dir absent is fine */
    }
    expect(entries).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/crash-handler-script.test.ts`
Expected: FAIL — script does not exist yet (ENOENT) or exits non-zero. The exact error doesn't matter, just that it doesn't pass.

- [ ] **Step 4: Commit (failing test)**

```bash
git add tests/helpers/shell-fixtures.ts tests/crash-handler-script.test.ts
git commit -m "test(deploy): add failing test for crash-handler clean-exit skip"
```

---

## Task 4: Implement crash-handler.sh — clean-exit fast path

**Files:**
- Create: `scripts/crash-handler.sh`

- [ ] **Step 1: Write the minimal script**

Create `scripts/crash-handler.sh`:

```bash
#!/bin/bash
set -u

# systemd ExecStopPost runs after every process exit and injects:
#   $SERVICE_RESULT  - "success" / "exit-code" / "signal" / "core-dump" / ...
#   $EXIT_CODE       - "exited" / "killed" / "dumped"
#   $EXIT_STATUS     - numeric exit code or signal number
#   $MAINPID         - the PID that just exited
# We must NOT log clean exits — those are operator-initiated stop/restart.

if [ "${SERVICE_RESULT:-}" = "success" ]; then
  exit 0
fi

# (Crash-report writing is added in Task 6.)
exit 0
```

- [ ] **Step 2: Make it executable and re-run the test**

```bash
chmod +x scripts/crash-handler.sh
bun test tests/crash-handler-script.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/crash-handler.sh
git commit -m "feat(deploy): crash-handler skips clean systemd exits"
```

---

## Task 5: Add failing test for crash-handler writing a report

**Files:**
- Modify: `tests/crash-handler-script.test.ts`

- [ ] **Step 1: Append the new test**

Add this test inside the existing `describe("crash-handler.sh", …)` block:

```typescript
  test("writes report file when SERVICE_RESULT=signal (kill -9)", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    // Pre-seed the application log so the handler has something to tail.
    await Bun.write(
      path.join(fx.releaseDir, "copilot-api.log"),
      "line1\nline2\nfatal: out of memory\n",
    )

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "signal",
        EXIT_CODE: "killed",
        EXIT_STATUS: "9",
        MAINPID: "98765",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)

    const entries = await readdir(path.join(fx.releaseDir, "crashes"))
    expect(entries.length).toBe(1)

    const reportPath = path.join(fx.releaseDir, "crashes", entries[0])
    const report = await Bun.file(reportPath).text()
    expect(report).toContain("=== Copilot API crash report ===")
    expect(report).toContain("service_result: signal")
    expect(report).toContain("exit_status:    9")
    expect(report).toContain("main_pid:       98765")
    expect(report).toContain("=== Last 200 lines from copilot-api.log ===")
    expect(report).toContain("fatal: out of memory")
    // The journalctl section is best-effort (the binary may not exist on dev
    // machines), so we only assert the section header.
    expect(report).toContain("=== Last 200 lines from journald ===")
    expect(report).toContain("=== System snapshot ===")

    // Filename should be a UTC timestamp like 20260512T034512Z.txt
    expect(entries[0]).toMatch(/^\d{8}T\d{6}Z\.txt$/)
  })
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/crash-handler-script.test.ts`
Expected: 1 PASS (clean-exit), 1 FAIL (report-writing) — handler currently exits without writing anything.

- [ ] **Step 3: Commit (failing test)**

```bash
git add tests/crash-handler-script.test.ts
git commit -m "test(deploy): add failing test for crash-handler report writing"
```

---

## Task 6: Implement crash-handler.sh — write report on abnormal exit

**Files:**
- Modify: `scripts/crash-handler.sh`

- [ ] **Step 1: Replace the whole script with the full implementation**

Overwrite `scripts/crash-handler.sh` with:

```bash
#!/bin/bash
set -u

# systemd ExecStopPost runs after every process exit and injects:
#   $SERVICE_RESULT  - "success" / "exit-code" / "signal" / "core-dump" / ...
#   $EXIT_CODE       - "exited" / "killed" / "dumped"
#   $EXIT_STATUS     - numeric exit code or signal number
#   $MAINPID         - the PID that just exited
# We must NOT log clean exits — those are operator-initiated stop/restart.

if [ "${SERVICE_RESULT:-}" = "success" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(dirname "$SCRIPT_DIR")"
CRASH_DIR="$RELEASE_DIR/crashes"
SERVICE_NAME="${SERVICE_NAME:-copilot-api}"

mkdir -p "$CRASH_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$CRASH_DIR/${TS}.txt"

{
  echo "=== Copilot API crash report ==="
  echo "timestamp_utc:  $TS"
  printf 'service_result: %s\n' "${SERVICE_RESULT:-unknown}"
  printf 'exit_code:      %s\n' "${EXIT_CODE:-unknown}"
  printf 'exit_status:    %s\n' "${EXIT_STATUS:-unknown}"
  printf 'main_pid:       %s\n' "${MAINPID:-unknown}"
  echo
  echo "=== Last 200 lines from journald ==="
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$SERVICE_NAME" -n 200 --no-pager 2>&1 || true
  else
    echo "(journalctl not available on this host)"
  fi
  echo
  echo "=== Last 200 lines from copilot-api.log ==="
  tail -n 200 "$RELEASE_DIR/copilot-api.log" 2>/dev/null || true
  echo
  echo "=== System snapshot ==="
  uptime 2>/dev/null || true
  free -h 2>/dev/null || true
  df -h "$RELEASE_DIR" 2>/dev/null || true
} > "$FILE" 2>&1

# Rotate: keep newest 50 reports. (`ls -t` is bash-3.2 portable.)
# shellcheck disable=SC2012
ls -1t "$CRASH_DIR"/*.txt 2>/dev/null | tail -n +51 | while IFS= read -r old; do
  rm -f -- "$old"
done

exit 0
```

Notes:
- `printf` aligns columns reliably across bash versions.
- `command -v journalctl` keeps the script portable to dev machines for tests; on the production server the command exists.
- The rotation `while read` loop avoids `xargs -r`, which is GNU-only (macOS `xargs` lacks `-r`).

- [ ] **Step 2: Run both tests, expect pass**

Run: `bun test tests/crash-handler-script.test.ts`
Expected: 2 PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/crash-handler.sh
git commit -m "feat(deploy): crash-handler writes structured report on abnormal exit"
```

---

## Task 7: Add failing test for crash-handler rotation (keep newest 50)

**Files:**
- Modify: `tests/crash-handler-script.test.ts`

- [ ] **Step 1: Add the rotation test**

Inside the same `describe` block, append:

```typescript
  test("rotation keeps newest 50 reports", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await $`chmod +x ${path.join(fx.scriptsDir, "crash-handler.sh")}`.quiet()

    const crashDir = path.join(fx.releaseDir, "crashes")
    await $`mkdir -p ${crashDir}`.quiet()

    // Pre-seed 60 fake reports with monotonically increasing mtimes by
    // touching each one with a distinct date in 2020-01-01 .. 2020-03-01 range.
    for (let i = 0; i < 60; i++) {
      const ts = `2020010${(i % 10) + 1}T00${String(i).padStart(2, "0")}00Z`
      const fp = path.join(crashDir, `${ts}.txt`)
      await Bun.write(fp, `seed ${i}`)
      // Stagger mtime so `ls -t` ordering is deterministic.
      const epoch = 1577836800 + i * 60 // 2020-01-01T00:00:00Z + i minutes
      await $`touch -t ${formatTouch(epoch)} ${fp}`.quiet()
    }

    const proc = await $`${path.join(fx.scriptsDir, "crash-handler.sh")}`
      .env({
        ...process.env,
        SERVICE_RESULT: "signal",
        EXIT_STATUS: "9",
        SERVICE_NAME: "copilot-api",
      })
      .quiet()
      .nothrow()
    expect(proc.exitCode).toBe(0)

    const entries = await readdir(crashDir)
    // Started with 60 seeded files. The handler wrote 1 new file (61 total),
    // then `tail -n +51` removed the 11 oldest (60 + 1 - 50 = 11), leaving 50.
    expect(entries.length).toBe(50)
  })
})

// Helper: format a unix epoch (seconds) as `YYYYMMDDhhmm.ss` for `touch -t`.
function formatTouch(epoch: number): string {
  const d = new Date(epoch * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.${pad(d.getUTCSeconds())}`
  )
}
```

- [ ] **Step 2: Run the new test**

Run: `bun test tests/crash-handler-script.test.ts`
Expected: existing 2 tests PASS, new rotation test should already PASS because Task 6's implementation includes the rotation. If it fails, debug the rotation loop in `crash-handler.sh`.

- [ ] **Step 3: Commit**

```bash
git add tests/crash-handler-script.test.ts
git commit -m "test(deploy): assert crash-handler rotation keeps newest 50"
```

---

## Task 8: Add .env.example for release tarball

**Files:**
- Create: `scripts/.env.example`

- [ ] **Step 1: Create the file**

Create `scripts/.env.example`:

```bash
# copilot-api environment file, loaded by systemd via EnvironmentFile=.
# Copy this to `.env` in the same directory as install.sh:
#   cp .env.example .env

# Optional CLI flags appended to `copilot-api start`. The systemd unit
# performs shell word-splitting on this variable inside ExecStart.
# Example:
#   COPILOT_API_ARGS="--port 4141 --account-type business --rate-limit 30"
COPILOT_API_ARGS=""

# Anything the binary itself reads from the environment. Uncomment as needed.
# PORT=4141
# NODE_ENV=production
```

Note: this lives under `scripts/` in the repo so the build step in Task 14 can find it at a stable path. `scripts/package.ts` will copy it to `release/.env.example` (release root, not `release/scripts/`) so users see it immediately after extracting the tarball.

- [ ] **Step 2: Commit**

```bash
git add scripts/.env.example
git commit -m "feat(deploy): add .env.example for systemd EnvironmentFile"
```

---

## Task 9: Write failing test for install.sh template rendering

**Files:**
- Create: `tests/install-script.test.ts`

- [ ] **Step 1: Create the test file**

Create `tests/install-script.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdir, cp } from "node:fs/promises"
import path from "node:path"

import { makeReleaseFixture } from "./helpers/shell-fixtures"

const ROOT = path.resolve(import.meta.dir, "..")

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  if (cleanup) await cleanup()
  cleanup = undefined
})

async function seedSystemdTemplate(releaseDir: string) {
  const dst = path.join(releaseDir, "scripts", "systemd")
  await mkdir(dst, { recursive: true })
  await cp(
    path.join(ROOT, "scripts", "systemd", "copilot-api.service.template"),
    path.join(dst, "copilot-api.service.template"),
  )
}

describe("install.sh", () => {
  test("--render-only prints unit with placeholders substituted", async () => {
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

    expect(out).toContain("# release-schema=1")
    expect(out).toContain("User=testuser")
    expect(out).toContain(`WorkingDirectory=${fx.releaseDir}`)
    expect(out).toContain(`EnvironmentFile=${fx.releaseDir}/.env`)
    expect(out).toContain(
      `ExecStart=/bin/sh -c '${fx.releaseDir}/bin/copilot-api start $COPILOT_API_ARGS'`,
    )
    expect(out).toContain(
      `ExecStopPost=${fx.releaseDir}/scripts/crash-handler.sh`,
    )
    expect(out).toContain("SyslogIdentifier=copilot-api-test")
    expect(out).toContain("Environment=SERVICE_NAME=copilot-api-test")
    expect(out).toContain("Restart=on-failure")
    expect(out).toContain("RestartSec=5s")
    expect(out).toContain("StartLimitBurst=0")

    // No unrendered placeholders left.
    expect(out).not.toContain("__USER__")
    expect(out).not.toContain("__RELEASE_DIR__")
    expect(out).not.toContain("__SERVICE_NAME__")
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/install-script.test.ts`
Expected: FAIL — `install.sh` doesn't exist yet (ENOENT).

- [ ] **Step 3: Commit (failing test)**

```bash
git add tests/install-script.test.ts
git commit -m "test(deploy): failing test for install.sh template rendering"
```

---

## Task 10: Implement install.sh — render-only mode

**Files:**
- Create: `scripts/install.sh`

We build install.sh in two passes. This task only implements `--render-only` (pure function: read template + flags → print rendered unit to stdout). Task 12 adds the system-mutating side effects.

- [ ] **Step 1: Write install.sh skeleton with --render-only**

Create `scripts/install.sh`:

```bash
#!/bin/bash
set -euo pipefail

RELEASE_SCHEMA_VERSION=1

print_help() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Install the copilot-api systemd unit. Run from inside the release/ directory.

Options:
  --user <name>          Run service as this user (default: $SUDO_USER, else $USER)
  --name <service>       systemd unit name (default: copilot-api)
  --user-mode            Install to ~/.config/systemd/user/ instead of system-wide
  --no-start             Enable the unit but do not start it now
  --render-only          Print the rendered unit to stdout and exit (no side effects)
  -h, --help             Show this help

After install:
  systemctl status <name>
  journalctl -u <name> -f
  ls release/crashes/
EOF
}

# --- Flag parsing -----------------------------------------------------------
USER_NAME="${SUDO_USER:-$USER}"
SERVICE_NAME="copilot-api"
USER_MODE=0
NO_START=0
RENDER_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user)        USER_NAME="$2"; shift 2 ;;
    --name)        SERVICE_NAME="$2"; shift 2 ;;
    --user-mode)   USER_MODE=1; shift ;;
    --no-start)    NO_START=1; shift ;;
    --render-only) RENDER_ONLY=1; shift ;;
    -h|--help)     print_help; exit 0 ;;
    *) echo "Unknown option: $1" >&2; print_help >&2; exit 2 ;;
  esac
done

# --- Resolve paths ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE="$SCRIPT_DIR/systemd/copilot-api.service.template"

if [ ! -f "$TEMPLATE" ]; then
  echo "Error: template not found at $TEMPLATE" >&2
  exit 1
fi

# --- Render unit (pure function: template + vars -> stdout) -----------------
render_unit() {
  # Use sed (POSIX, no envsubst dep). The | delimiter avoids escaping /.
  sed \
    -e "s|__USER__|${USER_NAME}|g" \
    -e "s|__RELEASE_DIR__|${RELEASE_DIR}|g" \
    -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
    "$TEMPLATE"
}

if [ "$RENDER_ONLY" -eq 1 ]; then
  render_unit
  exit 0
fi

# --- Side-effecting install (implemented in Task 12) -----------------------
echo "Error: full install not yet implemented (use --render-only for now)" >&2
exit 1
```

- [ ] **Step 2: Run the test, expect pass**

```bash
chmod +x scripts/install.sh
bun test tests/install-script.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(deploy): install.sh --render-only renders systemd unit from template"
```

---

## Task 11: Add failing test for install.sh flag defaults & errors

**Files:**
- Modify: `tests/install-script.test.ts`

- [ ] **Step 1: Append tests**

Inside the `describe("install.sh", …)` block, append:

```typescript
  test("--user defaults to $USER when SUDO_USER is unset", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const env = { ...process.env, USER: "alice" }
    delete (env as Record<string, string | undefined>).SUDO_USER

    const proc = await $`${path.join(fx.scriptsDir, "install.sh")} --render-only`
      .cwd(fx.releaseDir)
      .env(env)
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("User=alice")
  })

  test("--user prefers SUDO_USER over USER", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "install.sh")} --render-only`
      .cwd(fx.releaseDir)
      .env({ ...process.env, USER: "root", SUDO_USER: "deployer" })
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("User=deployer")
  })

  test("--name defaults to copilot-api", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "install.sh")} --render-only --user x`
      .cwd(fx.releaseDir)
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(0)
    const out = proc.stdout.toString()
    expect(out).toContain("SyslogIdentifier=copilot-api")
    expect(out).toContain("Environment=SERVICE_NAME=copilot-api")
  })

  test("unknown flag prints usage and exits 2", async () => {
    const fx = await makeReleaseFixture()
    cleanup = fx.cleanup
    await seedSystemdTemplate(fx.releaseDir)
    await $`chmod +x ${path.join(fx.scriptsDir, "install.sh")}`.quiet()

    const proc = await $`${path.join(fx.scriptsDir, "install.sh")} --bogus`
      .cwd(fx.releaseDir)
      .quiet()
      .nothrow()

    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString()).toContain("Unknown option: --bogus")
    expect(proc.stderr.toString()).toContain("Usage: install.sh")
  })
})
```

- [ ] **Step 2: Run**

Run: `bun test tests/install-script.test.ts`
Expected: all four new tests PASS (they exercise the flag parsing already implemented in Task 10).

- [ ] **Step 3: Commit**

```bash
git add tests/install-script.test.ts
git commit -m "test(deploy): cover install.sh flag defaults and error path"
```

---

## Task 12: Implement install.sh side effects (write unit, daemon-reload, enable, start)

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Replace the side-effect placeholder with the real implementation**

Open `scripts/install.sh` and replace the block:

```bash
# --- Side-effecting install (implemented in Task 12) -----------------------
echo "Error: full install not yet implemented (use --render-only for now)" >&2
exit 1
```

with:

```bash
# --- Side-effecting install ------------------------------------------------

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Error: systemctl not found. This installer requires systemd." >&2
    echo "On non-systemd hosts, use scripts/start.sh directly." >&2
    exit 1
  fi
}

unit_path() {
  if [ "$USER_MODE" -eq 1 ]; then
    echo "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  else
    echo "/etc/systemd/system/${SERVICE_NAME}.service"
  fi
}

systemctl_cmd() {
  if [ "$USER_MODE" -eq 1 ]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

ensure_env_file() {
  local example="$RELEASE_DIR/.env.example"
  local target="$RELEASE_DIR/.env"
  if [ ! -f "$target" ]; then
    if [ -f "$example" ]; then
      cp "$example" "$target"
      echo "Created $target from .env.example. Edit it to customize args, then:"
      echo "  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME"
    else
      # No example available; create a minimal placeholder so EnvironmentFile= works.
      printf 'COPILOT_API_ARGS=""\n' > "$target"
    fi
  fi
  chmod 600 "$target"
}

check_existing_schema() {
  local target
  target="$(unit_path)"
  if [ ! -f "$target" ]; then return 0; fi
  local existing
  existing="$(grep -E '^# release-schema=' "$target" | head -n1 | cut -d= -f2)"
  if [ -z "$existing" ]; then
    echo "Notice: existing $target has no release-schema marker; replacing it."
  elif [ "$existing" != "$RELEASE_SCHEMA_VERSION" ]; then
    echo "Notice: existing $target has release-schema=$existing; this release is $RELEASE_SCHEMA_VERSION. Replacing."
  fi
}

write_unit() {
  local target
  target="$(unit_path)"
  mkdir -p "$(dirname "$target")"
  render_unit > "$target.tmp"
  mv "$target.tmp" "$target"
  chmod 644 "$target"
  echo "Installed unit at $target"
}

enable_linger_if_needed() {
  if [ "$USER_MODE" -eq 1 ] && command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER_NAME" 2>/dev/null || true
  fi
}

require_systemd
check_existing_schema
ensure_env_file
write_unit
enable_linger_if_needed

systemctl_cmd daemon-reload
if [ "$NO_START" -eq 1 ]; then
  systemctl_cmd enable "$SERVICE_NAME"
  echo "Enabled $SERVICE_NAME (not started; --no-start was passed)."
else
  systemctl_cmd enable --now "$SERVICE_NAME"
  echo "Enabled and started $SERVICE_NAME."
fi

cat <<EOF

Useful commands:
  systemctl status $SERVICE_NAME
  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f
  ls -lt $RELEASE_DIR/crashes/ | head
EOF
```

- [ ] **Step 2: Run all install tests still pass**

Run: `bun test tests/install-script.test.ts`
Expected: all 5 tests PASS (the side-effect path is only triggered without `--render-only`, which the tests don't do).

- [ ] **Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(deploy): install.sh writes unit, ensures .env, daemon-reload, enable --now"
```

---

## Task 13: Implement uninstall.sh

**Files:**
- Create: `scripts/uninstall.sh`

This script is small and mostly side-effects; we'll cover it with a single integration smoke test rather than full TDD.

- [ ] **Step 1: Write the script**

Create `scripts/uninstall.sh`:

```bash
#!/bin/bash
set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: uninstall.sh [OPTIONS]

Remove the copilot-api systemd unit. Does NOT touch release/, .env, logs,
crashes/, or persisted tokens under ~/.local/share/copilot-api/.

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

systemctl_cmd() {
  if [ "$USER_MODE" -eq 1 ]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

unit_path() {
  if [ "$USER_MODE" -eq 1 ]; then
    echo "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  else
    echo "/etc/systemd/system/${SERVICE_NAME}.service"
  fi
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found. Nothing to uninstall." >&2
  exit 1
fi

TARGET="$(unit_path)"
if [ ! -f "$TARGET" ]; then
  echo "$TARGET does not exist; nothing to do."
  exit 0
fi

systemctl_cmd disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "$TARGET"
systemctl_cmd daemon-reload
systemctl_cmd reset-failed "$SERVICE_NAME" 2>/dev/null || true

echo "Removed $TARGET."
echo "Preserved (not touched): release/, release/.env, release/copilot-api.log, release/crashes/, ~/.local/share/copilot-api/"
```

- [ ] **Step 2: Sanity check**

Run: `bash -n scripts/uninstall.sh`  (syntax check, no execution)
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/uninstall.sh
git add scripts/uninstall.sh
git commit -m "feat(deploy): uninstall.sh removes systemd unit, preserves data"
```

---

## Task 14: Update scripts/package.ts to bundle new artifacts

**Files:**
- Modify: `scripts/package.ts`

- [ ] **Step 1: Read current package.ts script-copy section**

Open `scripts/package.ts` and find this block (currently around line 102-109):

```typescript
console.log("[package] copying control scripts into release")
const scriptsOut = path.join(RELEASE, "scripts")
await fs.mkdir(scriptsOut, { recursive: true })
for (const name of ["start.sh", "stop.sh", "restart.sh", "cert.sh"]) {
  const src = path.join(ROOT, "scripts", name)
  const dst = path.join(scriptsOut, name)
  await fs.copyFile(src, dst)
  await fs.chmod(dst, 0o755)
}
```

- [ ] **Step 2: Extend it to copy new scripts, the systemd template, and .env.example**

Replace the block above with:

```typescript
console.log("[package] copying control scripts into release")
const scriptsOut = path.join(RELEASE, "scripts")
await fs.mkdir(scriptsOut, { recursive: true })
for (const name of [
  "start.sh",
  "stop.sh",
  "restart.sh",
  "cert.sh",
  "install.sh",
  "uninstall.sh",
  "crash-handler.sh",
]) {
  const src = path.join(ROOT, "scripts", name)
  const dst = path.join(scriptsOut, name)
  await fs.copyFile(src, dst)
  await fs.chmod(dst, 0o755)
}

console.log("[package] copying systemd unit template into release")
const systemdOut = path.join(scriptsOut, "systemd")
await fs.mkdir(systemdOut, { recursive: true })
await fs.copyFile(
  path.join(ROOT, "scripts", "systemd", "copilot-api.service.template"),
  path.join(systemdOut, "copilot-api.service.template"),
)

console.log("[package] copying .env.example into release root")
await fs.copyFile(
  path.join(ROOT, "scripts", ".env.example"),
  path.join(RELEASE, ".env.example"),
)
```

- [ ] **Step 3: Build a release tarball locally and inspect**

Run: `bun run package --target=bun-darwin-arm64`
Expected: builds without error.

Then run:
```bash
tar -tzf dist/copilot-api-v*-darwin-arm64.tar.gz | grep -E "scripts/(install|uninstall|crash-handler|systemd)|\.env\.example"
```
Expected output (paths inside the tar):
```
release/.env.example
release/scripts/install.sh
release/scripts/uninstall.sh
release/scripts/crash-handler.sh
release/scripts/systemd/copilot-api.service.template
```

- [ ] **Step 4: Commit**

```bash
git add scripts/package.ts
git commit -m "build(deploy): bundle install.sh, uninstall.sh, crash-handler.sh, systemd template, .env.example"
```

---

## Task 15: Add systemd-detection shim to start.sh / stop.sh / restart.sh

**Files:**
- Modify: `scripts/start.sh`
- Modify: `scripts/stop.sh`
- Modify: `scripts/restart.sh`

The shim must come BEFORE any of the existing logic. We use the system-wide unit path as the default trigger; users with `--user-mode` or custom `--name` are expected to call `systemctl` directly (this is documented in `install.sh --help`).

- [ ] **Step 1: Add shim to start.sh**

Open `scripts/start.sh`. Right after the `#!/bin/bash` shebang and before any existing variable assignments, insert:

```bash
# If a systemd unit was installed via scripts/install.sh, delegate to it so
# `systemctl status` / `restart` / journalctl all stay coherent. The shim
# matches the default install (system-wide, name=copilot-api). Custom installs
# (--user-mode or --name <other>) are expected to use systemctl directly.
if [ -f /etc/systemd/system/copilot-api.service ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    exec systemctl start copilot-api
  else
    exec sudo systemctl start copilot-api
  fi
fi
```

- [ ] **Step 2: Add the same shim (with `stop`) to stop.sh**

Open `scripts/stop.sh`. After the shebang, insert:

```bash
if [ -f /etc/systemd/system/copilot-api.service ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    exec systemctl stop copilot-api
  else
    exec sudo systemctl stop copilot-api
  fi
fi
```

- [ ] **Step 3: Add the same shim (with `restart`) to restart.sh**

Open `scripts/restart.sh`. After the shebang, insert:

```bash
if [ -f /etc/systemd/system/copilot-api.service ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    exec systemctl restart copilot-api
  else
    exec sudo systemctl restart copilot-api
  fi
fi
```

- [ ] **Step 4: Manual sanity check on dev machine**

On macOS the unit file does not exist, so the shim falls through and the legacy `nohup` path runs. Verify:
```bash
test ! -f /etc/systemd/system/copilot-api.service && echo "shim will fall through (expected on dev machine)"
bash -n scripts/start.sh scripts/stop.sh scripts/restart.sh
```
Expected: first echo prints, then the syntax check produces no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/start.sh scripts/stop.sh scripts/restart.sh
git commit -m "feat(deploy): start/stop/restart delegate to systemctl when unit installed"
```

---

## Task 16: Update README with production deployment section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the right insertion point**

Open `README.md` and locate the existing "方式 A：从 GitHub Releases 下载预编译包（推荐部署方式）" section (around line 69). After the "release tarball 内布局" code block (around line 95) and before "### 方式 B：从源码安装", insert the new section below.

- [ ] **Step 2: Insert the section**

Insert exactly this block (note: the file is bilingual / Chinese-first, so we keep the same style):

```markdown
### 生产部署：systemd 保活（Linux 推荐）

release tarball 自带 `install.sh`，可以一键把服务装成 systemd unit，进程自动保活，crash 信息落盘。

**前置条件**：Linux + systemd + root/sudo（或者用 `--user-mode` 走用户级 systemd）。

#### 安装

```sh
tar -xzf copilot-api-vX.Y.Z-linux-x64.tar.gz
cd release
cp .env.example .env && $EDITOR .env       # 可选：编辑启动参数
sudo ./scripts/install.sh                  # 默认会立刻启动
systemctl status copilot-api
```

`install.sh` 支持的参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--user <name>` | `$SUDO_USER` 或 `$USER` | 服务以哪个系统用户身份运行 |
| `--name <service>` | `copilot-api` | systemd unit 名 |
| `--user-mode` | off | 装到 `~/.config/systemd/user/`，需配合 `loginctl enable-linger` |
| `--no-start` | off | 只 enable 不 start |
| `--render-only` | off | 只把渲染出的 unit 打到 stdout，不写文件 |

#### 日常操作

装完之后所有控制走 `systemctl`：

```sh
sudo systemctl restart copilot-api          # 改了 .env 之后重启
sudo systemctl stop copilot-api             # 停
sudo systemctl start copilot-api            # 启
systemctl status copilot-api                # 状态
journalctl -u copilot-api -f                # 跟日志
journalctl -u copilot-api -p err -S today   # 今天的错误
ls -lt release/crashes/ | head              # 最近 crash 报告
cat release/crashes/20260512T034512Z.txt    # 看具体一份 crash
```

> 现有 `scripts/start.sh` / `stop.sh` / `restart.sh` 会自动检测 systemd unit，存在时转发到 `systemctl`，所以旧命令也能用（默认 unit 名 `copilot-api` 才会被检测到）。

#### crash 信息落盘到哪里？

每次进程异常退出（OOM、`kill -9`、未捕获异常等）都会同时在三处留痕：

- **`release/crashes/<UTC>.txt`** ← **主入口**，self-contained 报告：退出原因 + journald 末 200 行 + 应用日志末 200 行 + 系统快照（uptime/free/df）。自动滚动保留最新 50 份。
- **`release/copilot-api.log`** ← systemd 持续追加的 stdout/stderr 全量原始流。
- **systemd journald** ← 同 stdout/stderr，加上 unit 级元数据（重启次数、信号号等），用 `journalctl -u copilot-api` 查询。

`systemctl stop` / `restart` 这种主动操作不会留 crash 报告。

#### 升级（in-place 覆盖）

```sh
cd ~/copilot-api                                       # release/ 所在的上级目录
tar -xzf copilot-api-vX.Y.Z-linux-x64.tar.gz          # 直接覆盖 release/
sudo systemctl restart copilot-api                     # 加载新二进制
```

升级时**不会**被覆盖的文件（都不在 tar 里）：

- `release/.env` — 用户配置
- `release/copilot-api.log` — 运行时由 systemd 写
- `release/crashes/` — 运行时由 crash-handler 写
- `~/.local/share/copilot-api/` — token，跟 release 目录无关

如果新版本的 systemd unit 模板也有变更，再次运行 `sudo ./scripts/install.sh` 即可（脚本是幂等的，会检测到 release-schema 不匹配并提示）。

#### 卸载

```sh
cd ~/copilot-api/release
sudo ./scripts/uninstall.sh
```

只删 systemd unit，不动 `release/`、`.env`、`crashes/`、`~/.local/share/copilot-api/`。

#### 重启策略说明

- `Restart=on-failure`：进程异常退出（信号、非 0 退出码、OOM）时自动重启；`systemctl stop` 不会触发重启。
- `RestartSec=5s`：等 5 秒再拉起，避免在依赖故障时把上游打爆。
- `StartLimitBurst=0`：禁用 systemd 默认的"10 秒内崩 5 次就熔断"，确保上游恢复后能自愈。代价：配置错误会无限重启，这种情况通过 `crashes/` 文件数和 `journalctl` 立刻能看到。

#### 非 systemd 环境

没有 systemd 的环境（容器内、Alpine、macOS、Windows）继续使用 `./scripts/start.sh`，行为不变（`nohup` + PID 文件）。生产环境下推荐 systemd 路径。
```

- [ ] **Step 3: Verify the file renders**

Run: `head -200 README.md | tail -120`
Visually confirm the section is in place and indentation is correct.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: production deployment with systemd (install/upgrade/uninstall)"
```

---

## Task 17: End-to-end smoke check by building a release and listing it

**Files:**
- (no source changes; verification only)

- [ ] **Step 1: Build a release tarball**

Run: `bun run package --target=bun-darwin-arm64` (or whatever your dev target is).
Expected: builds without error; tarball appears under `dist/`.

- [ ] **Step 2: Extract and inspect**

```bash
mkdir -p /tmp/copilot-api-smoke
tar -xzf dist/copilot-api-v*-darwin-arm64.tar.gz -C /tmp/copilot-api-smoke
ls /tmp/copilot-api-smoke/release/
ls /tmp/copilot-api-smoke/release/scripts/
ls /tmp/copilot-api-smoke/release/scripts/systemd/
```

Expected to see, at minimum:
- `release/.env.example`
- `release/scripts/{start,stop,restart,cert,install,uninstall,crash-handler}.sh` (all `-rwxr-xr-x`)
- `release/scripts/systemd/copilot-api.service.template`

- [ ] **Step 3: Run install.sh --render-only against the extracted tree**

```bash
cd /tmp/copilot-api-smoke/release
./scripts/install.sh --render-only --user testuser --name copilot-api
```
Expected: a fully rendered systemd unit prints to stdout. Verify:
- `User=testuser`
- `WorkingDirectory=/tmp/copilot-api-smoke/release`
- `ExecStart=/bin/sh -c '/tmp/copilot-api-smoke/release/bin/copilot-api start $COPILOT_API_ARGS'`
- No `__USER__` / `__RELEASE_DIR__` placeholders remain

- [ ] **Step 4: Run the full bun test suite to make sure nothing regressed**

Run: `bun test`
Expected: all existing tests still pass; the two new test files (`crash-handler-script.test.ts`, `install-script.test.ts`) all pass.

- [ ] **Step 5: Cleanup**

```bash
rm -rf /tmp/copilot-api-smoke
```

- [ ] **Step 6: No commit needed (verification only)**

If anything failed in steps 1–4, return to the relevant earlier task and fix the issue.

---

## Manual integration checklist (run on a real Linux server)

The Bun-based unit tests cover script logic. The end-to-end "actually restarts after kill -9" behavior depends on systemd and must be validated on a real Linux host. This checklist mirrors the spec § 6 but is concrete enough to follow:

- [ ] On an Ubuntu 22.04 (or similar) VM, transfer the tarball, extract.
- [ ] `cp .env.example .env`; edit `COPILOT_API_ARGS` if needed.
- [ ] `sudo ./scripts/install.sh`
- [ ] `systemctl status copilot-api` → shows `active (running)`.
- [ ] `curl -i http://localhost:4141/` → returns a response (200 or expected auth-related code).
- [ ] `MAIN_PID=$(systemctl show -p MainPID --value copilot-api); sudo kill -9 "$MAIN_PID"`
- [ ] Wait ~7 s, run `systemctl status copilot-api` → running again with a different PID.
- [ ] `ls -lt release/crashes/` → one new file with `service_result: signal`, `exit_status: 9`.
- [ ] Edit `.env`, `sudo systemctl restart copilot-api`, verify new args take effect.
- [ ] Re-run `sudo ./scripts/install.sh` → idempotent, no errors, service still healthy.
- [ ] `sudo ./scripts/uninstall.sh` → unit gone; `release/`, `.env`, `crashes/`, `~/.local/share/copilot-api/` all still present.

If any step fails, file an issue or fix the root cause (do not paper over it).

---

## Self-Review Notes

Coverage check against spec sections:

- § 1 Architecture Overview → Task 2 (template), Task 4/6 (crash-handler), Task 10/12 (install.sh), Task 13 (uninstall.sh), Task 15 (shim).
- § 2 install.sh Behavior → Task 10 (render), Task 12 (side effects), Task 11 (flag tests).
- § 3 systemd Unit Template → Task 2.
- § 4 crash-handler.sh → Tasks 3-7.
- § 5 Build & Packaging → Task 14.
- § 6 Testing → Tasks 3, 5, 7, 9, 11 (unit); manual checklist (integration).
- § 7 Operations Lifecycle → Task 16 (mirrored into README).
- § 8 README Changes → Task 16.

Type/name consistency: `RELEASE_SCHEMA_VERSION=1` matches `# release-schema=1` in template. `SERVICE_NAME` env var is set in unit (Task 2) and read by handler (Task 6). `__USER__/__RELEASE_DIR__/__SERVICE_NAME__` placeholder names match across template (Task 2), render-only test (Task 9), and `sed` substitution (Task 10).

No placeholders in steps; every code block is the actual content to write.
