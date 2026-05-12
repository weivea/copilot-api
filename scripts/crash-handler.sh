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
