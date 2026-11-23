#!/bin/bash
set -eu
. "$CSDK_PACKAGE_DIR/lib/intro.sh"
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

case "$ANIMATION" in
performance) name='Performance-Animation' ;;
launch) name='Launch-Series-Animation' ;;
*) finish failed 'Unbekanntes Paket.' 1 ;;
esac
set -- $(intro_choice)
intro_foreign && finish failed 'Eine andere Welcome-Animation ist aktiv. Deinstalliere sie zuerst.' 1
intro_firmware_ok || stock unsupported 'Diese Firmware wählt die Welcome-Animation anders. Nichts geändert.' 10
[ -f "$R$VIDEOS/$3" ] || stock unsupported 'Diese Firmware hat das Video dafür nicht. Nichts geändert.' 10
intro_overlay "$1" "$2" || stock failed 'Das Intro-Skript ließ sich nicht überlagern. Es bleibt bei ab Werk.' 1
rc=0
lights_overlay "$4" || rc=$?
case "$rc" in
0) finish ok "$name mit Ambientelicht ab dem nächsten Einsteigen." 0 ;;
2)
    lights_stock || :
    finish ok "$name ab dem nächsten Einsteigen. Diese Firmware hat kein passendes Ambientelicht." 0 ;;
*) stock failed 'Das Ambientelicht ließ sich nicht überlagern. Es bleibt bei ab Werk.' 1 ;;
esac
