# Welcome-Animation für CoilShift

Zwei experimentelle SDK-1.0-Pakete, je eins pro Animation:

| Paket | Video | Ambientelicht |
| --- | --- | --- |
| `com.appenetic.welcome-performance` „Welcome-Animation Performance“ | `vehicle-intro-perf.mp4` (+ `-perf-1` auf dem zweiten Display) | `welcomePerf`: blaues Pulsieren mit hellen Blitzen, danach deine Farbe |
| `com.appenetic.welcome-launch` „Welcome-Animation Launch Series“ | `vehicle-intro-launch.mp4`, nichts auf dem zweiten Display | `welcomeLS`: eine rot-weiß-orange Welle von hinten nach vorn |

Installieren schaltet die Animation ein, Deinstallieren stellt den
Werkszustand her. Es gibt keine Einstellungen: CoilShift bietet Paketen aus
eigenen Repositories keine an. Am Auto blieben alle Einstellungsordner der
Fremdpakete leer. Die erste Fassung mit Auswahl (`com.appenetic.welcome-animation`)
war deshalb nicht bedienbar und ist aus dem Feed genommen.

Es kann nur eins der beiden Pakete wirken. Ist das andere schon aktiv, ändert
das zweite nichts und meldet „Eine andere Welcome-Animation ist aktiv.
Deinstalliere sie zuerst.“ Am Fahrzeug wird kein Wert geschrieben: Auto, App
und Tesla sehen weiter die echte Ausstattung.

- **Video:** wechselt ab dem nächsten Intro, also wenn der Bildschirm beim
  Einsteigen angeht.
- **Licht:** QtCar liest die Lichtanimationen nur beim Start. Das Paket bittet
  CoilShift deshalb um einen Neustart des Touchscreens. CoilShift wartet damit,
  bis du in P bist und aussteigst. „Apply now“ in CoilShift startet ihn sofort.
  Dasselbe gilt beim Deinstallieren.

## So funktioniert es

Beide Pakete haben byte-gleiche Hooks und `lib/intro.sh`. Welche Animation
gilt, folgt aus der Paket-ID (`CSDK_PKG`).

**Video.** Die Dienste `vehicle-intro` und `vehicle-intro-1` (zweites Display)
lesen beim Start `/etc/tvideo.env`. Darin wählt die Firmware selbst:

```sh
if [[ "$(lv VAPI_vehicleBadging | tr -d '"')" =~ LaunchSeries$ ]]; then
	FILE_SUFFIX="-launch"   # 2026.32.7: Video 1920×1200, eigene Skalierung
elif [[ "$(lv VAPI_performancePackage | tr -d '"')" = Performance ]]; then
    FILE_SUFFIX="-perf"
fi
```

Das Paket legt per CoilShift-`overlay` eine Kopie über
`/etc/sv/vehicle-intro*/run`. Die Kopie ist das Original plus drei Zeilen
rund um `. /etc/tvideo.env`: eine Markierung mit der Paket-ID, eine Funktion
`lv`, die genau diese beiden DataValues wie bei einem Auto der gewählten Art
beantwortet, und `unset -f lv`. Alle anderen `lv`-Aufrufe gehen weiter ans
Auto. So entscheidet die Firmware selbst über Video, Skalierung und zweites
Display:

| Paket | `VAPI_vehicleBadging` | `VAPI_performancePackage` | Video (2026.32.7) |
| --- | --- | --- | --- |
| Performance | `Base` | `Performance` | 2560×1600, ×0,75, ohne Ton |
| Launch Series | `LaunchSeries` | `Base` | 1920×1200, ×1,0, ohne Ton |

Ab Werk läuft `vehicle-intro.mp4` (2560×1600, ×0,75, mit Ton).
`/etc/tvideo.env` selbst bleibt unberührt. Sie wird auch von Camp-, Dog-,
Sentry-, Kamin- und Tron-Modus gelesen.

**Licht.** QtCar (`AmbientLightsManager::updateAnimation`) nimmt während des
Intro-Videos (`GUI_splashVideoActivelyPlaying`) die Animation `welcomePerf`
nur bei `VehicleUtils::isBayberryPerf()`. Bayberry ist das Model Y ab 2025.
`welcomeLS` gilt nur bei Launch-Series-Badging, sonst `welcome`. Die Frames
stehen in `/usr/tesla/UI/assets/AmbientLightsAnimation.json`. Das Paket legt
eine Kopie darüber, in der `welcome`, `welcomePerf` und `welcomeLS` alle die
Frames seiner Animation tragen. Die übrigen Animationen (Sentry, Alarm, Light
Show …) bleiben, wie sie sind.

**Sicherungen.**
- **Andere Firmware:** Prüft `tvideo.env` anders oder fehlt das Video, ändert
  das Paket nichts und meldet „unsupported“.
- **Startskript:** Es braucht genau eine Zeile `. /etc/tvideo.env` und muss
  `bash -n` bestehen.
- **Licht fehlt:** Hat die Firmware keine passende Lichtanimation, wechselt nur
  das Video.
- **Fehler:** Jeder Fehler stellt den Werkszustand her.
- **Originale:** Kopien entstehen immer aus den Originalen. Dafür dient die
  Sicherung, die CoilShift beim Overlay anlegt, oder die Zieldatei, wenn kein
  Overlay liegt.

## Testen im Auto

1. In CoilShift unter **Repositories** „Welcome-Animation Performance“
   installieren.
2. Aussteigen und die Türen schließen. CoilShift startet dann den Touchscreen
   neu, damit QtCar das neue Licht liest.
3. Warten, bis der Bildschirm aus ist, dann einsteigen: Performance-Video und
   blaues Pulsieren.
4. Der Paketstatus sagt, was gilt, etwa „Performance-Animation mit
   Ambientelicht ab dem nächsten Einsteigen. Das Licht wechselt nach dem
   nächsten Neustart des Touchscreens.“

## Entwicklung und Validierungsstand

`python3 -m unittest tests.test_welcome_animation` testet beide Pakete mit
Bash 3.2 in einem Fake-Root gegen einen nachgebauten CoilShift-Daemon. Am Auto
(Model Y, 2026.32.7) ist die Auswahl nur lesend durchgespielt. Was noch offen
ist, steht in der [Validierung](../../docs/welcome-animation-validation.md).
