# Quiet-Ansicht für CoilShift

Experimentelles SDK-1.0-Paket nach dem Vorbild des „Quiet Mode“ von FSD v15.
Es bringt eine App mit der Kachel **Quiet** in den Launcher. Sie öffnet sich
direkt maximiert und ohne Titelleiste, auch in D. Zu sehen sind die Straßen und
Häuser rund um das Auto aus OpenStreetMap, aus der Höhe eines Fahrers, unter
einem weichen, atmenden Schein in der Farbe deines Ambientelichts. Die Straße,
auf der du fährst, leuchtet in dieser Farbe voraus, über ihre ganze Breite und
bis etwa 400 m weit, wohin sie weiterführt: geradeaus, und an der nächsten
Abbiegung der Navigation in deren Richtung. Lange, leise Lichtwellen laufen in
deinem Tempo darauf zu dir hin; blinkst du, leuchtet ihr Rand auf dieser Seite
im Takt heller. Im Profil Mad Max gleiten weiche Pfeile aus Licht vor dem Auto
her. Die anderen Straßen liegen dunkel daneben, ihre Ränder feine Linien des
Lichts. Die Häuser stehen mit ihren echten Höhen als helle Körper da, ein festes
Licht von Westnordwest fällt seitlich auf ihre Fronten, ihre Dachkanten sind
feine Lichtlinien. Direkt neben dem Auto dunkeln sie zur Silhouette ab, in der
Ferne lösen sie sich im Dunst auf statt im Schwarz; Bauwerke ab 60 m wie ein
Fernsehturm bleiben bis 2,6 km sichtbar, soweit die geladenen Kacheln reichen.
Beim Öffnen wachsen die Häuser aus dem Boden.

Ruhig darüber, in der Schrift des Autos: oben links der Tacho, darunter das
Self-Driving-Profil mit Teslas Namen (Faultier, Lässig, Standard, Sportlich,
Mad Max), daneben die nächste Abbiegung als Pfeil mit Entfernung („200 m“,
darunter „rechts“), über dem Horizont wie im Original die Ankunftszeit,
darunter eine feine Linie mit einem Lichtpunkt für den Fortschritt der Route
und Restzeit und Reststrecke. Was kommt und geht, blendet weich ein und aus;
beim Öffnen erwacht das Bild aus dem Schwarz und die Straße leuchtet vom Auto
aus auf. Eine neue Farbe, etwa beim nächsten Song, blendet ruhig über das ganze
Bild, in 2,4 s. Fest nach unten wischen schließt die App, lange drücken öffnet
die Optionen.

Zeigt das Auto mit „Cybertruck UI“ aus CoilShift die Schrift des Cybertrucks,
tut das auch die App: Blender-TSL für alle Texte, im Tacho die Ziffern
„CT_speed“ des Cybertruck-Tachos. Sonst bleibt es Teslas Universal Sans.

Bis alpha.30 zeigte die App statt der Straßen zwei Lichtlinien für den
Lenkwinkel, dazu einen Stil Neon mit Sonne; beides ist mit alpha.31 entfallen.

## Angekommen

Am Ziel liegt 26 m voraus ein Ring aus Licht auf der Straße, der langsam
atmet; ab und zu geht eine Lichtwelle von ihm aus, und das Leuchten der Straße
voraus erlischt. Darüber
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
Abbiegehinweise, Tacho, Lichtstreifen sowie Straßen und Gebäude an oder aus,
die Blickhöhe Straße (1,6 m, Standard), Erhöht (4 m) oder Hoch (9 m),
Helligkeit Auto, Hell oder Gedämpft. Der Dienst hebt die Wahl in
`CSDK_STATE/options.json` auf; was eine ältere Version dort ablegte, gilt
weiter, Neues beginnt mit seinem Standard, und die Lichtbahn und der Stil von
bis alpha.30 fallen weg.

## Sprache

Die App spricht die Sprache des Autos (`GUI_locale`): Deutsch, wenn das Auto
auf Deutsch steht, sonst Englisch. Die Ankunftszeit folgt der 12- oder
24-Stunden-Uhr des Autos (`GUI_24hourTime`). Im Feed heißt das Paket
„Quiet View“.

## Straßen und Gebäude

Straßen und Gebäude kommen als Vektorkacheln von
[OpenFreeMap](https://openfreemap.org) (OpenMapTiles-Schema, Zoomstufe 14, frei
und ohne Schlüssel): Grundriss, Höhe und Sockelhöhe der Gebäude, die Straßen
mit ihrer Art und ob sie Einbahnstraßen sind, aus OpenStreetMap. Wo keine Höhe
steht, setzt OpenMapTiles eine eigene an. Gezeichnet werden Autobahnen,
Schnellstraßen, Haupt-, Neben- und Wohnstraßen und Zufahrten, so breit wie ihre
Art (von der Mitte bis zum Rand 7 m bis 2,2 m, eine Fahrbahn einer Einbahnstraße
ein Viertel schmaler); Tunnel, Fußwege, Gleise und Fähren nicht. Der Dienst lädt nur, solange die App offen und die Option an
ist, die Kacheln im Umkreis von 450 m um das Auto (meist ein bis zwei von
1,5 km Kantenlänge). Neue Kacheln kosten je etwa 0,3 bis 0,6 MB über das Netz
des Autos. Die letzten zwölf hebt er komprimiert in `CSDK_STATE/tiles` auf.

- **Position:** QtCar schwärzt `NAV_vehicleLatitude` und `NAV_vehicleLongitude`
  auch über D-Bus. Die Nur-Lese-Methode
  `com.tesla.SensitiveDataValues.get_LOC_geoLocation` liefert die Position aber,
  wie das Home-Assistant-Paket sie liest. Der Dienst fragt sie sechsmal pro
  Sekunde ab, den Kurs (`LOC_estimatedHdg`) und das Tempo fünfmal. Das Auto
  erneuert Position und Kurs nur etwa einmal pro Sekunde; so fällt eine neue
  Position nach höchstens 0,17 s auf. Jede neue Position trägt eine Nummer.
- **Datenschutz:** Seite, Stream und Gebäude kennen nur Meter östlich und
  nördlich des ersten Standorts der Sitzung, nie den Ort selbst. Ins Log und
  nach `turns.log` kommt keine Position. OpenFreeMap (über Cloudflare) sieht,
  welche Kacheln das Auto lädt, also seine Gegend auf etwa 1,5 km genau.
  Öffentliche DNS-Server (1.1.1.1, 9.9.9.9, 8.8.8.8) sehen den Namen
  `tiles.openfreemap.org`, denn das Netz des Dienstes hat keinen eigenen
  DNS-Server. Wer das nicht will, schaltet die Gebäude im Menü aus.
- **Lizenz:** Solange Straßen oder Gebäude zu sehen sind, steht unten rechts
  klein „Karte: OpenFreeMap · © OpenMapTiles · © OpenStreetMap-Mitwirkende“.
- **Die eigene Straße:** Die Seite sucht zehnmal pro Sekunde die Straße des
  Autos: unter den Stücken bis 15 m entfernt, deren Richtung höchstens 35° von
  seiner abweicht (Einbahnstraßen nur in ihrer Richtung), das nächste. Die
  bisherige bleibt, solange das Auto bis 10 m neben ihrem Rand und 50° von ihrer
  Richtung bleibt. Die Kamera rückt über etwa eine halbe Sekunde seitlich auf
  ihre Mitte und dreht sich in ihre Richtung, denn GPS legt das Auto oft ein
  paar Meter daneben. Von dort folgt das Leuchten ihrer Linie; wo sie endet oder
  andere sie treffen, geht es auf der weiter, die am geradesten weiterführt,
  nie gegen eine Einbahnstraße. An der Kreuzung, die der nächsten Abbiegung der
  Navigation am nächsten liegt (bis 30 m daneben), biegt es in die Straße, die
  höchstens 45° vom Winkel der Abbiegung abweicht. Tesla gibt die Route selbst
  nicht heraus; weiter als bis zur nächsten Abbiegung kennt die App sie nicht.
  Kommt alle 60 m eine neue Auswahl an Straßen, findet die Seite die Straße des
  Autos darin noch vor dem nächsten Bild wieder. Wo eine Straße von einer
  Kachel in die nächste läuft, schneidet jede Kachel sie für sich, und die
  Enden liegen oft ein paar Zentimeter auseinander; ein loses Ende geht in das
  nächste lose Ende bis 1 m daneben über. Bis alpha.32 ging das Leuchten
  deshalb mit jeder neuen Auswahl bis zu 100 ms aus, und an etwa jeder vierten
  Kachelgrenze endete es dort.
- **Bewegung:** Zwischen zwei Positionen fährt die Seite mit dem Tempo weiter
  und dreht so schnell, wie der Lenkwinkel es sagt: wie Radstand 2,89 m und
  Übersetzung 10:1, mal 0,65 (auf einer Fahrt in Berlin gegen den Kurs
  gemessen, Korrelation 0,91). Position und Kurs ziehen die Kamera nur über
  etwa eine Sekunde nach. Eine neue Position erkennt die Seite an ihrer
  Nummer, nicht an jeder Ansicht dazwischen. Bis alpha.29 hielt sie jede
  Ansicht für eine neue Position: Bei 50 km/h lief die Stadt dann im
  Sekundentakt zwischen 0,6 und 41 m/s, nach dem Fix zwischen 12 und 15 m/s
  (nachgerechnet mit dem Takt aus der Fahrt).

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
  dann dreht die Kamera zwischen zwei Kursen nicht mit. Der Dienst schreibt während der Fahrt
  Drehrate, Gierrate, Lenkwinkel, Tempo, Kurs, den Ort im Rahmen der Sitzung
  und wie oft Kurs und Position neu kamen in `CSDK_STATE/turns.log` (höchstens
  etwa 512 KB).

## So funktioniert es

- **Kachel:** Der `apply`-Hook (`lib/quiet.sh`) schreibt die Kachel-Definition
  selbst (`config`, `webapp.json`, Symbol) und installiert sie über
  `PUT /v1/tiles/app`. Gegenüber der Kachel, die CoilShift aus dem Manifest
  baut, setzt sie `appWindowDefaultOpensToMaximized`, `appWindowIsMaximizedOnly`,
  `canMaximizeAppWindow` und `allowInDrive` und blendet die Titelleiste aus.
  Der Ledger nimmt sie beim Deinstallieren zurück. Das Symbol ist gebaut wie
  Teslas eigene Launcher-Icons: 180 × 180 px, das Motiv auf den mittleren
  88 × 88 px mit etwa 11 px Ecken, der Rest transparent; größer wirkt es im
  Launcher neben ihnen bis zu doppelt so groß.
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
  Lenkwinkel, aus dem die Seite zwischen zwei Kursen die Drehung des Autos
  rechnet, liest der Dienst deshalb über eine eigene D-Bus-Verbindung
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
| Straße voraus | Die eigene Straße aus den Kacheln (siehe „Straßen und Gebäude“), an der nächsten Abbiegung mit `NAV_milesToNextTurn` und `NAV_nextTurnAngle` in deren Richtung |
| Self-Driving | `GUI_autopilotDrivingProfile` („Sloth“, „Chill“, „Standard“, „Hurry“, „Mad Max“), mit Teslas Namen in der Sprache des Autos (Faultier, Lässig, Standard, Sportlich, Mad Max) |
| Tempo | Die Lichtwellen laufen langsam so schnell wie die Straße (1,3 m/s bei 5 km/h), darüber gebremst gegen 13 m/s (8,5 m/s bei 50 km/h, 12 m/s bei 120 km/h). Sie folgen dem Tempo über etwa 1,5 s und kommen im Stand ganz zum Stehen |
| Blinker | `VAPI_turnSignalActive` im Takt von `AUDIO_turnSignalPeriodMs` |
| Straßen und Gebäude | Position aus `com.tesla.SensitiveDataValues.get_LOC_geoLocation` (6-mal pro Sekunde, mit laufender Nummer), Kurs `LOC_estimatedHdg` und Tempo (5-mal), aus OpenFreeMap-Kacheln die Gebäude im Umkreis von 450 m und die Straßen, die bis 480 m herankommen, neu ausgewählt alle 60 m |

Das Bild zeichnet WebGL in echter Perspektive: eine Kamera in der gewählten
Höhe über der Straßenmitte, der Horizont auf 58 % der Höhe, die Brennweite 0,78
der Breite. Ein Durchgang malt Himmel und Boden: dunkel, darüber der Schein und
ein Band aus Dunst am Horizont, in den alles in der Ferne übergeht. Dann die
Straßen als Streifen auf dem Boden, die Ecken auf Gehrung, damit sie in Kurven
ihre Breite halten: zuerst für alle ihre Ränder, 1,5 Pixel breit in jeder
Entfernung, dann die Straßen selbst darüber, sodass dort, wo Straßen sich
treffen, ihre Ränder zu einem Umriss verschmelzen; dann das Leuchten der Straße
voraus, alle 2 m ein Punkt, über ein paar Meter geglättet, damit es ohne Ecken
biegt. Die Gebäude zeichnet ein weiterer Durchgang aus derselben Kamera: erst
nur ihre Tiefe, dann ihre Farbe, wo jeweils die vorderste Wand steht. Jede Wand
blendet über ihr letztes Pixel oben und am Fuß aus, damit die Umrisse an jeder
Neigung glatt bleiben, ohne das Antialiasing der GPU, das jedes Pixel kosten
würde; ihre Dachkanten sind schmale Bänder mit weichem Profil, die Ecken
schwächer. Am Ende stehen eine Vignette, ein filmisches Tonemapping und feines
Rauschen, damit dunkle Verläufe keine Stufen zeigen. Rechnet die Grafik in
Software oder dauern Bilder im Mittel länger als etwa 26 ms, zeichnet die Seite
weniger Pixel; die ersten 90 Bilder nach dem Start oder einer Pause zählen
dabei nicht, ebenso wenig 90 Bilder, in die eine neue Auswahl von Gebäuden und
Straßen fiel. Läuft sie danach etwa 15 s im Takt des Bildschirms, geht sie eine
Stufe zurück nach oben; muss sie eine solche Stufe wieder abgeben, bleibt sie
für die Sitzung dort. Die neue Größe nimmt das Bild erst direkt vor dem
nächsten Zeichnen an, denn eine Zeichenfläche, die danach ihre Größe ändert,
bleibt bis zum nächsten Bild schwarz. Ohne WebGL steht ein schlichteres Canvas-Bild da, nur der
Schein über dem Boden. Eine neue Farbe blendet über OKLab, damit die Farben
dazwischen klar bleiben statt schmutzig zu werden, und das Bild dämpft sich
dabei kurz etwas, je mehr, je weiter die Farben auseinanderliegen.

Die Schrift ist die des Autos, Universal Sans in 300 und 500, Tacho und
Ankunftszeit mit gleich breiten Ziffern, damit nichts springt, wenn eine Zahl
wechselt; anderswo die Systemschrift. Ob das Auto die Schrift des Cybertrucks
zeigt, liest der Dienst alle 30 s aus QtCars `fonts.conf`: Nennt sie für Text
Blender-TSL, wie „Cybertruck UI“ sie über die des Autos legt, und liegen die
Schriften in `/usr/share/fonts`, sagt der Zustand `font: "cybertruck"`. Der
Browser der Apps sieht in seinem Käfig nur die Schriften der Firmware, darum
reicht der Dienst die Dateien des Autos unter `font/…` an die Seite weiter;
sie gehen nie aus dem Auto hinaus und liegen nicht im Paket. Blender-TSL steht
dann für 300 als Book, für 500 als Medium und darüber als Bold, mit von sich
aus gleich breiten Ziffern; der Tacho nimmt „CT_speed“ in 52 statt 76 px, so
viel kleiner, wie das Auto ihn selbst setzt (75 statt 110 px). Der Pfeil der Abbiegung wird aus den
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
