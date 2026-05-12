# Process Keepalive & Crash Reporting Design

**Status:** Approved
**Date:** 2026-05-12
**Scope:** Production deployment of the `bun --compile` release tarball on Linux servers with systemd.

## Problem

`scripts/start.sh` launches the compiled binary with `nohup` and writes a PID file. When the process crashes (uncaught exception, OOM, signal), nothing restarts it and the only crash trace is whatever happened to land in `copilot-api.log` before the process died. We need:

1. A keepalive mechanism that automatically restarts the process when it dies.
2. Structured crash information so operators can diagnose why it died.
3. A simple, repeatable install/upgrade/uninstall flow that fits the existing release-tarball delivery model.

## Non-Goals

- Cross-platform supervisor (Windows/macOS/non-systemd Linux). Existing `scripts/start.sh` remains as a fallback for those environments.
- Zero-downtime upgrades or blue/green deployment. A short restart blip is acceptable.
- Alerting (email/webhook). Out of scope for this iteration.
- Changes to application source under `src/`. All keepalive logic lives outside the binary.

## Decisions Locked In

| Decision          | Choice                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Init system       | Linux + systemd (with root/sudo)                                        |
| Integration style | Ship `install.sh` in release tar, one-shot installs a systemd unit      |
| Crash capture     | systemd journald + `ExecStopPost` script writes `crashes/<ts>.txt`      |
| Restart policy    | `Restart=on-failure`, `RestartSec=5s`, no `StartLimitBurst`             |
| Run identity      | Current user, in-place release directory (no dedicated user, no `/opt`) |
| Config delivery   | `.env` + systemd `EnvironmentFile=`                                     |
| Upgrade strategy  | **Plan A — in-place overwrite + `systemctl restart`**                   |

## § 1 Architecture Overview

New artifacts shipped inside the release tarball:

```text
release/
  bin/copilot-api
  dist/public/
  drizzle/
  scripts/
    start.sh / stop.sh / restart.sh   ← kept for non-systemd / debug
    install.sh                        ← NEW: install systemd unit
    uninstall.sh                      ← NEW: remove systemd unit
    crash-handler.sh                  ← NEW: invoked by ExecStopPost
  systemd/
    copilot-api.service.template      ← NEW: rendered by install.sh
  .env.example                        ← NEW: copy to .env
```

Runtime topology after `install.sh`:

```text
systemd
  └── copilot-api.service
        ├── EnvironmentFile=<release>/.env
        ├── ExecStart=<release>/bin/copilot-api start $COPILOT_API_ARGS
        ├── ExecStopPost=<release>/scripts/crash-handler.sh
        ├── Restart=on-failure   RestartSec=5s
        ├── StandardOutput=append:<release>/copilot-api.log
        └── StandardError=append:<release>/copilot-api.log
journald     ← duplicates stdout/stderr; queried via journalctl -u copilot-api
crashes/     ← one file per abnormal exit, kept rotating to ~50 entries
```

`start.sh / stop.sh / restart.sh` are updated to detect systemd-managed deployment by checking for the unit file at `/etc/systemd/system/copilot-api.service` (the default install location). If present, they `exec systemctl <verb> copilot-api` and exit. Otherwise they run the current `nohup` path unchanged. The detection is hard-coded to the default unit name `copilot-api`; operators who installed under a custom `--name` must use `systemctl` directly. This keeps existing operator muscle memory working in the default case while making systemd the source of truth.

## § 2 install.sh Behavior

Idempotent bash script, run from inside the unpacked `release/` directory.

1. Verify systemd is available (`systemctl --version`); abort otherwise.
2. Parse flags:
   - `--user <name>` (default: `$SUDO_USER` if set, else `$USER`)
   - `--name <service>` (default: `copilot-api`)
   - `--no-start` (skip auto-start; default is to start)
3. Resolve the release directory absolute path with `realpath`.
4. If `.env` does not exist, copy `.env.example` and warn the operator to edit it; continue installation regardless (defaults are usable).
5. Render `systemd/copilot-api.service.template`, substituting `${USER}`, `${RELEASE_DIR}`, `${SERVICE_NAME}` via `envsubst`.
6. Write the rendered unit:
   - System-wide (default): `/etc/systemd/system/<name>.service` (requires root/sudo).
   - `--user-mode`: `~/.config/systemd/user/<name>.service`, then `loginctl enable-linger <user>`.
7. `chmod 600` the `.env` file (it can contain `--github-token` value via `GH_TOKEN`).
8. `systemctl daemon-reload && systemctl enable --now <name>` (skipped under `--no-start`, in which case only `enable` runs).
9. Print a help block with `status / restart / journalctl / crashes` commands.

**Schema versioning.** `install.sh` declares `RELEASE_SCHEMA_VERSION=1`. The rendered unit has a comment line `# release-schema=1`. On every invocation, `install.sh` reads the existing unit (if any) and compares its embedded schema with its own. On mismatch, it prints a clear notice listing what changed and re-installs the unit (idempotent overwrite + `daemon-reload` + `try-restart`). On match, it still re-renders and re-installs (same idempotency), but skips the notice. This catches the case where a user upgraded the release tar without re-running `install.sh`, but never makes them think.

`uninstall.sh` mirrors the install: detect the unit, `systemctl disable --now`, remove the unit file, `daemon-reload`. Does **not** touch `release/`, `.env`, `copilot-api.log`, `crashes/`, or `~/.local/share/copilot-api/`.

## § 3 systemd Unit Template

```ini
# release-schema=1
[Unit]
Description=Copilot API (GitHub Copilot → OpenAI/Anthropic proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${RELEASE_DIR}
EnvironmentFile=${RELEASE_DIR}/.env
ExecStart=${RELEASE_DIR}/bin/copilot-api start $COPILOT_API_ARGS
ExecStopPost=${RELEASE_DIR}/scripts/crash-handler.sh

# Keepalive
Restart=on-failure
RestartSec=5s

# Logging
StandardOutput=append:${RELEASE_DIR}/copilot-api.log
StandardError=append:${RELEASE_DIR}/copilot-api.log
SyslogIdentifier=${SERVICE_NAME}

# Make SERVICE_NAME available to ExecStopPost (systemd does not inject it).
Environment=SERVICE_NAME=${SERVICE_NAME}

# Resource / hardening
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

**`.env.example`** ships with the common knobs:

```bash
# Optional CLI args appended to `copilot-api start`. Example:
#   COPILOT_API_ARGS="--port 4141 --account-type business --rate-limit 30"
COPILOT_API_ARGS=""

# Anything the binary reads from environment (e.g. PORT, NODE_ENV).
# PORT=4141
```

systemd performs `$COPILOT_API_ARGS` word splitting in `ExecStart`, which is exactly what we want for "let users append free-form CLI args without rewriting the unit file."

## § 4 crash-handler.sh

Runs after every process exit thanks to `ExecStopPost`. systemd injects `$SERVICE_RESULT`, `$EXIT_CODE`, `$EXIT_STATUS`, `$MAINPID`.

```bash
#!/bin/bash
set -u

# Skip clean exits (systemctl stop, normal shutdown).
[ "${SERVICE_RESULT:-}" = "success" ] && exit 0

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
  echo "service_result: ${SERVICE_RESULT:-unknown}"
  echo "exit_code:      ${EXIT_CODE:-unknown}"
  echo "exit_status:    ${EXIT_STATUS:-unknown}"
  echo "main_pid:       ${MAINPID:-unknown}"
  echo
  echo "=== Last 200 lines from journald ==="
  journalctl -u "$SERVICE_NAME" -n 200 --no-pager 2>&1 || true
  echo
  echo "=== Last 200 lines from copilot-api.log ==="
  tail -n 200 "$RELEASE_DIR/copilot-api.log" 2>/dev/null || true
  echo
  echo "=== System snapshot ==="
  uptime || true
  free -h 2>/dev/null || true
  df -h "$RELEASE_DIR" 2>/dev/null || true
} > "$FILE" 2>&1

# Rotate: keep newest 50.
ls -1t "$CRASH_DIR"/*.txt 2>/dev/null | tail -n +51 | xargs -r rm --
```

Each abnormal exit yields a self-contained report: exit cause + journald tail + application log tail + machine snapshot. The presence and frequency of files in `crashes/` is a quick "is it crash-looping?" signal even before opening any one report.

## § 5 Build & Packaging Changes

`scripts/package.ts`:

- Add `install.sh`, `uninstall.sh`, `crash-handler.sh` to the script copy list.
- Create `release/systemd/` and copy `copilot-api.service.template` into it.
- Copy `.env.example` to `release/`.
- `chmod 755` the new shell scripts.

No changes to the binary build, frontend build, or drizzle migration steps.

## § 6 Testing Strategy

**Bash unit tests** (`tests/scripts/`, `bats` or simple shell asserts):

- `install.sh` flag parsing: `--user`, `--name`, `--no-start`, `--user-mode`.
- Template rendering: feed known inputs, diff produced unit against a checked-in fixture.
- `crash-handler.sh` behavior matrix:
  - `SERVICE_RESULT=success` → exits 0, writes nothing.
  - `SERVICE_RESULT=signal`, `EXIT_STATUS=9` → writes file with expected sections.
  - Rotation: pre-seed 60 fake crash files, run handler, assert exactly 50 remain.

**Integration smoke test** (manual checklist, captured in spec; CI nice-to-have, not blocking):

1. Unpack release on an Ubuntu 22.04 VM, run `sudo ./scripts/install.sh`.
2. `systemctl status copilot-api` shows `active (running)`.
3. `curl http://localhost:4141/` returns 200.
4. `kill -9 $MAIN_PID`; within ~7s `systemctl status` shows running again with a new PID; `ls crashes/` has one new file with `service_result: signal` / `exit_status: 9`.
5. Edit `.env`, `sudo systemctl restart copilot-api`, verify new args take effect.
6. Re-run `install.sh` (same schema): no destructive change, idempotent.
7. `sudo ./scripts/uninstall.sh`: unit gone; `release/`, `.env`, `crashes/`, `~/.local/share/copilot-api/` untouched.

## § 7 Operations Lifecycle

These flows are authoritative — they are also what gets documented in `README.md` (see § 8).

### Install (first time)

```bash
tar -xzf copilot-api-vX.Y.Z-linux-x64.tar.gz
cd release
cp .env.example .env && $EDITOR .env       # optional but recommended
sudo ./scripts/install.sh                  # auto-starts the service
systemctl status copilot-api
```

### Day-to-day operations

```bash
sudo systemctl restart copilot-api          # restart (e.g. after editing .env)
sudo systemctl stop copilot-api             # stop
sudo systemctl start copilot-api            # start
systemctl status copilot-api                # status
journalctl -u copilot-api -f                # follow logs
journalctl -u copilot-api -p err -S today   # today's errors only
ls -lt release/crashes/ | head              # recent crash reports
cat release/crashes/20260512T034512Z.txt    # inspect a specific crash
```

### Upgrade (Plan A — in-place overwrite)

Assumes `release/` lives under e.g. `~/copilot-api/release/`.

```bash
cd ~/copilot-api
tar -xzf copilot-api-vX.Y.Z-linux-x64.tar.gz   # overwrites release/ in place
sudo systemctl restart copilot-api              # picks up new bin/, frontend, drizzle
```

What is preserved across upgrades (none of these are inside the tar):

- `release/.env` — user config
- `release/copilot-api.log` — written at runtime by systemd
- `release/crashes/` — written at runtime by `crash-handler.sh`
- `~/.local/share/copilot-api/` — auth tokens (lives outside `release/` entirely)

If the new tar bumps `RELEASE_SCHEMA_VERSION`, `install.sh` warns on next invocation. Operators are instructed (in the README) to re-run `sudo ./scripts/install.sh` after an upgrade if the systemd unit template has changed; in the common case the binary upgrade alone is enough.

### Uninstall

```bash
cd ~/copilot-api/release
sudo ./scripts/uninstall.sh
```

Removes only the systemd unit. Leaves `release/` intact (so re-installing later is just `sudo ./scripts/install.sh` again); leaves `.env`, logs, crash reports, and persisted tokens untouched.

## § 8 README Changes

Add a new section **"Production deployment with systemd (Linux)"** to `README.md`, structured as:

1. **Prerequisites** — Linux with systemd, root/sudo.
2. **Install** — the four-line block above.
3. **Restart / stop / start** — the `systemctl` commands above.
4. **Viewing logs and crash reports** — `journalctl` and `crashes/` examples.
5. **Upgrade** — the in-place overwrite block, with the explicit list of preserved files.
6. **Uninstall** — the uninstall block, noting what is and isn't removed.
7. **Configuration** — point to `.env.example`, explain `COPILOT_API_ARGS`.
8. **Non-systemd fallback** — one-liner pointing back to the existing `scripts/start.sh` for environments without systemd.

The section is the canonical operations reference. The `scripts/install.sh` help output mirrors items 3–6 in abbreviated form.

## Open Questions

None.

## Out-of-Scope (potential follow-ups)

- Webhook / email alerting on crashes.
- Blue/green release directory layout (Plan B from brainstorming).
- A health endpoint (`/healthz`) and a systemd `Type=notify` integration.
- Crash report summarization / dedup tooling.
