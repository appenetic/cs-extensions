# Welcome-Animation für CoilShift

Experimentelles SDK-1.0-Paket. Beim Einsteigen spielt die MCU auf Wunsch die
Welcome-Animation eines Performance- oder eines Launch-Series-Autos, dazu deren
Ambientelicht. Das Paket ändert nur, welches Video und welche Lichtanimation
die Firmware für das Intro wählt. Am Fahrzeug wird kein Wert geschrieben: Auto,
App und Tesla sehen weiter die echte Ausstattung.

## Einstellungen

| Einstellung | Werte | Wirkung |
| --- | --- | --- |
| Welcome-Animation | Ab Werk (voreingestellt), Standard, Performance, Launch Series | Ab Werk lässt die Firmware wählen und nimmt alle Overlays zurück. Standard erzwingt die normale Animation auch bei einem Performance- oder Launch-Series-Auto. |
| Ambientelicht passend zur Animation | an (voreingestellt) / aus | Performance: blaues Pulsieren mit hellen Blitzen, danach deine Farbe. Launch Series: eine rot-weiß-orange Welle von hinten nach vorn. Standard: deine Farbe, von vorn nach hinten. |

Installiert ändert das Paket noch nichts. Erst die Wahl in den Einstellungen
wirkt:
- **Video:** ab dem nächsten Intro, also wenn der Bildschirm beim Einsteigen
  angeht.
- **Licht:** QtCar liest die Lichtanimationen nur beim Start. Ändert sich die
  Datei, bittet das Paket CoilShift um einen Neustart des Touchscreens.
  CoilShift wartet damit, bis du in P bist und aussteigst. „Apply now“ in
  CoilShift startet ihn sofort.

## So funktioniert es

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
rund um `. /etc/tvideo.env`: Eine Funktion `lv` beantwortet genau diese beiden
DataValues so wie bei einem Auto der gewählten Art. Danach nimmt
`unset -f lv` sie wieder weg. Alle anderen `lv`-Aufrufe gehen weiter ans Auto.
So entscheidet die Firmware selbst über Video, Skalierung und zweites Display:

| Wahl | `VAPI_vehicleBadging` | `VAPI_performancePackage` | Video (2026.32.7) |
| --- | --- | --- | --- |
| Standard | `Base` | `Base` | `vehicle-intro.mp4`, 2560×1600, ×0,75, mit Ton; dazu `vehicle-intro-1.mp4` |
| Performance | `Base` | `Performance` | `vehicle-intro-perf.mp4`, 2560×1600, ×0,75, ohne Ton; dazu `vehicle-intro-perf-1.mp4` |
| Launch Series | `LaunchSeries` | `Base` | `vehicle-intro-launch.mp4`, 1920×1200, ×1,0, ohne Ton; kein Video auf dem zweiten Display |

`/etc/tvideo.env` selbst bleibt unberührt. Sie wird auch von Camp-, Dog-,
Sentry-, Kamin- und Tron-Modus gelesen.

**Licht.** QtCar (`AmbientLightsManager::updateAnimation`) nimmt während des
Intro-Videos (`GUI_splashVideoActivelyPlaying`) die Animation `welcomePerf`
nur bei `VehicleUtils::isBayberryPerf()`. Bayberry ist das Model Y ab 2025.
`welcomeLS` gilt nur bei Launch-Series-Badging, sonst `welcome`. Die Frames
stehen in `/usr/tesla/UI/assets/AmbientLightsAnimation.json`. Das Paket legt
eine Kopie darüber, in der `welcome`, `welcomePerf` und `welcomeLS` alle die
Frames der gewählten Animation tragen. Die übrigen Animationen (Sentry, Alarm,
Light Show …) bleiben, wie sie sind.

**Sicherungen.**
- **Andere Firmware:** Prüft `tvideo.env` anders oder fehlt das Video, ändert
  das Paket nichts und meldet „unsupported“.
- **Startskript:** Es braucht genau eine Zeile `. /etc/tvideo.env` und muss
  `bash -n` bestehen.
- **Licht fehlt:** Hat die Firmware keine passende Lichtanimation, bleibt das
  Licht ab Werk, das Video wechselt trotzdem.
- **Fehler:** Jeder Fehler stellt den Werkszustand her.
- **Originale:** Kopien entstehen immer aus den Originalen. Dafür dient die
  Sicherung, die CoilShift beim Overlay anlegt, oder die Zieldatei, wenn kein
  Overlay liegt.

**Entfernen.** CoilShift nimmt die Overlays zurück. Lag das Licht-Overlay,
folgt der Neustart des Touchscreens wie oben.

## Testen im Auto

1. In CoilShift **Performance** wählen, Ambientelicht an.
2. Aussteigen und die Türen schließen. CoilShift startet dann den Touchscreen
   neu, damit QtCar das neue Licht liest.
3. Warten, bis der Bildschirm aus ist, dann einsteigen: Performance-Video und
   blaues Pulsieren.
4. Zurück mit **Ab Werk**.

Der Paketstatus in CoilShift sagt, was gilt, etwa „Performance mit
Ambientelicht ab dem nächsten Einsteigen. Das Licht wechselt nach dem nächsten
Neustart des Touchscreens.“

## Entwicklung und Validierungsstand

`python3 -m unittest tests.test_welcome_animation` testet die Hooks mit Bash
3.2 in einem Fake-Root gegen einen nachgebauten CoilShift-Daemon. Am Auto
(Model Y, 2026.32.7) ist die Auswahl nur lesend durchgespielt. Was am Auto noch
offen ist, steht in der [Validierung](../../docs/welcome-animation-validation.md).
