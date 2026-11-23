#!/bin/bash
set -u
. "$CSDK_PACKAGE_DIR/lib/quiet.sh"
if [ -z "$PORT" ] || ! command -v socat >/dev/null 2>&1; then
    status unsupported 'Kein Web-Port oder kein socat auf diesem Auto.'
    exit 0
fi
export CSDK_PACKAGE_DIR CSDK_RUN CSDK_WEB_APP_PORT CSDK_PKG
trap 'kill $(cat "$LISTEN"/* 2>/dev/null) 2>/dev/null; rm -rf "$LISTEN"; exit 0' TERM INT
rm -rf "$LISTEN"
status ok 'Kachel „Quiet“ im Launcher.'
# The turn rate twice a second; colour, trip and listeners every 2 s.
n=0
while :; do
    if [ $((n % 4)) -eq 0 ]; then
        quiet_trip
        quiet_scan
    fi
    quiet_motion
    quiet_write
    n=$((n + 1))
    sleep 0.5 & wait $!
done
