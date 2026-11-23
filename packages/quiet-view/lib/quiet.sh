#!/bin/bash
# Bash 3.2 and BusyBox. The quiet view is a launcher app: its own tile
# definition has QtCar open web/ in a maximized window without a top bar, also
# in Drive, and a swipe down on the page closes it. The web service serves those
# files and /state on the package's web port, with socat, in every browser
# namespace; it writes /state from the car's DataValues.
WEB=${CSDK_PACKAGE_DIR:-}/web
STATE=${CSDK_RUN:-}/state.json
PORT=${CSDK_WEB_APP_PORT:-}
LISTEN=${CSDK_RUN:-}/listen
# QtCar knows a web app by its title, the sandbox by the tile ID: the package ID
# with dashes for dots, a dot and the tile.
TITLE=Quiet
TILE=$(printf '%s' "${CSDK_PKG:-com.appenetic.quiet-view}" | tr . -).app

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
dv() {
    api GET "/dv/$1" 2>/dev/null
}

# "255,131,0" as "#ff8300"; white when the car reports no colour.
quiet_color() {
    local r g b rest c
    IFS=, read -r r g b rest <<EOF
$1
EOF
    for c in "$r" "$g" "$b"; do
        case "$c" in ''|*[!0-9]*) echo '#ffffff'; return ;; esac
        [ "$((10#$c))" -le 255 ] || { echo '#ffffff'; return; }
    done
    [ -z "$rest" ] || { echo '#ffffff'; return; }
    printf '#%02x%02x%02x\n' "$((10#$r))" "$((10#$g))" "$((10#$b))"
}

# "16:41:00" as "16:41"; nothing unless it reads as a time of day.
quiet_time() {
    case "$1" in
    [01][0-9]:[0-5][0-9]*|2[0-3]:[0-5][0-9]*) printf '%s' "${1%"${1#?????}"}" ;;
    [0-9]:[0-5][0-9]*) printf '%s' "${1%"${1#????}"}" ;;
    esac
}

# A number the car reports ("15.3"), rounded to whole minutes or to 0.1 km
# from miles with a decimal comma; nothing if it is not a number.
quiet_minutes() {
    case "$1" in ''|*[!0-9.]*|*.*.*) return ;; esac
    awk -v m="$1" 'BEGIN { printf "%d", m + 0.5 }'
}
quiet_km() {
    case "$1" in ''|*[!0-9.]*|*.*.*) return ;; esac
    awk -v m="$1" 'BEGIN { printf "%.1f", m * 1.609344 }' | tr . ,
}

# /state for the page: the colour, and the trip while one is planned. The
# destination is left out: through the car API it reads "<redacted>".
quiet_state() {
    local color trip=false eta='' min='' km='' tmp
    color=$(quiet_color "$(dv GUI_rgbColor)")
    if [ "$(dv GUI_navNextDestinationArrivalInfoValid)" = true ]; then
        eta=$(quiet_time "$(dv GUI_navNextDestinationArrivalTime)")
        if [ -n "$eta" ]; then
            trip=true
            min=$(quiet_minutes "$(dv NAV_minutesToArrival)")
            km=$(quiet_km "$(dv NAV_milesToArrival)")
        fi
    fi
    tmp=$STATE.$$
    printf '{"color":"%s","trip":%s,"eta":"%s","min":"%s","km":"%s"}\n' "$color" "$trip" "$eta" "$min" "$km" > "$tmp" &&
        mv -f "$tmp" "$STATE"
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

# QtCar's app window: maximized, with the swipe that dismisses it; or closed.
quiet_window() {
    case "$1" in
    max)
        qtcar maximizeAppWindow "string:$TITLE" boolean:true &&
            qtcar setWebAppDismissGestureEnabled "string:$TITLE" boolean:true ;;
    close)
        qtcar dismissApp "string:$TITLE" boolean:false ;;
    esac
}
qtcar() {
    local method=$1
    shift
    dbus-send --system --print-reply=literal --dest=com.tesla.CenterDisplayDbus /CenterDisplayDbus \
        "com.tesla.CenterDisplayDbus.$method" "$@" >/dev/null 2>&1
}

# One HTTP exchange on stdin/stdout, as socat hands it over: GET and HEAD for
# the files of web/ and /state, POST /window/max and /window/close for the
# page's own window. Only for 127.0.0.1 or localhost on the package's port, so
# a page elsewhere cannot rebind to it, and POST only with the X-Quiet header,
# which another origin cannot send without a preflight this server refuses.
quiet_http() {
    local line method path version name host='' quiet='' file type
    IFS= read -r -t 5 line || return 0
    line=${line%$'\r'}
    read -r method path version <<EOF
$line
EOF
    while IFS= read -r -t 5 line; do
        line=${line%$'\r'}
        [ -n "$line" ] || break
        name=$(printf '%s' "${line%%:*}" | tr 'A-Z' 'a-z')
        case "$name" in
        host) host=${line#*:}; host=${host# } ;;
        x-quiet) quiet=${line#*:}; quiet=${quiet# } ;;
        esac
    done
    case "$host" in
    "127.0.0.1:$PORT"|"localhost:$PORT") ;;
    *) quiet_reply '421 Misdirected Request' text/plain /dev/null; return 0 ;;
    esac
    case "$method $path" in
    'POST /window/max'|'POST /window/close')
        if [ "$quiet" != 1 ]; then
            quiet_reply '403 Forbidden' text/plain /dev/null
        elif quiet_window "${path#/window/}"; then
            quiet_reply '204 No Content' text/plain /dev/null
        else
            quiet_reply '502 Bad Gateway' text/plain /dev/null
        fi
        return 0 ;;
    GET\ *|HEAD\ *) ;;
    *) quiet_reply '405 Method Not Allowed' text/plain /dev/null; return 0 ;;
    esac
    case "${path%%\?*}" in
    /) file=$WEB/index.html type='text/html; charset=utf-8' ;;
    /app.js) file=$WEB/app.js type='text/javascript; charset=utf-8' ;;
    /app.css) file=$WEB/app.css type='text/css; charset=utf-8' ;;
    /icon.png) file=$WEB/icon.png type=image/png ;;
    /state) file=$STATE type='application/json' ;;
    *) quiet_reply '404 Not Found' text/plain /dev/null; return 0 ;;
    esac
    if [ ! -f "$file" ]; then
        quiet_reply '503 Service Unavailable' text/plain /dev/null
        return 0
    fi
    quiet_reply '200 OK' "$type" "$file"
}
quiet_reply() {
    local size
    size=$(wc -c < "$3" | tr -d ' ')
    printf 'HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %s\r\nCache-Control: no-store\r\n' "$1" "$2" "$size"
    printf "X-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; img-src 'self' data:\r\n"
    printf 'Connection: close\r\n\r\n'
    [ "$method" = HEAD ] || cat "$3"
}

# The port in every namespace a browser of the car may open the tile in: the
# service's own, the chromium* ones under /var/run/netns, and that of every
# running chromium process, which a browser gets only when it starts (as the
# Claude package's web service does it). One socat per namespace, by inode; one
# that died is started again on the next scan.
quiet_scan() {
    local ns id pid
    mkdir -p "$LISTEN"
    for ns in self /var/run/netns/chromium* /proc/[0-9]*/ns/net; do
        case "$ns" in
        self) ns=/proc/self/ns/net ;;
        /proc/*) case "$(cat "${ns%/ns/net}/comm" 2>/dev/null)" in *chromium*) ;; *) continue ;; esac ;;
        esac
        id=$(stat -L -c %i "$ns" 2>/dev/null) || continue
        [ -n "$id" ] || continue
        pid=$(cat "$LISTEN/$id" 2>/dev/null)
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && continue
        # nsenter execs socat, so $! is the listener in both cases.
        if [ "$ns" = /proc/self/ns/net ]; then
            socat "TCP4-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" "EXEC:/bin/bash $CSDK_PACKAGE_DIR/lib/http.sh" &
        else
            nsenter --net="$ns" -- socat "TCP4-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" \
                "EXEC:/bin/bash $CSDK_PACKAGE_DIR/lib/http.sh" &
        fi
        echo $! > "$LISTEN/$id"
    done
}
