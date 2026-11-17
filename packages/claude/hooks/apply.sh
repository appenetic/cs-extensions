#!/bin/bash
set -eu
api() {
    curl -sS --max-time 5 --unix-socket "$CSDK_API_SOCKET" -H "Authorization: Bearer $CSDK_TOKEN" \
        -H 'Content-Type: application/json' -X "$1" "http://csdk/v1$2" ${3:+--data-binary "$3"}
}

# CoilShift starts the web service with nsenter --net=/run/netns/<ns>. Where /run
# and /var/run are separate tmpfs (firmware 2026.32.7), the browser namespaces
# exist only under /var/run/netns and the web service cannot start. A ledgered
# bind gives nsenter that path; every apply asserts it again, so an upgrade
# keeps it. The link service repeats it should the namespace appear later.
ns=$(api PUT /web/app '{}' 2>/dev/null | sed -n 's/.*"netns":"\([a-z0-9-]*\)".*/\1/p') || ns=
[ -n "$ns" ] || ns=chromium-entertainment
if [ "$(readlink -f /var/run)" != /run ] && [ -e "/var/run/netns/$ns" ]; then
    api PUT "/binds/netns-$ns" "{\"source\":\"/var/run/netns/$ns\",\"target\":\"/run/netns/$ns\"}" >/dev/null 2>&1 || :
fi

# Puts the map card's template where QtCar's UI host reads it. The service
# registers the card only when the host is attached; no vehicle writes.
[ -n "${CSDK_UI_DIR:-}" ] || exit 0
ui=${CSDK_UI_DIR%/}
mkdir -p "$ui/ui" "$ui/model"
chmod 755 "$ui/ui" "$ui/model"
cp "$CSDK_PACKAGE_DIR/ui/card.uiml" "$ui/ui/.card.uiml.new"
chmod 644 "$ui/ui/.card.uiml.new"
mv -f "$ui/ui/.card.uiml.new" "$ui/ui/card.uiml"
exit 0
