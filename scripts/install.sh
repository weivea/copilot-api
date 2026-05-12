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

# --- Side-effecting install ------------------------------------------------

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Error: systemctl not found. This installer requires systemd." >&2
    echo "On non-systemd hosts, use scripts/start.sh directly." >&2
    exit 1
  fi
}

unit_path() {
  if [ "$USER_MODE" -eq 1 ]; then
    echo "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
  else
    echo "/etc/systemd/system/${SERVICE_NAME}.service"
  fi
}

systemctl_cmd() {
  if [ "$USER_MODE" -eq 1 ]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

ensure_env_file() {
  local example="$RELEASE_DIR/.env.example"
  local target="$RELEASE_DIR/.env"
  if [ ! -f "$target" ]; then
    if [ -f "$example" ]; then
      cp "$example" "$target"
      echo "Created $target from .env.example. Edit it to customize args, then:"
      echo "  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME"
    else
      # No example available; create a minimal placeholder so EnvironmentFile= works.
      printf 'COPILOT_API_ARGS=""\n' > "$target"
    fi
  fi
  chmod 600 "$target"
}

check_existing_schema() {
  local target
  target="$(unit_path)"
  if [ ! -f "$target" ]; then return 0; fi
  local existing
  existing="$(grep -E '^# release-schema=' "$target" | head -n1 | cut -d= -f2)"
  if [ -z "$existing" ]; then
    echo "Notice: existing $target has no release-schema marker; replacing it."
  elif [ "$existing" != "$RELEASE_SCHEMA_VERSION" ]; then
    echo "Notice: existing $target has release-schema=$existing; this release is $RELEASE_SCHEMA_VERSION. Replacing."
  fi
}

write_unit() {
  local target
  target="$(unit_path)"
  mkdir -p "$(dirname "$target")"
  render_unit > "$target.tmp"
  mv "$target.tmp" "$target"
  chmod 644 "$target"
  echo "Installed unit at $target"
}

enable_linger_if_needed() {
  if [ "$USER_MODE" -eq 1 ] && command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER_NAME" 2>/dev/null || true
  fi
}

require_systemd
check_existing_schema
ensure_env_file
write_unit
enable_linger_if_needed

systemctl_cmd daemon-reload
if [ "$NO_START" -eq 1 ]; then
  systemctl_cmd enable "$SERVICE_NAME"
  echo "Enabled $SERVICE_NAME (not started; --no-start was passed)."
else
  systemctl_cmd enable "$SERVICE_NAME"
  # `try-restart` is a no-op for inactive units (so first install proceeds to
  # `start` below), and a graceful restart for active ones (so re-running
  # install.sh after a unit-template change actually picks up the change).
  systemctl_cmd try-restart "$SERVICE_NAME" || true
  systemctl_cmd start "$SERVICE_NAME"
  echo "Enabled and started $SERVICE_NAME."
fi

cat <<EOF

Useful commands:
  systemctl status $SERVICE_NAME
  $(if [ "$USER_MODE" -eq 1 ]; then echo systemctl --user; else echo sudo systemctl; fi) restart $SERVICE_NAME
  journalctl -u $SERVICE_NAME -f
  ls -lt $RELEASE_DIR/crashes/ | head
EOF
