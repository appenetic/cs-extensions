# Quiet-Ansicht für CoilShift

Experimentelles SDK-1.0-Paket nach dem Vorbild des „Quiet Mode“ von FSD v15.
Es bringt eine App mit der Kachel **Quiet** in den Launcher. Sie öffnet sich
direkt maximiert und ohne Titelleiste, auch in D. Zu sehen ist ein dunkler
Bildschirm mit einem Lichtschein in der Farbe deines Ambientelichts: oben ein
weicher, atmender Schein, unten eine Straße bei Nacht, deren zwei Fahrbahnlinien
feine Lichtfäden sind, die im Dunst verschwinden. Auf ihnen fließen
Lichtstreifen zu dir hin, so schnell wie die Straße, bei hohem Tempo gebremst;
im Stand stehen sie.
Die beiden Linien zeigen die Bahn, die das Auto beim gerade eingeschlagenen
Lenkwinkel fahren würde, wie die Hilfslinien einer Rückfahrkamera: leicht
gelenkt eine sanfte Kurve, voll eingeschlagen ein enger Bogen zur Seite. Blinkst du, leuchtet die Linie auf dieser Seite im Takt auf.
Statt der feinen Linien kann die Bahn auch aussehen wie auf den Fotos des
Originals: zwei breite, weiche Lichtbahnen auf dem Boden, durch deren Herz die
Lichtstreifen als weiche Pulse laufen. Die nasse Straße spiegelt den Schein.
Dahinter stehen schematisch die Gebäude rund um das Auto, aus OpenStreetMap:
dunkles Glas mit weichen Lichtkanten in der Farbe des Scheins, das zum Boden
hin im Dunst verschwimmt. Sie blenden ab 40 m ein und lösen sich gegen 400 m
im Dunst auf.

Ruhig darüber, in Teslas eigener Schrift: oben links der Tacho und daneben die
nächste Abbiegung als Pfeil mit Entfernung („200 m“, darunter „rechts“), über
dem Horizont wie im Original die Ankunftszeit, darunter eine feine Linie mit
einem Lichtpunkt für den Fortschritt der Route und Restzeit und Reststrecke.
Was kommt und geht, blendet weich ein und aus; beim Öffnen erwacht das Bild aus
dem Schwarz und die Bahn wächst vom Auto zum Horizont. Eine neue Farbe, etwa
beim nächsten Song, breitet sich als Welle vom Horizont her aus. Fest nach
unten wischen schließt die App, lange drücken öffnet die Optionen.

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
Abbiegehinweise, Tacho, Lichtstreifen und Gebäude an oder aus, die Lichtbahn
Fein oder Weich, Helligkeit Auto, Hell oder Gedämpft. Der Dienst hebt die Wahl
in `CSDK_STATE/options.json` auf; was eine ältere Version dort ablegte, gilt
weiter, Neues beginnt mit seinem Standard (Lichtbahn Fein).

## Gebäude

Die Gebäude kommen als Vektorkacheln von [OpenFreeMap](https://openfreemap.org)
(OpenMapTiles-Schema, Zoomstufe 14, frei und ohne Schlüssel): Grundriss, Höhe
und Sockelhöhe aus OpenStreetMap. Wo dort keine Höhe steht, setzt OpenMapTiles
eine eigene an. Der Dienst lädt nur, solange die App offen und die Option an
ist, die Kacheln im Umkreis von 450 m um das Auto (meist ein bis zwei von
1,5 km Kantenlänge). Neue Kacheln kosten je etwa 0,3 bis 0,6 MB über das Netz
des Autos. Die letzten zwölf hebt er komprimiert in `CSDK_STATE/tiles` auf.

- **Position:** QtCar schwärzt `NAV_vehicleLatitude` und `NAV_vehicleLongitude`
  auch über D-Bus. Die Nur-Lese-Methode
  `com.tesla.SensitiveDataValues.get_LOC_geoLocation` liefert die Position aber,
  wie das Home-Assistant-Paket sie liest. Der Dienst fragt sie zweimal pro
  Sekunde ab, den Kurs (`LOC_estimatedHdg`) und das Tempo fünfmal.
- **Datenschutz:** Seite, Stream und Gebäude kennen nur Meter östlich und
  nördlich des ersten Standorts der Sitzung, nie den Ort selbst. Ins Log und
  nach `turns.log` kommt keine Position. OpenFreeMap (über Cloudflare) sieht,
  welche Kacheln das Auto lädt, also seine Gegend auf etwa 1,5 km genau.
  Öffentliche DNS-Server (1.1.1.1, 9.9.9.9, 8.8.8.8) sehen den Namen
  `tiles.openfreemap.org`, denn das Netz des Dienstes hat keinen eigenen
  DNS-Server. Wer das nicht will, schaltet die Gebäude im Menü aus.
- **Lizenz:** Solange Gebäude zu sehen sind, steht unten rechts klein
  „OpenFreeMap · © OpenMapTiles · © OpenStreetMap-Mitwirkende“.
- **Bewegung:** Zwischen zwei Positionen fährt die Seite mit dem Tempo weiter und
  dreht mit dem Kurs, wie schnell er sich zuletzt drehte. Neue Positionen
  gleitet sie über etwa 0,35 s an.

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
- **Lenkwinkel im Stand:** In P kann `VAPI_steeringAngle` `<invalid>` sein;
  dann bleibt die Bahn gerade. Der Dienst schreibt während der Fahrt
  Drehrate, Gierrate, Lenkwinkel, Tempo, Kurs, den Ort im Rahmen der Sitzung
  und wie oft Kurs und Position neu kamen in `CSDK_STATE/turns.log` (höchstens
  etwa 512 KB).

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
  nur, solange die Seite offen ist: Tacho, Übernahme, Hände-Mahnung und
  Seitenkollision als Streams, der Rest ein- bis zweimal pro Sekunde nacheinander.
- **Lenkwinkel direkt:** Die Streams liefern Änderungen nur etwa alle 1,6 s. Den
  Lenkwinkel liest der Dienst deshalb über eine eigene D-Bus-Verbindung
  20-mal pro Sekunde bei QtCar (`com.tesla.Debug.get_data_value`, derselbe
  Aufruf, den die Schnittstelle des Autos nutzt). Klappt das nicht, liest er
  ihn alle 100 ms über die Schnittstelle.
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
| Bahn | Nur `VAPI_steeringAngle`, rechts positiv (aus einer echten Fahrt bestimmt). Die Krümmung ist tan(Lenkwinkel / 10) / 2,89 m, also Lenkübersetzung etwa 10:1 und Radstand 2,89 m: 2° biegen die Bahn auf 60 m ein wenig, 180° auf einen Radius von etwa 9 m. Die Linien sind Kreisbögen 1,75 m innen und außen; sichtbar sind etwa 60 m, nie über die Umkehr hinaus. Unter 0,3° bleibt sie gerade. Der Dienst liest den Winkel 30-mal pro Sekunde direkt bei QtCar und gibt jeden neuen Wert sofort weiter; eine kritisch gedämpfte Feder auf der Seite trägt die Bahn ohne Stufen von Wert zu Wert, etwa 0,08 s hinter einem drehenden Lenkrad. Ohne gültigen Lenkwinkel läuft die Bahn gerade; Abbiegehinweise biegen sie nicht |
| Tempo | Die Lichtstreifen laufen langsam so schnell wie die Straße (1,3 m/s bei 5 km/h), darüber gebremst gegen 13 m/s (8,5 m/s bei 50 km/h, 12 m/s bei 120 km/h). Sie folgen dem Tempo über etwa 1,5 s und kommen im Stand ganz zum Stehen |
| Blinker | `VAPI_turnSignalActive` im Takt von `AUDIO_turnSignalPeriodMs` |
| Gebäude | Position aus `com.tesla.SensitiveDataValues.get_LOC_geoLocation` (2-mal pro Sekunde), Kurs `LOC_estimatedHdg` und Tempo (5-mal), Gebäude aus OpenFreeMap-Kacheln im Umkreis von 450 m, neu ausgewählt alle 60 m |

Das Bild zeichnet ein WebGL-Shader in echter Perspektive: eine Kamera 1,25 m
über der Mitte einer 3,5 m breiten Spur, der Horizont auf 58 % der Höhe. Die
Linien haben einen fast weißen Kern, der mit der Entfernung feiner wird, und
einen Bloom in Bildschirmpixeln, gemessen am Gefälle der Linie selbst und auch
am Boden nur wenige Meter breit; ein Lichtstreifen leuchtet darin entlang der
Linie und wird mit dem Abstand weicher. Die Bahn ist ein Kreisbogen, nahe der
Geraden eine Parabel. Am Ende
stehen ein filmisches Tonemapping und feines Rauschen, damit dunkle Verläufe
keine Stufen zeigen. Rechnet die Grafik in Software oder dauern Bilder länger
als etwa 26 ms, zeichnet die Seite weniger Pixel. Ohne WebGL steht ein
schlichteres Canvas-Bild da. Farbe, Helligkeit, Bahn und Tempo gleiten weich
in ihre neuen Werte; eine neue Farbe, die weit von der alten liegt, wächst als
Front vom Fluchtpunkt aus über 1,8 s, kleine Schritte wie beim Regenbogen
gleiten einfach. In der weichen Lichtbahn ist jede Linie ein Band aus Licht auf
dem Boden, 0,8 m breit (Standardabweichung) um ein 0,3 m schmales Herz; weil
die Breite in Metern auf dem Boden gilt, verengt die Perspektive es von selbst.
Die weichen Bahnen verblassen früher als die Linien, damit sich ihr Licht dort,
wo die Straße nur noch wenige Pixel breit ist, nicht zu einem hellen Fleck
staut. Die Gebäude zeichnet ein zweiter Durchgang aus derselben
Kamera: Wände wie dunkles Glas, erst nur in die Tiefe, dann abgedunkelt, wo
jeweils die vorderste steht, damit hintereinander stehende Häuser nicht doppelt
dunkeln; Wände, die zur Kamera zeigen, etwas mehr als schräg gesehene, und zum
Boden hin heller im Dunst. Darüber Dachkanten und Ecken als schmale Bänder mit
weichem Profil, an jeder Neigung glatt statt pixelig, die Ecken zum Boden hin
schwächer. Alles blendet ab 40 m ein und ist vor dem Rand der Auswahl (450 m,
alle 60 m neu) verschwunden, damit dort nichts aufpoppt. Das Canvas-Bild zeigt
keine Gebäude.

Die Schrift ist die des Autos, Universal Sans in 300 und 500, Tacho und
Ankunftszeit mit gleich breiten Ziffern, damit nichts springt, wenn eine Zahl
wechselt; anderswo die Systemschrift. Der Pfeil der Abbiegung wird aus den
Worten des Dienstes gezeichnet: leicht, normal, scharf, wenden, Ausfahrt (mit
der weiterführenden Straße blass daneben), einfädeln, geradeaus, und im
Kreisverkehr der gefahrene Bogen um einen blassen Ring. Je näher die
Abbiegung, desto heller.

## Entwicklung und Validierungsstand

Der Go-Quelltext des Dienstes liegt wie der des Claude-Pakets privat unter
`services/quiet-view/` mit seinen Tests; veröffentlicht wird nur das Binary.
`tools/build-quiet-view.sh` baut es. `python3 -m unittest tests.test_quiet_view`
testet Kachel und Hooks mit Bash 3.2 unter `umask 077` gegen einen nachgebauten
Daemon. Was am Auto geprüft ist, steht in der
[Validierung](../../docs/quiet-view-validation.md).
