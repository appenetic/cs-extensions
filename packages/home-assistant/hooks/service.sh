#!/bin/bash
set -eu
# Package storage is noexec. CSDK_RUN is the SDK's executable tmpfs.
case "$(uname -m)" in x86_64) ;; *)
    curl --silent --fail --max-time 3 --unix-socket "$CSDK_API_SOCKET" \
        -H "Authorization: Bearer $CSDK_TOKEN" -H 'Content-Type: application/json' \
        -X PUT http://csdk/v1/status --data-binary \
        '{"state":"unsupported","reason":"This build requires an x86_64 MCU."}' >/dev/null || :
    exit 0 ;;
esac
umask 077
cp "$CSDK_PACKAGE_DIR/bin/bridge-linux-amd64" "$CSDK_RUN/bridge.new"
chmod 700 "$CSDK_RUN/bridge.new"
mv -f "$CSDK_RUN/bridge.new" "$CSDK_RUN/bridge"
exec "$CSDK_RUN/bridge"
