#!/bin/bash
set -u

# systemd ExecStopPost runs after every process exit and injects:
#   $SERVICE_RESULT  - "success" / "exit-code" / "signal" / "core-dump" / ...
#   $EXIT_CODE       - "exited" / "killed" / "dumped"
#   $EXIT_STATUS     - numeric exit code or signal number
#   $MAINPID         - the PID that just exited
# We must NOT log clean exits — those are operator-initiated stop/restart.

if [ "${SERVICE_RESULT:-}" = "success" ]; then
  exit 0
fi

# (Crash-report writing is added in Task 6.)
exit 0
