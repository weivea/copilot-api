#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/copilot-api.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "copilot-api is not running (no PID file found)"
  exit 1
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  rm -f "$PID_FILE"
  echo "copilot-api stopped (PID: $PID)"
else
  rm -f "$PID_FILE"
  echo "copilot-api was not running (stale PID file removed)"
fi
