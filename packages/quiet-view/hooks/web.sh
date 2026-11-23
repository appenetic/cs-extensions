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
while :; do
    quiet_state
    quiet_scan
    sleep 2 & wait $!
done
