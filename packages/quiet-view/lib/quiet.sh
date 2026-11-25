#!/bin/bash
# Bash 3.2 and BusyBox. The quiet view is a launcher app: its own tile
# definition has QtCar open the page in a maximized window without a top bar,
# also in Drive. The page and its data come from the web service, a Go binary
# (hooks/web.sh); this library is what the apply hook needs for the tile.
WEB=${CSDK_PACKAGE_DIR:-}/web
PORT=${CSDK_WEB_APP_PORT:-}
# QtCar knows a web app by its title, the sandbox by the tile ID: the package ID
# with dashes for dots, a dot and the tile.
TITLE=Quiet
TILE=${CSDK_PKG:-com.appenetic.quiet-view}
TILE=${TILE//./-}.app

api() {
    curl --silent --show-error --fail --connect-timeout 2 --max-time 10 \
        --unix-socket "$CSDK_API_SOCKET" \
        -H "Authorization: Bearer $CSDK_TOKEN" -H 'Content-Type: application/json' \
        -X "$1" "http://csdk/v1$2" ${3:+--data-binary "$3"}
}
status() {
    # Reasons are fixed source strings, never vehicle or user input.
    api PUT /status "{\"state\":\"$1\",\"reason\":\"$2\"}" >/dev/null || :
}
# say GERMAN ENGLISH: the words in the car's language, as the page speaks it:
# German where the car is set to German or has not said, English otherwise.
say() {
    case "$(api GET /dv/GUI_locale 2>/dev/null)" in
        ''|'<invalid>'|de|de[_-]*) printf '%s' "$1" ;;
        *) printf '%s' "$2" ;;
    esac
}

# The tile as the daemon builds one for a manifest tile (the browser config and
# webapp.json), but with a window that opens maximized and stays so, without a
# top bar, and allowed in Drive. PUT /v1/tiles/app installs it in the ledger as
# $TILE and has QtCar rescan its tiles; the same definition again is no change.
quiet_tile() {
    local dir=$CSDK_STATE/tile origin="http://127.0.0.1:$PORT" host='127\\.0\\.0\\.1'
    rm -rf "$dir"
    mkdir -p "$dir/def"
    cat > "$dir/def/config" <<EOF
#!/bin/bash
# Sourced by /usr/bin/configure-chromium. Written by the apply hook of $CSDK_PKG for its tile.
export CHROMIUM_CONFIG_INSTANCE_ID="$TILE"
export CHROMIUM_CONFIG_X11_WINDOW_NAME="WebApp.$TILE"
export CHROMIUM_CONFIG_SHOW_ADDRESS_BAR="false"
export CHROMIUM_CONFIG_STARTING_URL="$origin/"
export CHROMIUM_CONFIG_EXTENSIONS=("scrollbar")
export CHROMIUM_CONFIG_ENABLE_NAVIGATION_GESTURES="false"
export CHROMIUM_CONFIG_ENABLE_PINCH_TO_ZOOM="false"
export CHROMIUM_CONFIG_SANDBOX_PROFILE="chromium-entertainment"
EOF
    {
        printf '{"%s":{"title":"%s","url":"%s/",' "$TILE" "$TITLE" "$origin"
        printf '"platforms":["ice","infoz","krk2e"],"useBrowserDeepLink":false,'
        printf '"allowedUrls":["^http[s]*://%s:%s/.*","^http[s]*://localhost:%s/.*"],' "$host" "$PORT" "$PORT"
        printf '"showLoading":false,"iconImage":"./icon.png","buttonImage":"./icon.png","showInLauncher":true,'
        printf '"allowedWithBaseConnectivity":true,"allowInDrive":true,"canMaximizeAppWindow":true,'
        printf '"appWindowDefaultOpensToMaximized":true,"appWindowIsMaximizedOnly":true,"showAppWindowTopBar":false,'
        printf '"verticalOffsetForTopAppWindowBar":0,"appWindowBackgroundColorDefinition":"#050505 #050505 #050505",'
        printf '"isBackgroundMainlyDark":true,"supportScrollWheelNavigation":false,'
        printf '"allowBackgroundAudioWhenDismissed":false,"loadingTransitionMsBeforeShow":0,"zoom":{"default":0}}}\n'
    } > "$dir/def/webapp.json"
    printf '{"%s":{"title":"%s"}}\n' "$TILE" "$TITLE" > "$dir/def/webappLocData_en.json"
    cp "$WEB/icon.png" "$dir/def/icon.png"
    # QtCar reads the definition as its own user; hooks run with umask 0077.
    chmod 755 "$dir" "$dir/def"
    chmod 644 "$dir/def"/*
    api PUT /tiles/app "{\"dir\":\"$dir\"}" >/dev/null
}
