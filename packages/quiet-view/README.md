# Quiet-Ansicht für CoilShift

Experimentelles SDK-1.0-Paket nach dem Vorbild des „Quiet Mode“ von FSD v15.
Es bringt eine App mit der Kachel **Quiet** in den Launcher. Sie öffnet sich
direkt maximiert und ohne Titelleiste, auch in D. Zu sehen ist ein dunkler
Bildschirm mit einem Lichtschein in der Farbe deines Ambientelichts: oben ein
weicher, atmender Schein, unten eine Straße bei Nacht, deren zwei Fahrbahnlinien
feine Lichtfäden sind, die im Dunst verschwinden. Auf ihnen fließen
Lichtstreifen zu dir hin, im Stand langsam, schneller, je schneller du fährst.
Die Straße biegt sich mit dem Lenkrad: lenkst du nach links, nach links, und
umso stärker, je weiter du lenkst. Blinkst du, leuchtet die Linie auf dieser Seite im Takt auf.

Ruhig darüber: oben links der Tacho, in der Mitte Ankunftszeit, Restzeit,
Reststrecke und die nächste Abbiegung („in 200 m rechts“), unten eine Linie für
den Fortschritt der Route. Ab 300 m vor der Abbiegung biegt sich die Straße
schon in ihre Richtung. Fest nach unten wischen schließt die App,
lange drücken öffnet die Optionen.

## Angekommen

Am Ziel endet die Straße in einem Ring aus Licht, der langsam atmet; ab und zu
geht eine Lichtwelle von ihm aus, und die Lichtstreifen kommen zur Ruhe. Darüber
steht „Angekommen“ mit der Fahrt: „12,4 km in 18 min · 18:42“. Der Bildschirm
bleibt bis zu 10 Minuten, eine neue Route oder Weiterfahren über 20 km/h
beenden ihn.

QtCar meldet die Ankunft Paketen nicht (`NAV_arrivalInfoSnapshot` ist
`<invalid>`). Der Dienst erkennt sie selbst: Die Reststrecke fällt unter etwa
50 m, oder die Route endet, als zuletzt weniger als 400 m übrig waren. Eine
Route, die weit vor dem Ziel abbricht, ist keine Ankunft. Strecke und Dauer
zählt er ab Beginn der Route, auch bei geschlossener App. Die Uhrzeit ist die
letzte Ankunftszeit der Navigation, denn die Uhr der MCU läuft in einer anderen
Zeitzone als die Anzeige im Auto.

## Optionen

Pakete aus einem Repository bekommen in CoilShift keine Einstellungen. Ein
langer Druck in der App öffnet deshalb ein Menü: Ankunftszeit und Fortschritt,
Abbiegehinweise, Tacho und Lichtstreifen an oder aus, Helligkeit Auto, Hell oder
Gedämpft. Der Dienst hebt die Wahl in `CSDK_STATE/options.json` auf.

## Sicherheit

- **Tacho:** Auf dem Model Y gibt es nur diesen Bildschirm, das maximierte
  Fenster verdeckt die Geschwindigkeitsanzeige. Die App zeigt deshalb
  `VAPI_displaySpeed`, die Zahl des Tachos, in seiner Einheit.
- **Warnungen:** Beginnt bei offener App eine Warnung, schließt der Dienst sie
  über QtCars `dismissApp`. Das gilt für eine Übernahme-Aufforderung
  (`GUI_centerDisplayTakeOverNow`), eine Hände-am-Lenkrad-Mahnung, die der
  Bildschirm zeigt oder mit Ton meldet (`DAS_autopilotHandsOnState`), eine
  Kollisionswarnung (`DAS_sideCollisionWarning`, `DAS_longCollisionWarning`)
  und den Rückwärtsgang. Was ein Wert beim Öffnen schon zeigt, gilt als
  Ausgangslage. So kann ein unerwarteter Normalwert die App nicht immer wieder
  schließen. Jeder Auslöser steht mit seinem Wert im Paketlog.

## Grenzen

- **Start per Kachel:** QtCar startet eine App von außen nur, wenn eine App auf
  dem Bildschirm das anfordert. Die Quiet-Ansicht öffnest du deshalb über ihre
  Kachel.
- **Kein Zielname:** QtCar schwärzt das Ziel, die Richtung der nächsten
  Abbiegung (`NAV_nextTurnDirection`) und ihren Straßennamen auf jedem Weg, den
  ein Paket lesen kann, auch direkt über D-Bus. Den Winkel der Abbiegung
  (`NAV_nextTurnAngle`) schwärzt es nicht; daraus kommt die Richtung.
- **Ungeprüfte Werte:** Wie die Firmware Blinker und Warnstufen schreibt, war am
  Auto noch nicht zu sehen. Das Paket erkennt sie an Wörtern (`left`, `right`,
  `both`, `visual`, `chime`, `slow`, `struck`, `escalat`).
- **Lenkwinkel im Stand:** In P ist `VAPI_steeringAngle` `<invalid>`; dann
  folgt die Straße der Änderung der Fahrtrichtung, die im Stand null ist. Der
  Dienst schreibt während der Fahrt Drehrate, Gierrate und Lenkwinkel in
  `CSDK_STATE/turns.log` (höchstens etwa 512 KB).

## So funktioniert es

- **Kachel:** Der `apply`-Hook (`lib/quiet.sh`) schreibt die Kachel-Definition
  selbst (`config`, `webapp.json`, Symbol) und installiert sie über
  `PUT /v1/tiles/app`. Gegenüber der Kachel, die CoilShift aus dem Manifest
  baut, setzt sie `appWindowDefaultOpensToMaximized`, `appWindowIsMaximizedOnly`,
  `canMaximizeAppWindow` und `allowInDrive` und blendet die Titelleiste aus.
  Der Ledger nimmt sie beim Deinstallieren zurück.
- **Dienst `web`:** ein Go-Programm (`bin/quiet-linux-amd64`), das `web.sh`
  ins ausführbare `CSDK_RUN` kopiert und startet. Es öffnet den Web-Port in
  jedem Netz-Namespace eines Browsers, auch in denen, die ein App-Fenster erst
  beim Start bekommt, und antwortet nur `127.0.0.1` oder `localhost` auf
  diesem Port. Die Seite bekommt die Daten als Server-Sent Events
  (`/events`), `/state` springt ein, solange der Strom fehlt.
- **Sparsam lesen:** Der Daemon protokolliert jeden Aufruf und erlaubt einem
  Paket 8 gleichzeitige Aufrufe und 4 Streams. Der Dienst liest das Auto deshalb
  nur, solange die Seite offen ist: Lenkwinkel, Tacho, Übernahme und
  Hände-Mahnung als Streams, der Rest ein- bis zweimal pro Sekunde nacheinander.
  Geschlossen liest er alle 15 s nur die Reststrecke, damit die
  Fortschrittslinie weiß, wo die Route begann.
- **Fenster:** Die Seite meldet sich beim Öffnen mit `POST /window/max` und
  beim Wischen mit `POST /window/close`. Der Dienst ruft dann QtCars
  `maximizeAppWindow`/`setWebAppDismissGestureEnabled` oder `dismissApp` über
  D-Bus auf, mit dem Titel der App. Fenster und Optionen ändern nur Anfragen mit
  dem Header `X-Quiet`.

| Anzeige | Quelle |
| --- | --- |
| Farbe | `red`, `green`, `blue` aus `GUI_rgbMap`, was QtCar an die Ambientelichter schickt. Ohne sie `GUI_rgbAlbumColor`, wenn `GUI_rgbSyncAlbumArtColor` an ist, sonst `GUI_rgbColor` |
| Helligkeit | `brightness` aus `GUI_rgbMap` (0 bis 100), heller bei Tag (`GUI_dayMode`), dazu die Wahl im Menü |
| Tacho | `VAPI_displaySpeed` in `VAPI_speedUnits` (KPH, MPH) |
| Ankunft | `GUI_navNextDestinationArrivalTime`, wenn `GUI_navNextDestinationArrivalInfoValid`; `NAV_minutesToArrival`; `NAV_milesToArrival` in den Einheiten des Autos (`GUI_distanceUnits`) |
| Fortschritt | Reststrecke gegen die längste seit Beginn der Route; wächst sie um mehr als ein Zehntel und eine halbe Meile, ist es eine neue Route |
| Abbiegung | `NAV_milesToNextTurn` ab 1,5 km, die Richtung aus `NAV_nextTurnAngle` im Uhrzeigersinn ab geradeaus (99 war rechts): unter 12° keine Abbiegung, bis 45° leicht, bis 135° normal, bis 165° scharf, darüber wenden. Ohne Winkel nur „Abbiegen in …“ |
| Kurve | `VAPI_steeringAngle`, rechts positiv (aus einer echten Fahrt bestimmt): bis wenige Grad wie die echte Krümmung (2° biegt leicht), darüber logarithmisch bis etwa 240°, unter 0,5° gerade. Der Dienst gibt ihn spätestens nach 50 ms weiter, die Seite glättet nur über 0,1 s. Ohne gültigen Lenkwinkel die Änderung von `LOC_estimatedHdg` über eine Sekunde |
| Tempo | Ein Lichtstreifen braucht im Stand etwa 6 s vom Horizont bis zu dir, ab 120 km/h etwa 2 s, dazwischen mit der Wurzel der Geschwindigkeit |
| Blinker | `VAPI_turnSignalActive` im Takt von `AUDIO_turnSignalPeriodMs` |

Das Bild zeichnet ein WebGL-Shader in echter Perspektive: eine Kamera 1,25 m
über der Mitte einer 3,5 m breiten Spur, der Horizont auf 58 % der Höhe. Die
Linien haben einen fast weißen Kern, der mit der Entfernung feiner wird, und
einen Bloom in Bildschirmpixeln; die Kurve ist eine Krümmung der Straße. Am Ende
stehen ein filmisches Tonemapping und feines Rauschen, damit dunkle Verläufe
keine Stufen zeigen. Rechnet die Grafik in Software oder dauern Bilder länger
als etwa 26 ms, zeichnet die Seite weniger Pixel. Ohne WebGL steht ein
schlichteres Canvas-Bild da. Farbe, Helligkeit, Biegung und Tempo gleiten weich
in ihre neuen Werte.

## Entwicklung und Validierungsstand

Der Go-Quelltext des Dienstes liegt wie der des Claude-Pakets privat unter
`services/quiet-view/` mit seinen Tests; veröffentlicht wird nur das Binary.
`tools/build-quiet-view.sh` baut es. `python3 -m unittest tests.test_quiet_view`
testet Kachel und Hooks mit Bash 3.2 unter `umask 077` gegen einen nachgebauten
Daemon. Was am Auto geprüft ist, steht in der
[Validierung](../../docs/quiet-view-validation.md).
