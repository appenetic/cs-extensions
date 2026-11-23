#!/bin/bash
set -eu
# Package storage is noexec. CSDK_RUN is the SDK's executable tmpfs; the rename
# keeps a running copy intact.
case "$(uname -m)" in x86_64) ;; *)
    curl --silent --fail --max-time 3 --unix-socket "$CSDK_API_SOCKET" \
        -H "Authorization: Bearer $CSDK_TOKEN" -H 'Content-Type: application/json' \
        -X PUT http://csdk/v1/status --data-binary \
        '{"state":"unsupported","reason":"Diese Fassung braucht eine x86_64-MCU."}' >/dev/null || :
    exit 0 ;;
esac
umask 077
cp "$CSDK_PACKAGE_DIR/bin/quiet-linux-amd64" "$CSDK_RUN/quiet.new"
chmod 700 "$CSDK_RUN/quiet.new"
mv -f "$CSDK_RUN/quiet.new" "$CSDK_RUN/quiet"
exec "$CSDK_RUN/quiet"
