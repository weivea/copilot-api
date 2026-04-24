#!/bin/bash
#
# Certbot helper for the release tarball — equivalent to `bun run cert:obtain`
# / `cert:renew` from the source repo, but as a plain shell wrapper so it
# works without bun installed.
#
# Usage:
#   ./scripts/cert.sh obtain --domain example.com
#   ./scripts/cert.sh renew
#
# Behavior:
#   - Stores everything under ~/.local/share/copilot-api/certs/
#     (config, work, logs, live)
#   - On `obtain`, also writes
#     ~/.local/share/copilot-api/copilot-api.config.json with the
#     domain and absolute cert/key paths so `start.sh` picks up TLS
#     automatically on next launch.

set -euo pipefail

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/copilot-api"
CERTS_DIR="$APP_DIR/certs"
CONFIG_FILE="$APP_DIR/copilot-api.config.json"

ensure_certbot() {
  if ! command -v certbot >/dev/null 2>&1; then
    echo "Error: certbot is not installed or not on PATH." >&2
    echo "" >&2
    echo "Install certbot for your platform:" >&2
    echo "  Linux (Ubuntu/Debian): sudo apt install certbot" >&2
    echo "  Linux (Fedora/RHEL):   sudo dnf install certbot" >&2
    echo "  macOS:                 brew install certbot" >&2
    echo "  All platforms:         pip install certbot" >&2
    echo "" >&2
    echo "More: https://certbot.eff.org/instructions" >&2
    exit 1
  fi
}

certbot_dir_flags() {
  echo "--config-dir $CERTS_DIR --work-dir $CERTS_DIR/work --logs-dir $CERTS_DIR/logs"
}

write_config() {
  local domain="$1"
  local cert="$CERTS_DIR/live/$domain/fullchain.pem"
  local key="$CERTS_DIR/live/$domain/privkey.pem"

  cat > "$CONFIG_FILE" <<EOF
{
  "domain": "$domain",
  "tls": {
    "cert": "$cert",
    "key": "$key"
  }
}
EOF

  echo ""
  echo "Certificate obtained for $domain"
  echo "  cert: $cert"
  echo "  key:  $key"
  echo "Config written to $CONFIG_FILE"
}

cmd_obtain() {
  local domain=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)
        domain="${2:-}"
        shift 2
        ;;
      *)
        echo "Unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done

  if [ -z "$domain" ]; then
    echo "Error: --domain <domain> is required for 'obtain'" >&2
    exit 1
  fi

  mkdir -p "$APP_DIR" "$CERTS_DIR"
  # shellcheck disable=SC2046
  sudo certbot certonly --standalone -d "$domain" $(certbot_dir_flags)

  write_config "$domain"
}

cmd_renew() {
  if [ ! -d "$CERTS_DIR" ]; then
    echo "Error: $CERTS_DIR not found — run './scripts/cert.sh obtain --domain <domain>' first." >&2
    exit 1
  fi
  # shellcheck disable=SC2046
  sudo certbot renew $(certbot_dir_flags)
  echo "Certificate renewal complete"
}

main() {
  if [ $# -lt 1 ]; then
    echo "Usage: $0 {obtain --domain <domain> | renew}" >&2
    exit 1
  fi

  ensure_certbot

  local action="$1"
  shift

  case "$action" in
    obtain) cmd_obtain "$@" ;;
    renew)  cmd_renew  "$@" ;;
    *)
      echo "Unknown action: $action. Use 'obtain' or 'renew'." >&2
      exit 1
      ;;
  esac
}

main "$@"
