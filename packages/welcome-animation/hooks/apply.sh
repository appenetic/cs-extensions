#!/bin/bash
set -eu
. "$CSDK_PACKAGE_DIR/lib/intro.sh"
animation=$(setting animation stock)
lights=$(setting lights true)
choice=$(intro_choice "$animation") || animation=stock
mkdir -p "$CSDK_RUN"
cp "$R$LIGHTS" "$CSDK_RUN/lights.before" 2>/dev/null || :

# QtCar reads the light animations only when it starts.
finish() {
    local note=$2
    if [ -f "$CSDK_RUN/lights.before" ] && ! cmp -s "$CSDK_RUN/lights.before" "$R$LIGHTS" && qtcar_running; then
        api POST /restarts '{"target":"ui","parked":true}' >/dev/null || :
        note="$note Das Licht wechselt nach dem nächsten Neustart des Touchscreens."
    fi
    rm -f "$CSDK_RUN/lights.before"
    status "$1" "$note"
    exit "$3"
}
# Whatever cannot be done leaves the car as it came from the factory.
stock() {
    intro_stock || :
    lights_stock || :
    finish "$@"
}

if [ "$animation" = stock ]; then
    intro_stock || stock failed 'Das Intro-Skript ließ sich nicht zurücksetzen.' 1
    lights_stock || stock failed 'Das Ambientelicht ließ sich nicht zurücksetzen.' 1
    finish ok 'Ab Werk: Die Firmware wählt Video und Licht selbst.' 0
fi
set -- $choice
intro_firmware_ok || stock unsupported 'Diese Firmware wählt die Welcome-Animation anders. Nichts geändert.' 10
[ -f "$R$VIDEOS/$3" ] || stock unsupported 'Diese Firmware hat das Video dafür nicht. Nichts geändert.' 10
intro_overlay "$animation" "$1" "$2" ||
    stock failed 'Das Intro-Skript ließ sich nicht überlagern. Es bleibt bei Ab Werk.' 1
case "$animation" in
standard) name='Standard' ;;
performance) name='Performance' ;;
launch) name='Launch Series' ;;
esac
rc=0
if [ "$lights" = true ]; then
    lights_overlay "$4" || rc=$?
else
    lights_stock || rc=1
fi
case "$rc/$lights" in
0/true) finish ok "$name mit Ambientelicht ab dem nächsten Einsteigen." 0 ;;
0/*) finish ok "$name ab dem nächsten Einsteigen, das Ambientelicht wie ab Werk." 0 ;;
2/*)
    lights_stock || :
    finish ok "$name ab dem nächsten Einsteigen. Diese Firmware hat kein passendes Ambientelicht." 0 ;;
*) stock failed 'Das Ambientelicht ließ sich nicht überlagern. Es bleibt bei Ab Werk.' 1 ;;
esac
