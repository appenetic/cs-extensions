#!/bin/bash
set -u
# The ledger takes our overlays back as well; removal does not wait for it.
. "$CSDK_PACKAGE_DIR/lib/intro.sh"
for name in $(intro_services) ambient-lights; do
    api DELETE "/overlays/$name" >/dev/null 2>&1 || :
done
# QtCar holds our light animations until it restarts.
if [ -f "${CSDK_RUN:-}/overlays/ambient-lights.json" ]; then
    api POST /restarts '{"target":"ui","parked":true}' >/dev/null 2>&1 || :
fi
exit 0
