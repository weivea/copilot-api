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
