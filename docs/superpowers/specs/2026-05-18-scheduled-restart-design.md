# Scheduled Restart Design

**Status:** Approved
**Date:** 2026-05-18
**Scope:** Production deployment of the `bun --compile` release tarball on Linux servers with systemd. Development on macOS (preview / static checks only).

## Problem

The systemd unit installed by `scripts/install.sh` has `Restart=on-failure` but no daily / periodic restart. Operators want the service restarted every night at 02:00 local time (configurable) — typically to release leaked memory, refresh upstream sessions, or pick up rotated credentials without a manual `systemctl restart`.

## Non-Goals

- Cross-platform deployment. Production target remains Linux + systemd. macOS is a development host only — scripts must merely be runnable for preview / static testing on it (no launchd unit).
- Zero-downtime restart. A short restart blip at the configured time is acceptable (same as today's manual restart).
- Multiple per-day restart windows or cron-like syntax. Single `HH:MM` per day is enough.
- Application-level graceful drain. The existing `systemctl restart` semantics are reused.

## Decisions Locked In

| Decision | Choice |
| --- | --- |
| Trigger time default | `02:00` local time |
| Configuration source | `.env` variable `RESTART_TIME` |
| Format | `HH:MM` 24-hour, local time; literal `off` disables |
| Override mechanism | Edit `.env`, then `systemctl restart copilot-api-restart` (hot-reload via restart) |
| Scheduling mechanism | Dedicated long-running systemd service `copilot-api-restart.service` that sleeps until the target time, runs `systemctl restart copilot-api`, then exits |
| Loop driver | systemd `Restart=always` re-launches the scheduler, which re-reads `.env` each cycle |
| Disable behaviour | `RESTART_TIME=off` (or empty/missing) → scheduler `exec sleep infinity` so systemd does not respawn it in a busy loop |
| Install default | Scheduler is installed and enabled automatically by `install.sh`. No new flag. |
| macOS support | Scripts must be POSIX/BSD-compatible enough to run `--render-only` and shell unit tests on macOS (`bash 3.2`, BSD `date`). No launchd unit. |

## § 1 Architecture Overview

A second systemd unit is added alongside the existing `copilot-api.service`. The scheduler is a long-running process; its job is to wait until the next scheduled instant, fire a restart, then exit cleanly.

```text
systemd
  ├── copilot-api.service            ← existing (unchanged behaviour)
  └── copilot-api-restart.service    ← NEW: scheduler
        ├── EnvironmentFile=<release>/.env
        ├── ExecStart=<release>/scripts/restart-scheduler.sh
        ├── Restart=always           ← cycle to next iteration
        └── RestartSec=5s
```

New / changed artifacts in the release tarball:

```text
release/
  scripts/
    install.sh                          ← MODIFIED: install second unit, seed RESTART_TIME
    uninstall.sh                        ← MODIFIED: remove second unit
    restart-scheduler.sh                ← NEW: scheduler loop body
    systemd/
      copilot-api.service.template      ← unchanged
      copilot-api-restart.service.template ← NEW
  .env.example                          ← MODIFIED: add RESTART_TIME with comment
```

Runtime control flow of one scheduler iteration:

```text
systemd starts copilot-api-restart.service
  └── ExecStart=restart-scheduler.sh
        ├── source $RESTART_TIME from EnvironmentFile=.env
        ├── if RESTART_TIME is "off" / empty → exec sleep infinity (suspended)
        ├── validate HH:MM format → on failure: log + exit 1 (systemd will retry after RestartSec)
        ├── compute_delta_seconds (HH:MM, now)
        ├── sleep $delta
        ├── re-check now ≥ target (handles wall-clock jumps / suspend)
        └── systemctl [--user] restart copilot-api → exit 0
                                                     ↓
                                systemd Restart=always relaunches → next iteration
```

## § 2 Components

### 2.1 `scripts/systemd/copilot-api-restart.service.template`

```ini
# release-schema=1
[Unit]
Description=Copilot API scheduled restart (daily)
After=__SERVICE_NAME__.service

[Service]
Type=simple
User=__USER__
WorkingDirectory=__RELEASE_DIR__
EnvironmentFile=-__RELEASE_DIR__/.env
Environment=SERVICE_NAME=__SERVICE_NAME__
Environment=USER_MODE=__USER_MODE__
ExecStart=__RELEASE_DIR__/scripts/restart-scheduler.sh
Restart=always
RestartSec=5s
StartLimitBurst=0
StartLimitIntervalSec=0
StandardOutput=append:__RELEASE_DIR__/copilot-api-restart.log
StandardError=append:__RELEASE_DIR__/copilot-api-restart.log
SyslogIdentifier=__SERVICE_NAME__-restart
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
```

Notes:
- `__USER_MODE__` is a new template placeholder filled with `1` or `0` so the scheduler script knows whether to call `systemctl` or `systemctl --user`.
- `After=` orders the scheduler after the main unit at boot, but does not couple their lifecycles. We deliberately do **not** use `PartOf=` — `PartOf` would cause the scheduler's own `systemctl restart copilot-api` call to propagate back and restart the scheduler itself, producing log noise and racing the in-flight iteration.
- Logs go to a separate file so they don't pollute `copilot-api.log`.

### 2.2 `scripts/restart-scheduler.sh`

Shell script, bash 3.2 compatible, BSD/GNU `date` compatible. Public surface:

- Reads env: `RESTART_TIME`, `SERVICE_NAME`, `USER_MODE`.
- Exposes `compute_delta_seconds "$RESTART_TIME" "$NOW_HMS"` as a testable function. `NOW_HMS` is a `HH:MM:SS` string; when omitted, the function calls `date +%H:%M:%S`. Pulling "now" through an argument is what makes the function unit-testable on macOS — tests pass fixed clock values instead of needing to freeze time.
- Behaviour matrix:

  | `RESTART_TIME` | Action |
  | --- | --- |
  | `off`, empty, or unset | `exec sleep infinity` (process stays alive; no restart will ever happen; minimal CPU) |
  | Valid `HH:MM` (24h, leading zeros OK) | `sleep` to next occurrence, then `systemctl [--user] restart $SERVICE_NAME`, exit 0 |
  | Invalid (non-numeric, out of range, malformed) | `consola`-style stderr message + `exit 1` (systemd retries after `RestartSec=5s`; one bad value will not busy-loop because of the 5s pause) |

- `systemctl` invocation: `if [ "$USER_MODE" = 1 ]; then systemctl --user restart "$SERVICE_NAME"; else systemctl restart "$SERVICE_NAME"; fi`. The unit's `User=` already pins identity; `--user` only changes which systemd instance.

Reference implementation of the delta function (illustrative — final code lives in the script):

```bash
compute_delta_seconds() {
  # $1 = HH:MM, $2 = current HH:MM:SS
  local hhmm="$1" now="${2:-$(date +%H:%M:%S)}"
  case "$hhmm" in
    [0-2][0-9]:[0-5][0-9]) ;;
    *) echo "invalid RESTART_TIME: $hhmm" >&2; return 2 ;;
  esac
  local th tm nh nm ns
  th=$((10#${hhmm%:*}))
  tm=$((10#${hhmm#*:}))
  if [ "$th" -gt 23 ]; then
    echo "invalid hour in RESTART_TIME: $hhmm" >&2; return 2
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
```

This uses only POSIX `date +%H:%M:%S` and `10#` to defeat octal interpretation — works under macOS `/bin/bash` (3.2) and BSD `date`.

### 2.3 `scripts/install.sh` changes

1. New constant: `RESTART_SERVICE_NAME="${SERVICE_NAME}-restart"`.
2. `render_unit` extracted / parameterized to render either template. Concretely: rename current `render_unit` to `render_main_unit`, add `render_restart_unit`, and `--render-only` prints both separated by `# ---` so the existing `--render-only` contract still produces a single stream.
3. New placeholder `__USER_MODE__` added to the `sed` substitutions, filled with `$USER_MODE`.
4. `ensure_env_file` additionally appends `RESTART_TIME="02:00"` to `.env` (and to a freshly-copied `.env` from `.env.example`) **only if the key is not already present** (`grep -q '^RESTART_TIME=' "$target" || printf 'RESTART_TIME="02:00"\n' >> "$target"`). This makes re-runs idempotent and preserves user overrides.
5. After writing the main unit, write the restart unit to `<unit_dir>/copilot-api-restart.service` (or `<service_name>-restart.service`).
6. After `daemon-reload`, also `enable` and `start` the restart unit (mirroring the existing main-unit flow). `--no-start` skips the start for both.
7. Update the trailing "Useful commands" block to include:
   ```
   systemctl status <name>-restart
   journalctl -u <name>-restart -f
   # Change schedule: edit .env RESTART_TIME, then:
   <systemctl-prefix> restart <name>-restart
   ```

### 2.4 `scripts/uninstall.sh` changes

1. Compute `RESTART_SERVICE_NAME` the same way.
2. `disable --now` and `rm` it **before** the main unit, then `daemon-reload` once at the end.
3. `reset-failed` on both unit names.

### 2.5 `.env.example` changes

Append at the bottom:

```sh
# Daily restart of the copilot-api service (handled by copilot-api-restart.service).
# Format: HH:MM in 24-hour local time. Set to "off" to disable scheduled restarts.
# After changing this value, apply with:
#   systemctl restart copilot-api-restart   (or: systemctl --user restart copilot-api-restart)
RESTART_TIME="02:00"
```

## § 3 Error Handling & Edge Cases

| Case | Behaviour |
| --- | --- |
| `RESTART_TIME` malformed (e.g. `25:99`, `abc`) | Scheduler logs error to journald + log file, exits 1. systemd `Restart=always` + `RestartSec=5s` re-runs after 5s — bounded retry, no busy loop. Operator fixes `.env` and `systemctl restart copilot-api-restart`. |
| `RESTART_TIME` unset / empty / `off` | `exec sleep infinity`. Process is alive, zero CPU, systemd reports it as `active (running)`. Operator can re-enable by editing `.env` and restarting the scheduler. |
| Target time already passed today | `compute_delta_seconds` adds 86400 → next occurrence is tomorrow at `HH:MM`. |
| `sleep` interrupted by signal | systemd terminates the script normally; `Restart=always` brings it back; loop recomputes delta. No work lost (next fire is the same wall-clock instant). |
| Host suspend / wall-clock jump | After `sleep` returns, recompute `now`; if `now` is past target by < 1 hour, fire immediately; otherwise treat as a new iteration (sleep again). This is a single safety check after each `sleep`, not a polling loop. |
| `systemctl restart copilot-api` itself fails | Scheduler still exits 0 (it did its best); the failure surfaces via the main unit's own journald entry. We do **not** want the scheduler to retry restart in a tight loop. |
| User mode (`install.sh --user-mode`) | `__USER_MODE__=1` → scheduler uses `systemctl --user restart`. `loginctl enable-linger` was already called by `install.sh` and is required for the scheduler to keep running after logout. |
| `systemctl daemon-reload` after unit changes | Both units re-render on every `install.sh` run (via existing `try-restart` pattern). |
| Concurrent `install.sh` re-runs | `ensure_env_file` is idempotent (`grep -q` guard); `write_unit` always overwrites. No partial state. |

## § 4 Testing Strategy

### 4.1 macOS (development)

| Test | How |
| --- | --- |
| Unit templates render correctly | `./scripts/install.sh --render-only` — must print both unit files separated by `# ---`. Inspect placeholders are all substituted. |
| Shellcheck clean | `brew install shellcheck` then `shellcheck scripts/*.sh`. Must pass. |
| `compute_delta_seconds` correctness | New file `tests/restart-scheduler.test.sh` (bash, not bun test — these are POSIX shell tests). Sources `scripts/restart-scheduler.sh` with a guard so sourcing does **not** run the main loop (e.g. `if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi`). Asserts on representative cases. |
| `compute_delta_seconds` test cases | (1) `02:00` at `01:00:00` → 3600; (2) `02:00` at `02:00:00` → 86400 (already passed → tomorrow); (3) `02:00` at `01:59:30` → 30; (4) `02:00` at `23:59:00` → 7260; (5) `00:00` at `12:00:00` → 43200; (6) `25:00` → exit 2 + stderr message; (7) `abc` → exit 2; (8) `08:00` (leading zero) → no octal trap. |
| Off/empty handling | Run `restart-scheduler.sh` with `RESTART_TIME=off` and `RESTART_TIME=""` through a shim that replaces `exec sleep infinity` with `echo SLEEPS_FOREVER && exit 0`, assert the line was printed. |
| systemctl shim | The test harness sets `PATH` so `systemctl` resolves to a stub that appends its arguments to a file — verifies the scheduler calls `systemctl restart copilot-api` (or `--user`) given `USER_MODE`. |

Tests live in `tests/restart-scheduler.test.sh` and are runnable via `bash tests/restart-scheduler.test.sh`. They do **not** integrate into `bun test` (different runner, different language). The README / dev notes mention them.

### 4.2 Linux (real installation, manual or CI)

| Test | How |
| --- | --- |
| Fresh install both units up | `./install.sh`; `systemctl status copilot-api copilot-api-restart` both `active`. |
| Scheduled restart fires | Edit `.env` `RESTART_TIME="$(date -d '+2 minutes' +%H:%M)"`; `systemctl restart copilot-api-restart`; wait; `journalctl -u copilot-api --since '3 min ago'` shows main service restart. |
| Disable | `RESTART_TIME=off`; restart scheduler; confirm scheduler `active (running)` but no restart of main service over 5 min. |
| Invalid value | `RESTART_TIME="99:99"`; restart scheduler; journalctl shows error + retry cadence. |
| Uninstall is clean | `./uninstall.sh`; both unit files gone; `systemctl status copilot-api-restart` → `not-found`. |
| User-mode | Repeat fresh-install on a non-root user with `--user-mode`; verify `loginctl show-user <user>` shows `Linger=yes` and that the scheduler triggers a `systemctl --user restart`. |

### 4.3 Out of scope for automated CI

A real systemd timing test in CI is overkill. Manual Linux verification on the deploy box is enough; macOS unit tests cover the only piece with non-trivial logic (delta computation + dispatch).

## § 5 Observability

- Scheduler writes to `release/copilot-api-restart.log` + journald (`SyslogIdentifier=copilot-api-restart`).
- Each iteration logs one line on start: `"scheduled next restart at HH:MM (in Ns)"` so an operator can confirm the next fire time without doing math.
- Each iteration logs one line on fire: `"triggering restart of <service>"`.
- `RESTART_TIME=off` logs: `"RESTART_TIME=off — scheduled restart disabled (sleeping)"` once on entry.
- `journalctl -u copilot-api-restart -f` is added to `install.sh`'s final "Useful commands" output.

## § 6 Migration / Backward Compatibility

- Existing installations re-run `install.sh` to get the scheduler. `ensure_env_file` adds `RESTART_TIME="02:00"` to an existing `.env` only if missing; users who already have a `RESTART_TIME` value are not overwritten.
- `release-schema=1` marker remains `1`; the template change is additive and does not break the existing schema check (the marker exists primarily to flag *future* breaking changes).
- Operators who don't want the scheduler can `RESTART_TIME=off` immediately after install, or `systemctl disable --now copilot-api-restart`. Both work.
- Downgrading: running an older `install.sh` will not remove the scheduler unit; operators who want it gone should run the new `uninstall.sh` first, then install the old release.
