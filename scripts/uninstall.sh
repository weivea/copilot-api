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
