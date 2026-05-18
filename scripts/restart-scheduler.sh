#!/bin/bash
# Scheduler for daily copilot-api restart.
#
# Reads RESTART_TIME (HH:MM, 24h local time, or "off") from the environment
# (populated by systemd's EnvironmentFile=.env). Sleeps until the next
# occurrence, then runs `systemctl restart $SERVICE_NAME` and exits 0.
# systemd's Restart=always brings this script back for the next iteration.
#
# Sourceable: when sourced from a test harness, `main` is NOT invoked,
# so callers can exercise `compute_delta_seconds` in isolation.

set -euo pipefail

# --- compute_delta_seconds HHMM [NOW_HMS] ----------------------------------
# Prints the number of seconds from NOW_HMS (default: current wall clock)
# until the next HH:MM. If HH:MM has already passed today, returns
# delta + 86400 (tomorrow). Exits 2 on invalid input.
compute_delta_seconds() {
  local hhmm="$1"
  local now="${2:-$(date +%H:%M:%S)}"

  case "$hhmm" in
    [0-9][0-9]:[0-9][0-9]) : ;;
    *)
      echo "invalid RESTART_TIME (expected HH:MM): $hhmm" >&2
      return 2
      ;;
  esac

  local th tm nh nm ns
  # 10# defeats bash's octal interpretation of leading zeros (e.g. "08").
  th=$((10#${hhmm%:*}))
  tm=$((10#${hhmm#*:}))
  if [ "$th" -gt 23 ] || [ "$tm" -gt 59 ]; then
    echo "invalid RESTART_TIME (hour 0-23, minute 0-59): $hhmm" >&2
    return 2
  fi

  nh=$((10#${now%%:*}))
  local rest="${now#*:}"
  nm=$((10#${rest%%:*}))
  ns=$((10#${rest#*:}))

  local target=$(( th * 3600 + tm * 60 ))
  local current=$(( nh * 3600 + nm * 60 + ns ))
  local delta=$(( target - current ))
  if [ "$delta" -le 0 ]; then
    delta=$(( delta + 86400 ))
  fi
  echo "$delta"
}

# --- main ------------------------------------------------------------------
main() {
  # Placeholder; filled in in a later task. Kept as a no-op so the script
  # remains executable but does nothing harmful if accidentally run.
  echo "restart-scheduler.sh: main() not yet implemented" >&2
  exit 0
}

# Only call main when executed directly, not when sourced.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
