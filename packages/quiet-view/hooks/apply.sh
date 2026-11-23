#!/bin/bash
set -eu
. "$CSDK_PACKAGE_DIR/lib/quiet.sh"
# CoilShift starts the web service with nsenter --net=/run/netns/<ns>. Where /run
# and /var/run are separate tmpfs (firmware 2026.32.7), the browser namespaces
# exist only under /var/run/netns and the service cannot start. A ledgered bind
# gives nsenter that path; every apply asserts it again.
ns=$(api PUT /web/app '{}' 2>/dev/null | sed -n 's/.*"netns":"\([a-z0-9-]*\)".*/\1/p') || ns=
[ -n "$ns" ] || ns=chromium-entertainment
if [ "$(readlink -f /var/run)" != /run ] && [ -e "/var/run/netns/$ns" ]; then
    api PUT "/binds/netns-$ns" "{\"source\":\"/var/run/netns/$ns\",\"target\":\"/run/netns/$ns\"}" >/dev/null 2>&1 || :
fi
if [ -z "$PORT" ]; then
    status failed 'Kein Web-Port vom CoilShift-Dienst erhalten.'
    exit 1
fi
if ! quiet_tile; then
    status failed 'Die Kachel ließ sich nicht installieren.'
    exit 1
fi
exit 0
