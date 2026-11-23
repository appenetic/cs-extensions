# Welcome-Animation: Validierung, 2026-11-23

Version `0.1.0-alpha.1`. Untersucht offline an der Firmware `2026.38.5.12` und
nur lesend am Auto des Nutzers (Model Y, Firmware `2026.32.7`, geparkt, per SSH).

## Video

- **Dienste:** `/etc/sv/vehicle-intro/run` und `/etc/sv/vehicle-intro-1/run`.
  Beide lesen `/etc/tvideo.env` und spielen
  `vehicle-intro${FILE_SUFFIX}.mp4` bzw. `…-1.mp4` mit `tvideo`. Laut
  `sv status` liefen beide am 2026-11-23 beim Einsteigen.
- **Auswahl in `tvideo.env`:** `lv` liest
  `com.tesla.Debug.get_data_value`. Ergebnis ist `-launch`, wenn
  `VAPI_vehicleBadging` auf `LaunchSeries` endet, sonst `-perf`, wenn
  `VAPI_performancePackage` `Performance` ist.
- **Skalierung:** Auf 2026.32.7 ist das Launch-Video 1920×1200, und
  `tvideo.env` setzt dafür den Skalierungsfaktor des Displays (1,0). Die anderen
  Videos sind 2560×1600 und laufen mit 0,75. Auf 2026.38.5.12 ist das
  Launch-Video 2560×1600, ohne Sonderfall. Deshalb tauscht das Paket nicht die
  Videodatei, sondern lässt `tvideo.env` wählen.
- **Werte am Auto:** `VAPI_vehicleBadging` = `Base`,
  `VAPI_performancePackage` = `Base`, `GUI_displayVehicleIntro` = `true`.
- **Videos am Auto:**

  | Datei | Format | Länge | Ton |
  | --- | --- | --- | --- |
  | `vehicle-intro.mp4` | 2560×1600, 60 fps | 4,00 s | AAC Stereo |
  | `vehicle-intro-1.mp4` | 1280×720 | 4,00 s | keiner |
  | `vehicle-intro-perf.mp4` | 2560×1600 | 4,03 s | keiner |
  | `vehicle-intro-perf-1.mp4` | 1280×720 | 4,03 s | keiner |
  | `vehicle-intro-launch.mp4` | 1920×1200, 60 fps | 3,42 s | keiner |

- **Weitere Nutzer von `tvideo.env`:** camp-mode, camp-mode-holiday, dog-mode,
  fireplace, sentry-pulse, starfield, tron-mode. `FILE_SUFFIX` verwenden nur
  die beiden Intro-Dienste.
- **Trockenlauf am Auto:** Die Bibliothek des Pakets lief gegen die echten
  Dateien, mit `sv` abgeschaltet und nur nach stdout. Beide Startskripte
  bestehen `bash -n` und haben je drei Zeilen mehr. Danach ist `lv` wieder das
  Programm `/usr/local/bin/lv`.

  | Wahl | `FILE_SUFFIX` | Faktor | zweites Display |
  | --- | --- | --- | --- |
  | Ab Werk / Standard | leer | 0,75 | `vehicle-intro-1.mp4` |
  | Performance | `-perf` | 0,75 | `vehicle-intro-perf-1.mp4` |
  | Launch Series | `-launch` | 1,0 | keins |

## Ambientelicht

- **Lichtanimationen:** `/usr/tesla/UI/assets/AmbientLightsAnimation.json`
  enthält am Auto 32 Animationen, darunter `preWelcome`, `welcome` (4 Frames,
  deine Farbe), `welcomePerf` (22 Frames, Blau `22,114,255` mit Blitzen
  `178,226,255`, ab 3,05 s deine Farbe) und `welcomeLS` (15 Frames, rot-weiß-orange).
- **Laden:** `libQtCarGUI` von 2026.32.7 lag am Auto als SSP-Bind mit
  Byte-Patches, SHA-256 `684a90ef…`. Disassembliert mit `llvm-objdump`, die
  PLT-Ziele über die GOT-Relokationen aufgelöst. Die Datei wird im Konstruktor
  von `AnimationConfigManager` gelesen, einem Singleton, also einmal je
  QtCar-Start.
- **Auswahl:** `AmbientLightsManager::updateAnimation()` prüft
  `GUI_splashVideoActivelyPlaying`. Dann wählt sie `welcomePerf`, wenn
  `VehicleUtils::isBayberryPerf()` stimmt. `welcomeLS` braucht
  `VAPI_carType`/`VAPI_vehicleBadging` eines Launch-Series-Autos, sonst gilt
  `welcome`. Die Namen sind Config-Werte (`rgb/welcome_animation`,
  `rgb/welcomePerf_animation`, `rgb/welcomeLS_animation`) mit diesen Vorgaben.
  Dieser Weg wird nicht genutzt.
- **Trockenlauf mit jq 1.8.1 am Auto:** Nach dem Umbau tragen `welcome`,
  `welcomePerf` und `welcomeLS` je die Frames der Wahl. `preWelcome` und die
  übrigen Animationen sind unverändert, weiterhin 32.
- **Neustart:** Für das Licht braucht es einen Neustart des Touchscreens. Das
  Paket fordert ihn wie `dev.coilshift.ct-ui` mit
  `POST /v1/restarts {"target":"ui","parked":true}` an, aber nur, wenn sich
  die Datei gerade geändert hat und `pidof QtCar` läuft. CoilShift hält solche
  Neustarts zurück, bis das Auto in P ist und der Fahrer ausgestiegen ist, oder
  bis „Apply now“.

## Paket und CoilShift

- **Overlay-Route:** `PUT/DELETE /v1/overlays/<name>` mit `target` und
  `source`. CoilShift sichert dabei das Original unter
  `$CSDK_STATE/overlays/<name>/pristine`. So zu sehen in den Ledgern von
  `dev.coilshift.no-tesla-wifi` und `dev.coilshift.fix-sentry-drive`.
  `dev.coilshift.no-elon` legt auf dieselbe Art Kopien über `/etc/sv/*/run`.
- **Werkzeuge am Auto:** BusyBox 1.37 (`awk`, `cmp`, `pidof`), `jq` 1.8.1,
  Bash 3.2.57.
- **Automatische Tests:** `tests/test_welcome_animation.py`, 14 Tests mit
  `/bin/bash` 3.2 gegen einen nachgebauten Daemon:
  - Werkszustand ohne Einstellung, Performance mit Licht und Neustart
  - erneutes Anwenden ohne Neustart, Wechsel über die Originalsicherung und
    ohne sie
  - zurück zu Ab Werk (byte-gleich), Licht aus, kein Neustart ohne QtCar
  - andere Firmware-Logik, fehlendes Video, Firmware ohne Lichtanimation
  - abgelehntes Overlay, zwei `tvideo.env`-Zeilen, Entfernen mit und ohne Licht

  Absichtlich eingebaute Fehler fallen auf: falscher Wert, fehlendes `unset`,
  nur ein Licht-Eintrag, kein Neustart, Dateirechte 0600.

## Am Auto offen

1. Installation über den Feed und ob CoilShift `overlay` auf
   `/etc/sv/vehicle-intro*/run` und die JSON annimmt. Das Muster ist von
   anderen Paketen belegt, für diese Ziele aber noch nicht.
2. Ob das Performance- und das Launch-Video beim Einsteigen laufen und den
   Bildschirm füllen.
3. Ob QtCar mit dem kürzeren Launch-Video (3,42 s statt 4,00 s) sauber
   ausblendet.
4. Ob nach dem Neustart das Licht `welcomePerf`/`welcomeLS` läuft und danach
   wieder deine Farbe gilt.
5. Was nach einem Neustart der MCU passiert. Die Overlays gelten je Boot, und
   CoilShift wendet das Paket neu an. Läuft QtCar dann schon, folgt ein
   Neustart des Touchscreens. Ist `dev.coilshift.ct-ui` installiert, fordert es
   ihn ohnehin an.
