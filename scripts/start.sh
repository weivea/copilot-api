#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/copilot-api.pid"
LOG_FILE="$PROJECT_DIR/copilot-api.log"
BIN="$PROJECT_DIR/bin/copilot-api"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "copilot-api is already running (PID: $(cat "$PID_FILE"))"
  exit 1
fi

if [ ! -x "$BIN" ]; then
  # Dev fallback: use bun if the compiled binary is not present.
  if command -v bun >/dev/null 2>&1; then
    cd "$PROJECT_DIR" || exit 1
    nohup bun run bootstrap start > "$LOG_FILE" 2>&1 &
  else
    echo "Error: binary not found at $BIN and 'bun' is not installed"
    exit 1
  fi
else
  cd "$PROJECT_DIR" || exit 1
  # NOTE: --show-token is intentionally OMITTED here. With nohup redirecting
  # stdout/stderr to copilot-api.log, that flag would persist the super-admin
  # auth token, GitHub OAuth token, and refreshed Copilot tokens into a
  # plaintext log file (default umask ⇒ world-readable). The auth token is
  # always available at ~/.local/share/copilot-api/auth_token (mode 600);
  # pass --show-token only when running interactively for first-time setup.
  nohup "$BIN" start > "$LOG_FILE" 2>&1 &
fi

echo $! > "$PID_FILE"

# Tighten log permissions defensively in case --show-token gets re-added
# later or upstream errors echo a token in a stack trace.
chmod 600 "$LOG_FILE" 2>/dev/null || true

echo "copilot-api started (PID: $(cat "$PID_FILE"))"
echo "Log file: $LOG_FILE"
