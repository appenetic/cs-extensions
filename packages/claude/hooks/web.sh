#!/bin/bash
set -eu
# Package storage is noexec. CSDK_RUN is the SDK's executable tmpfs. Both
# services copy the same binary; the rename keeps a running copy intact.
case "$(uname -m)" in x86_64) ;; *)
    curl --silent --fail --max-time 3 --unix-socket "$CSDK_API_SOCKET" \
        -H "Authorization: Bearer $CSDK_TOKEN" -H 'Content-Type: application/json' \
        -X PUT http://csdk/v1/status --data-binary \
        '{"state":"unsupported","reason":"This build requires an x86_64 MCU."}' >/dev/null || :
    exit 0 ;;
esac
umask 077
cp "$CSDK_PACKAGE_DIR/bin/claude-linux-amd64" "$CSDK_RUN/claude.web.new"
chmod 700 "$CSDK_RUN/claude.web.new"
mv -f "$CSDK_RUN/claude.web.new" "$CSDK_RUN/claude"
exec "$CSDK_RUN/claude" web
