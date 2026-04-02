#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/copilot-api.pid"
LOG_FILE="$PROJECT_DIR/copilot-api.log"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "copilot-api is already running (PID: $(cat "$PID_FILE"))"
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

nohup bun run start start > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "copilot-api started (PID: $(cat "$PID_FILE"))"
echo "Log file: $LOG_FILE"
