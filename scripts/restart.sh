#!/bin/bash

if [ -f /etc/systemd/system/copilot-api.service ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    exec systemctl restart copilot-api
  else
    exec sudo systemctl restart copilot-api
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping copilot-api..."
"$SCRIPT_DIR/stop.sh" 2>/dev/null

sleep 1

echo "Starting copilot-api..."
"$SCRIPT_DIR/start.sh"
