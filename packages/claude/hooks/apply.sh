#!/bin/bash
set -eu
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
