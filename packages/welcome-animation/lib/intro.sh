#!/bin/bash
# Bash 3.2 and BusyBox. Video: the firmware's vehicle-intro services source
# /etc/tvideo.env, which picks vehicle-intro[-launch|-perf].mp4 by what lv reads
# for VAPI_vehicleBadging and VAPI_performancePackage. Our overlay of each intro
# run script answers just those two reads, and only while it sources tvideo.env:
# the firmware still picks the video and its scaling, and nothing else on the
# car sees a changed value.
# Light: QtCar reads AmbientLightsAnimation.json once, when it starts, and plays
# "welcomePerf" or "welcomeLS" only on a Model Y of that kind, "welcome" on any
# other car. Our copy of the file gives all three the frames of the chosen one.
R=${CSDK_FAKE_ROOT:-}
MARK='# com.appenetic.welcome-animation'
TVIDEO=/etc/tvideo.env
VIDEOS=/usr/tesla/UI/assets/videos
LIGHTS=/usr/tesla/UI/assets/AmbientLightsAnimation.json

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
setting() {
    local value
    value=$(cat "${CSDK_SETTINGS:-}/$1" 2>/dev/null) || value=$2
    printf '%s' "$value"
}

# Badging, performance package, video and light animation of a car of that
# kind. tvideo.env tests the badging first.
intro_choice() {
    case "$1" in
    standard) echo 'Base Base vehicle-intro.mp4 welcome' ;;
    performance) echo 'Base Performance vehicle-intro-perf.mp4 welcomePerf' ;;
    launch) echo 'LaunchSeries Base vehicle-intro-launch.mp4 welcomeLS' ;;
    *) return 1 ;;
    esac
}

# vehicle-intro, and one more service per further display (vehicle-intro-1).
intro_services() {
    local dir name
    for dir in "$R"/etc/sv/vehicle-intro*; do
        name=${dir##*/}
        case "$name" in *[!a-z0-9-]*) continue ;; esac
        [ -f "$dir/run" ] && printf '%s\n' "$name"
    done
}

# tvideo.env picks the video as on 2026.32.7 and 2026.38.5.12.
intro_firmware_ok() {
    local word
    for word in 'lv VAPI_vehicleBadging' LaunchSeries 'FILE_SUFFIX="-launch"' \
        'lv VAPI_performancePackage' Performance 'FILE_SUFFIX="-perf"'; do
        grep -qF -- "$word" "$R$TVIDEO" 2>/dev/null || return 1
    done
}

# The stock run script: the target, or while our overlay is on it the daemon's
# pristine copy; without that copy, the target once the overlay is off.
intro_stock_script() {
    local name=$1 target=$R/etc/sv/$1/run pristine=$CSDK_STATE/overlays/$1/pristine
    if ! grep -qF "$MARK" "$target"; then
        printf '%s' "$target"
    elif [ -f "$pristine" ] && ! grep -qF "$MARK" "$pristine"; then
        printf '%s' "$pristine"
    else
        api DELETE "/overlays/$name" >/dev/null || :
        grep -qF "$MARK" "$target" && return 1
        printf '%s' "$target"
    fi
}

# The stock script with lv answering the two DataValues around its one
# ". /etc/tvideo.env"; fails unless there is exactly one such line.
intro_render() {
    awk -v mark="$MARK ($2): tvideo.env picks the video by these two DataValues" \
        -v shim="lv() { case \"\$1\" in VAPI_vehicleBadging) echo '\"$3\"' ;; VAPI_performancePackage) echo '\"$4\"' ;; *) command lv \"\$@\" ;; esac; }" '
        $0 == ". /etc/tvideo.env" { print mark; print shim; print; print "unset -f lv"; n++; next }
        { print }
        END { exit (n == 1 ? 0 : 1) }' "$1"
}

# Writes a new copy over the old one in place (a mounted overlay shows that
# very inode), puts the overlay on and checks that the target shows it.
overlay_put() {
    local name=$1 target=$2 copy=$3 mode=$4
    if [ ! -f "$copy" ] || ! cmp -s "$copy.new" "$copy"; then
        cat "$copy.new" > "$copy" || return 1
    fi
    rm -f "$copy.new"
    chmod "$mode" "$copy" || return 1
    api PUT "/overlays/$name" "{\"target\":\"$target\",\"source\":\"$copy\"}" >/dev/null || return 1
    cmp -s "$copy" "$R$target"
}

# Puts the rendered run script over every intro service that picks its video
# through tvideo.env.
intro_overlay() {
    local animation=$1 badging=$2 package=$3 name script copy count=0
    mkdir -p "$CSDK_RUN/overlays" || return 1
    for name in $(intro_services); do
        script=$(intro_stock_script "$name") || return 1
        grep -q FILE_SUFFIX "$script" || continue
        copy=$CSDK_RUN/overlays/$name.run
        if ! intro_render "$script" "$animation" "$badging" "$package" > "$copy.new" ||
            ! /bin/bash -n "$copy.new"; then
            rm -f "$copy.new"
            return 1
        fi
        overlay_put "$name" "/etc/sv/$name/run" "$copy" 0700 || return 1
        count=$((count + 1))
    done
    [ "$count" -gt 0 ]
}

# Takes our overlays of the run scripts off; fails if one stays on.
intro_stock() {
    local name rc=0
    for name in $(intro_services); do
        api DELETE "/overlays/$name" >/dev/null 2>&1 || :
        if grep -qF "$MARK" "$R/etc/sv/$name/run"; then
            rc=1
        else
            rm -f "$CSDK_RUN/overlays/$name.run"
        fi
    done
    return $rc
}

# The stock animations: the target, or while our copy is on it the daemon's
# pristine copy; without that copy, the target once the overlay is off.
lights_stock_file() {
    local copy=$CSDK_RUN/overlays/ambient-lights.json pristine=$CSDK_STATE/overlays/ambient-lights/pristine
    if [ -f "$copy" ] && cmp -s "$copy" "$R$LIGHTS"; then
        if [ -f "$pristine" ]; then
            printf '%s' "$pristine"
            return 0
        fi
        api DELETE /overlays/ambient-lights >/dev/null || :
        cmp -s "$copy" "$R$LIGHTS" && return 1
    fi
    printf '%s' "$R$LIGHTS"
}

# Puts our copy of the animations on; 2 if this firmware has no such animation.
lights_overlay() {
    local key=$1 file copy=$CSDK_RUN/overlays/ambient-lights.json
    mkdir -p "$CSDK_RUN/overlays" || return 1
    file=$(lights_stock_file) || return 1
    if ! jq --arg key "$key" '
        if (.[$key].frames | type) == "array" and (.welcome | type) == "object"
        then .[$key] as $a | .welcome = $a | .welcomePerf = $a | .welcomeLS = $a
        else error("no animation " + $key) end' "$file" > "$copy.new" 2>/dev/null; then
        rm -f "$copy.new"
        return 2
    fi
    # QtCar runs as tesla; package hooks run with umask 0077.
    overlay_put ambient-lights "$LIGHTS" "$copy" 0644
}

# Takes our copy of the animations off; fails if it stays on.
lights_stock() {
    local copy=$CSDK_RUN/overlays/ambient-lights.json
    api DELETE /overlays/ambient-lights >/dev/null 2>&1 || :
    if [ -f "$copy" ] && cmp -s "$copy" "$R$LIGHTS"; then
        return 1
    fi
    rm -f "$copy"
}

# QtCar holds the animations it read at its start. Without pidof, assume it runs.
qtcar_running() {
    command -v pidof >/dev/null 2>&1 || return 0
    pidof QtCar >/dev/null 2>&1
}
