#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Stopping copilot-api..."
"$SCRIPT_DIR/stop.sh" 2>/dev/null

sleep 1

echo "Starting copilot-api..."
"$SCRIPT_DIR/start.sh"
