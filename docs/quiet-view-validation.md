# Quiet-Ansicht: Validierung, 2026-11-23

Version `0.1.0-alpha.1`. Getestet am Auto des Nutzers (Model Y, Firmware
2026.32.7, UI-Host `dev.coilshift.qtcar-host` 1.0.0, Modul 1.0.13), teils
während einer simulierten Fahrt. Die Vorlagen liefen als Tests unter dem
Claude-Paket; CoilShifts Schnittstelle kennt dafür `PUT/DELETE /v1/ui/<name>`
und `GET /v1/ui/status`.

## Vorbild

Der Post zeigt FSD v15: Der Bildschirm wird während der Fahrt zu einer dunklen
Ansicht mit einem Lichtschein in der Ambientefarbe, Ziel, Ankunftszeit und
Fortschrittsbalken. Links bleibt die Statusspalte. 2026.32.7 und 2026.38.5.12
haben einen Quiet Mode für die Karte (`GUI_navGuiQuietMode`,
`NavQuietToggleButton`), aber ohne diese Szene. Sein Knopf hängt an LaneNav
(`LaneNavDbusClient::updateQuietMode`), ist im Valet-Modus gesperrt und war
beim Nutzer nicht zu sehen.

## Was der UI-Host kann

- **`GET /v1/ui/caps`:** `uiml.template`, `ctx.bind`, `slot:map.overlay`,
  `slot:launcher.tile`, `input.tap`, `view.basic`, `module.native`,
  `hook.attach` und `lifecycle.tick` sind „ok“. Aus sind `popup.layer`,
  `surface.attach`, `style.set`, `statusbar.item`, `status.item` und `dv.read`;
  `cluster.band`, `card.left` und `card.right` bietet kein Modul an.
- **Bindungen:** Die Vorlage von `dev.coilshift.yankes` zeigte den Weg. Ein Test
  bestätigte Hex-Farben aus dem Modell (`backgroundColor="{x.color}"` mit
  `#ff8300`), `backgroundOpacity` und Bilder per absolutem Pfad mit
  `imageResizeBehavior="resizeImage"`. Ebenso `dv('…')` in Texten: auch
  `NAVGUI_routeProgressPercent` (0.29), das die Schnittstelle des Autos gar nicht
  kennt.
- **Ziel und Ankunft:** `GUI_navDestinationLocationName` liest die Vorlage im
  Klartext („Zuhause“), die Schnittstelle des Autos nur als `<redacted>`.
  `GUI_navNextDestinationArrivalTime` kommt als „16:41:00“.
- **Nicht geladen:** Eine Vorlage mit `CustomButtonView` (eingefärbtes Bild)
  meldete `unsupported: no template com_appenetic_claude__QuietTest`. Der Host
  benennt Vorlagen um in `<paket>__<name>`.
- **Sofort sichtbar:** Eine Anmeldung kommt sofort (`"live":true`), ohne Neustart
  des Touchscreens.
- **Ebene:** `map.overlay` deckt nur die Kartenfläche ab. Eine Fläche mit
  `X:-1000` reichte nach links, lag aber unter der
  Self-Driving-Visualisierung. Teslas Abbiege- und Fahrtkarten liegen darüber.

## Wechsel zur App (alpha.1)

Die Kartenebene liegt unter der Self-Driving-Visualisierung, und fremde
X-Fenster schiebt QtCar aus dem Bild. Das Paket ist deshalb eine App mit eigener
Kachel, so wie Netflix. Am Auto geprüft (Firmware 2026.32.7, simulierte Fahrt):

- **Browser:** Teslas Browser öffnet `127.0.0.1:<port>` nicht. Eine Seite auf
  einem lokalen Port braucht eine Kachel mit `allowedUrls` für diesen Ursprung.
- **D-Bus:** `com.tesla.CenterDisplayDbus` bietet `startApp`,
  `maximizeAppWindow`, `dismissApp`, `setWebAppDismissGestureEnabled` und
  `screenshot` (schreibt nach `/home/tesla/.Tesla/data/screenshots`). QtCar
  kennt Web-Apps unter ihrem Titel („Claude Code“), nicht unter der Kachel-ID.
  Mit der ID meldet `AppViewManagerCoriander` „app … not found“.
- **Start von außen:** `startApp` lehnt QtCar ab, solange die anfordernde App
  nicht auf einem Bildschirm läuft („requesting app … is not running on any
  display, cannot trust request“). Weder `nav`, `media` und `QtFeatures` noch
  Titel geschlossener Apps zählen. Der erste Start bleibt deshalb der Tipp auf
  die Kachel.
- **Kachel-Optionen:** Teslas eigene Apps setzen in `webapp.json`
  `appWindowDefaultOpensToMaximized`, `appWindowIsMaximizedOnly` und
  `canMaximizeAppWindow` (Photobooth). Die Kachel, die CoilShift aus dem
  Manifest baut, setzt `canMaximizeAppWindow: false`. Laut SDK darf ein Paket
  die Definition über `PUT /v1/tiles/{tile}` `{dir}` selbst liefern. `{tile}`
  ist nur der Kachelname (`app`). Mit der vollen ID antwortet der Daemon 400
  („the name com-appenetic-quiet-view.app is not valid for this route“), daran
  scheiterte alpha.1. Mit `app` kam 200 und die Definition unter
  `/usr/tesla/UI/assets/web-apps/com-appenetic-quiet-view.app`.
- **Installieren aus dem Feed:** Die CoilShift-App installiert über
  `POST api/packages/{id}` `{action: "install", repository_id, version,
  entry_sha256}`. Das Paket wird dabei sofort angewendet, auch in D.
- **Netz-Namespaces:** Browser-Prozesse laufen auch in eigenen Namespaces, die
  unter keinem Namen stehen. Der Dienst sucht sie wie der Claude-Server über
  `/proc/*/comm` und öffnet dort seinen Port.
- **Bildschirmfoto:** Eine X-Aufnahme (`ximagesrc`) bleibt schwarz, weil QtCar
  per GPU zeichnet. QtCars `screenshot` zeigt die eigene Oberfläche.

## Kurve und Feed (alpha.3)

- **Fahrtrichtung:** Über die Schnittstelle liest das Paket `LOC_estimatedHdg`
  (33.076) und `LOC_geoHdg`. `NAVGUI_carHeading` und `LOC_adasHdg` kennt sie
  nicht (404). `VAPI_steeringAngle`, `VAPI_yawRate` und `VAPI_lateralAccel`
  standen in P auf `<invalid>`. `sleep 0.5` geht mit BusyBox, `read -t` in
  Bash 3.2 nur ganze Sekunden.
- **Feed am Auto:** Der CoilShift-Server holt ein Repository höchstens etwa
  alle 15 Minuten neu (`checked_unix`). Frühere Anfragen an
  `api/repositories/<id>/refresh` antworten mit dem alten Stand. Ein
  installiertes Paket aktualisiert sich danach von selbst, der Dienst startet
  etwa eine Minute später.
- **Kachel:** Auf diesem Auto fehlt der `qtcar_tiles`-Binder. Eine neue Kachel
  erscheint erst nach dem Neustart von QtCar, den CoilShift bis P zurückhält.
  Bleibt die Definition gleich, braucht ein Update keinen Neustart.
- **Nachfrage-Last:** Vorher startete der Namespace-Scan alle 2 s für jeden
  Prozess ein `cat`, der Handler pro Header ein `tr`. Beides liest jetzt die
  Shell selbst.

## Farbe (alpha.4)

`GUI_rgbColor` ist die im Colorizer eingestellte Farbe (QtCar: „AmbientLightsColorizer:
GUI_rgbColor …“). Mit `GUI_rgbSyncAlbumArtColor` = true leuchtete der Innenraum
aber in der Farbe des Albumcovers: `GUI_rgbAlbumColor` „#ff4924“, während
`GUI_rgbColor` bei „255,131,0“ blieb. `GUI_rgbMap` zeigte genau diese Farbe:
„{blue:36,brightness:24,effect:250ms,green:73,lightSync:false,powerOverride:true,red:255,target:.*,usercolor:true}“.
Alle drei liest das Paket über die Schnittstelle. Weitere Modi:
`GUI_rgbAudioSyncEnabled`, `GUI_rgbRainbowRave`, `GUI_rgbRainbowRoadRequest`
(alle false).

## Go-Dienst und Datenquellen (alpha.6)

- **Grenzen des Daemons:** Höchstens 8 Aufrufe gleichzeitig und 4 offene Streams
  pro Paket (SDK: 429 `too_many_requests`, `too_many_streams`). Von zwölf
  gleichzeitigen `?watch=1`-Streams liefen vier, die anderen bekamen 429.
  Hintereinander gingen 80 Abfragen in 1,8 s durch. Jeder Aufruf landet mit pid
  und Status im Log des Daemons, jeder Treffer einer Grenze einmal pro Boot als
  `limited:429` im Paketstatus.
- **Watch:** `GET /v1/dv/{name}?watch=1` liefert
  `{"type":"dv","data":{"name":…,"value":…}}` bei jeder Änderung, zuerst den
  aktuellen Wert.
- **Gelesen über die Schnittstelle (in P):** `VAPI_displaySpeed` 0,
  `VAPI_speedUnits` KPH, `GUI_distanceUnits` Kilometers,
  `VAPI_turnSignalActive` Off, `GUI_dayMode` false,
  `GUI_centerDisplayTakeOverNow` false, `DAS_autopilotHandsOnState`
  NotDetected, `DAS_sideCollisionWarning` None, `DAS_longCollisionWarning`
  `<invalid>`. `NAV_nextTurnDirection`, `NAV_milesToNextTurn` und
  `NAV_nextTurnStreetName` waren ohne Route `<invalid>`. `GUI_displaySpeed`
  gibt es nicht (404).
- **Navigation mit Route:** `NAV_nextTurnDirection` und
  `NAV_nextTurnStreetName` kommen über die Schnittstelle nur als `<redacted>`.
  Das schwärzt QtCar selbst, nicht CoilShift: `lv` (`com.tesla.Debug.get_data_value`),
  `com.tesla.LocalDataValue.DataGetValueRequest` und der Sammelabruf
  `get_data_values` („@redacted“) liefern dasselbe, ebenso `GUI_turnByTurnJson`.
  Nicht geschwärzt ist `NAV_nextTurnAngle`: 99 bei einer Abbiegung, die die
  Navigation als rechts anzeigte (vom Fahrer bestätigt). Der Winkel zählt also
  im Uhrzeigersinn ab geradeaus, wie Valhallas `turn_degree`. `NAV_nextTurnAdvice`
  war `<invalid>`.
- **Screenshot:** QtCars `screenshot` erfasst auch offene App-Fenster (die
  CoilShift-App war darauf zu sehen).
  Lesbar sind `NAV_milesToNextTurn` (0.038), `NAV_minutesToNextTurn` (0.143),
  `NAV_nextTurnId` (3589978) und `GUI_navNextDestinationArrivalTime`
  („19:01:00.000“). Die Manöver der Routing-Bibliothek in QtCar heißen
  `kSlightLeft`, `kSharpRight`, `kUturnLeft` und so weiter.
- **Probelauf des Go-Dienstes am Auto:** Auf einem Testport (29912) mit dem
  Token des Pakets lieferte er über `/events` und `/state` Farbe `#ff4924`,
  Helligkeit 24, Ankunft, Restzeit und Reststrecke, Tacho „0 km/h“ und die
  Blinkerperiode 680 ms. Ein fremder Host bekam 421, ein Fensterbefehl ohne
  Header 403.

## Echte Fahrt (alpha.8)

Bei offener App schrieb der Dienst `turns.log` (90 Sekunden, 10 bis 32 km/h).
In 13 von 15 Sekunden mit mindestens 3 °/s Drehrate hatte `VAPI_steeringAngle`
deren Vorzeichen, etwa +107,5° bei +16,2 °/s und −192° bei −6,3 °/s: positiv
heißt rechts. Die zwei Ausreißer waren −5° und −3,5° am Ende einer Kurve.
`VAPI_yawRate` zählt andersherum (positiv links, 3 von 15 gleich), das
Verhältnis der Beträge lag im Median bei 172, die Einheit ist offen.
`VAPI_vehicleSpeed` zählt in mph: 17,4 bei 28 km/h auf dem Tacho
(`VAPI_displaySpeed`). Seit alpha.9 folgt die Kurve dem Lenkwinkel.

## Ankunft (alpha.10)

Eine Ankunftsmeldung liest ein Paket nicht: `NAV_arrivalInfoSnapshot` und
`NAV_accurateMilesToArrival` waren `<invalid>`, `ARRIVAL_ENERGY` gibt es nicht
(404). Nach dem Ende der Route stand `GUI_navNextDestinationArrivalInfoValid`
auf false und `NAV_milesToArrival` auf `<invalid>`. Die Systemuhr der MCU läuft
auf US-Pazifikzeit (`date` zeigte PST, als das Auto 17:19 anzeigte); die
Uhrzeit der Ankunft kommt deshalb aus der letzten Ankunftszeit der Navigation.

## Bestätigt im Auto (alpha.10)

- **Wischen schließt:** Fest nach unten wischen schließt die App. Der Dienst
  ruft dafür QtCars `dismissApp` mit dem Titel „Quiet“; denselben Aufruf nutzt
  das Schließen bei Warnungen.
- **Menü:** Eine Wahl im Menü (Lichtstreifen aus) blieb über einen Neustart des
  Dienstes erhalten (`options.json`).
- **Update ohne Neustart:** Nach einem Update startete der Daemon den Dienst
  etwa eine Minute später neu; bis dahin lief der alte Prozess weiter.

## Lenkwinkel in der Fahrt (alpha.11)

`VAPI_steeringAngle` änderte sich bei jeder Abfrage über `lv`, also mindestens
zehnmal pro Sekunde (bei 32 km/h, in 0,1- bis 0,6-Grad-Schritten). Die
Verzögerung, die der Fahrer sah, lag am Dienst (200-ms-Takt) und an der Seite
(Glättung über 0,4 s). Seit alpha.11 arbeitet der Dienst im 50-ms-Takt, und die
Seite glättet den Lenkwinkel nur über 0,1 s. Ab alpha.12 richtet sich die
Straße auf Wunsch des Fahrers nur nach dem Lenkwinkel, nicht mehr nach
Abbiegehinweisen oder der Fahrtrichtung.

## Lenkwinkel direkt (alpha.13)

Mit dem Lenkrad im Stand bewegt, zehnmal pro Sekunde über `lv` gelesen:
- **über den Watch-Stream der Schnittstelle:** 8 Änderungen in 14 s, im Median
  1,72 s nach `lv` (bis 2,6 s), etwa alle 1,6 s eine.
- **direkt über D-Bus** (`com.tesla.Debug.get_data_value` alle 50 ms, eigene
  Verbindung zum Systembus unter `/var/run/dbus/system_bus_socket`): 250
  Änderungen in 15 s, im Median 0,07 s nach `lv`, etwa alle 0,05 s eine.

## Bahn statt Kurve (alpha.14)

Der Fahrer fand das Folgen nicht überzeugend: zu zappelig bei kleinen
Korrekturen, zu schwach bei viel Lenken, falsche Form (gebogen hatte sich vor
allem das ferne Ende), noch verzögert. Seitdem zeichnen die Linien die Bahn
des Lenkwinkels als Kreisbögen (Lenkübersetzung 10:1 angenommen, Radstand
2,89 m), etwa 60 m weit; der Dienst liest den Winkel 30-mal pro Sekunde und
gibt jeden neuen Wert sofort weiter. Die Lenkübersetzung des Model Y ist
nicht nachgemessen.

## Glatt, ohne Kanten, im Stand still (alpha.15)

Alle drei Befunde stammen aus der Demo. Die Kurve sprang: Die Demo-Ansicht
kam nur fünfmal pro Sekunde, und 0,03 s Glättung zeigten jeden Wert als
Stufe. Seitdem trägt eine kritisch gedämpfte Feder die Bahn von Wert zu Wert,
etwa 0,08 s hinter einem drehenden Lenkrad; die Demo rechnet den Lenkwinkel
in jedem Bild neu. In Kurven zogen die Lichtstreifen scharfe, fast waagrechte
Kanten über den Bildschirm: Der Schein der Linien zählt Pixel so, wie der
Boden am Pixel verläuft, und weit weg von der Linie, wo der Boden zum
Horizont hin schnell schrumpft, kam das viel zu kurz heraus. Ganze Zeilen
leuchteten schwach, und jeder Streifen schnitt seine Kante hinein. Der Schein
bleibt jetzt auch am Boden in wenigen Metern um seine Linie, und der Kopf
eines Streifens wird nie schärfer als anderthalb Pixel. Nahe der Geraden ist
die Bahn eine Parabel statt eines sehr großen Kreises; vorher sprang ihr
fernes Ende um einige Pixel, wenn das Lenkrad etwa 0,5° kreuzte. Im Stand
liefen die Lichtstreifen mit 4 m/s weiter. Jetzt laufen sie langsam so schnell
wie die Straße, darüber gebremst gegen 13 m/s, und beim Anhalten kommen sie
ganz zum Stehen.

## Lichtpunkte ohne Balken (alpha.16)

In der Demo zog jeder Lichtpunkt einen waagrechten Balken mit harter Kante
durch seinen Schein. Der Schein nahm die Helligkeit des Streifens aus seiner
eigenen Bildzeile, und der Kopf eines Streifens ist eine Zeile. Zudem war er
außen breiter als innen, weil er den Abstand mit dem Gefälle des Bodens am
Pixel maß. Abstand und Streifen kommen jetzt von der Linie selbst: aus ihrem
Gefälle auf dem Bildschirm neben dem Pixel und von ihrem nächsten Punkt. Im
Schein verschwimmt der Streifen mit dem Abstand, wie ein Lichtschein mehr von
der Linie sammelt, je weiter er von ihr weg ist; weit weg bleibt nur sein
Mittel. Der Kopf auf der Linie ist etwas weicher (mindestens 1,2 m statt
0,72 m).

## Gebäude aus OpenStreetMap (alpha.17)

Am Auto in P geprüft (nur lesend), bevor gebaut wurde:

- `com.tesla.SensitiveDataValues.get_LOC_geoLocation` antwortet sofort mit
  `boolean true` und `"(… N, … E)"` (sechs Nachkommastellen). Die
  `NAV_`-Koordinaten bleiben geschwärzt.
- Der Dienst läuft als root in einem eigenen Netz-Namespace mit Route nach
  draußen (`default via 192.168.93.149 dev vpeer37`), aber ohne DNS:
  `resolv.conf` nennt 127.0.0.1, wo dort niemand antwortet. Über 1.1.1.1
  aufgelöst lädt `curl` aus diesem Namespace die TileJSON von OpenFreeMap
  (HTTP 200, 0,18 s, Zertifikat gültig). Der Dienst löst deshalb selbst über
  öffentliche Resolver auf, nur über IPv4.
- Overpass (overpass-api.de) war in dem Moment überlastet (502). Deshalb die
  statischen Kacheln von OpenFreeMap über ein CDN.

Am Mac: Eine echte Kachel aus Paris (14/8296/5635, 575 KB) ergibt 3674
Gebäudeumrisse in etwa 10 ms. Auf einer echten Straße darin gerendert säumen
die Gebäude beide Seiten und laufen zum Fluchtpunkt zusammen. Die Go-Tests
decken Dekodierung, Zuschnitt an der Kachelkante, Auswahl, Abruf mit Cache und
die Position über D-Bus ab.

Erst bei einer Fahrt zu sehen: wie oft `LOC_estimatedHdg` und die Position
sich wirklich ändern und ob sich die Gebäude damit ruhig bewegen. `turns.log`
zählt dafür je Zeile die neuen Kurse und Positionen seit der vorigen.

## Feinschliff (alpha.18)

- **Schrift:** Am Auto liegen in `/usr/share/fonts/universal-sans` „Universal
  Sans Text“ und „Universal Sans Mono Numerals Text“ in 330, 530 und 630; für
  den Browser sind das die Gewichte 300, 500 und 600 (fontconfig 50, 100, 180).
  Bisher fiel normaler Text (400) wie die große Ankunftszeit (500) auf 500.
  Jetzt stehen die Gewichte bewusst, Tacho und Ankunftszeit mit gleich breiten
  Ziffern.
- **Layout nach den Fotos des Originals:** die Ankunftszeit über dem Horizont,
  ihr Fortschritt als feine Linie mit Lichtpunkt direkt darunter statt am
  unteren Rand; die Abbiegung als gezeichneter Pfeil neben dem Tacho, wie in
  Teslas eigener Anzeige. Was kommt und geht, blendet ein und aus.
- **Gebäude:** Die Wände wurden in der Reihenfolge der Daten gemischt und
  schrieben dabei Tiefe; wo zwei hintereinander standen, dunkelte es je nach
  Reihenfolge einmal oder zweimal. Jetzt erst ein Durchgang nur für die Tiefe,
  dann der Schatten der vordersten Wand, einmal je Pixel. Die Kanten waren
  1-Pixel-Linien ohne Kantenglättung und flimmerten; jetzt schmale Bänder mit
  weichem Profil. Die Entfernung wird je Pixel gemessen statt zwischen den
  Ecken gemittelt, damit lange Wände neben dem Auto richtig ausblenden. Am
  Rand der Auswahl (450 m) standen die Gebäude noch mit 8 % Deckkraft und
  poppten beim Neuwählen auf; jetzt sind sie bis 390 m ausgeblendet.
- **Öffnen:** Bis die erste Farbe kam, zeichnete die Seite den Schein in Weiß.
  Jetzt erwacht das Bild über 1,6 s aus dem Schwarz.
- **Menü:** dunkles Glas, die Schalter in der Lichtfarbe, bei hellem Licht mit
  dunklem Knopf.

Am Mac mit den Schriften des Autos gerendert; auf dem Bildschirm im Auto noch
nicht gesehen.

## Lichtbahn wie im Original (alpha.19)

Die Fotos des Originals zeigen keine feinen Linien, sondern zwei breite, weiche
Lichtbahnen auf dem Boden mit dunkler Mitte. Das gibt es jetzt als Wahl
„Lichtbahn: Weich“ im Menü; Standard bleibt „Fein“, das bisher abgestimmte
Bild. Erster Versuch: die Lichtstreifen als Kosinus-Schwellen über die ganze
Breite der Bahn. Das zog helle Querbänder über beide Bahnen, und am fernen Ende
sahen sie aus wie Scheinwerfer. Jetzt laufen die Pulse nur durch das Herz jeder
Bahn, und die weichen Bahnen verblassen ab 30 m, statt sich am Horizont auf
wenige Pixel zu drängen. Am Mac gerendert bei mehreren Wegstellungen, bei
−40° und +25° Lenkwinkel, mit Blinker und bei der Ankunft.

Dazu: Eine neue Farbe weit weg von der alten (Abstand über 90 in RGB, etwa
Orange zu Blau beim nächsten Song) breitet sich über 1,8 s als Front vom
Fluchtpunkt aus; kleine Schritte und Wechsel während einer Welle gleiten wie
bisher, damit ein Regenbogen nicht flackert. Beim Öffnen wächst die Bahn vom
Auto zum Horizont. Die nasse Straße spiegelt den Schein als weiche Säule unter
dem Horizont, die dort aus dem Nichts beginnt, damit keine Kante entsteht.

Bewusst nicht gebaut: schwebende Lichtpunkte in der Luft. Sie würden im
Augenwinkel unruhig wirken, und die Ansicht soll ruhig bleiben.

Der Dienst nimmt die neue Wahl `look` (`fine` oder `soft`) an. Eine
`options.json` einer älteren Version lädt weiter; fehlende Wahlen bekommen ihren
Standard.

## Stadt bei Nacht (alpha.20)

„Gebäude sehen noch nicht so cool aus“: Die Wände waren blasses Glas mit
dünnen, wegen der vielen Knicke in OSM-Umrissen etwas zittrigen Linien, mehr
Strichzeichnung als Stadt. Jetzt sind sie dunkle Silhouetten vor dem Schein
(Deckkraft 0,7 statt 0,42), mit Fenstern in Etagen, von denen etwa jedes sechste
leuchtet, Licht der Straße am Fuß der Wände, Dachkanten als Lichtlinie und viel
schwächeren Ecken; beim ersten Erscheinen wachsen sie aus dem Boden.

Zwei Fehler auf dem Weg, beide am Mac gefunden:

- Viele Fenster zerfielen in senkrechte Streifen. Die Nummer der Wand war zwar
  an jeder Ecke gleich, wackelte zwischen ihnen aber um Rundungsfehler, und die
  Hash-Funktion machte daraus von Spalte zu Spalte ein anderes Fenster. Jetzt
  ist die Nummer ganzzahlig und wird gerundet, die Hash-Funktion bekommt nur
  ganze Zahlen.
- Eine Variable hieß `out`, in GLSL ein reserviertes Wort: Der Wand-Shader
  kompilierte nicht, und das Bild lief ohne Gebäude weiter. Alle Shader werden
  jetzt vor jedem Stand in Chrome kompiliert.

## Scharf vom Start an (alpha.21)

Beim Durchsehen gefunden, nicht im Auto beobachtet: Die Seite misst die Zeit
von je 90 Bildern und zeichnet weniger Pixel, wenn ein Bild im Mittel länger als
26 ms braucht. Das erste Fenster begann aber beim Laden der Seite und zählte
Laden und Shader-Bau als langsame Bilder mit. Dauerte der Start länger als etwa
0,8 s, fiel die Auflösung gleich auf 75 % und blieb dort bis zum Schließen:
weichere Linien, und entfernte Fenster nur noch als gemittelter Schimmer. Eine
Pause, etwa eine verborgene Seite, hätte im nächsten Fenster genauso gezählt.
Jetzt werden die ersten 90 Bilder nach dem Start und nach jeder Pause über
0,5 s nicht bewertet. alpha.20 lief seit 05:02 UTC am 24.11. im Auto,
installiert in P, die Seite war bis dahin nicht geöffnet.

## Saubere Kanten (alpha.22)

„Die Kanten von den Gebäuden sehen noch etwas kaputt aus“ (Bildschirmfoto aus
der Demo). Dachkanten und Ecken waren eigene Lichtbänder: jedes Kantenstück auf
dem Bildschirm 3 Pixel zu jeder Seite verbreitert und gegen die Wände nur über
die Tiefe geprüft. Daher kamen drei Fehler:

- Die Bänder verdeckter Kanten, auch die der Rückseiten, ragten bis zu 3 Pixel
  über die Silhouette davor: kurze schräge Striche über den Dächern, doppelte
  Linien.
- An jeder Ecke überlappten sich die Bänder zweier Kanten und der Ecklinie
  (heller Punkt) oder ließen außen eine Kerbe: Haken an den Ecken, bei
  niedrigen Häusern am Horizont ein Gewirr aus Strichen und Punkten.
- Die Wände selbst hatten ohne Kantenglättung treppige Oberkanten, die nicht
  unter der glatten Linie lagen.

Jetzt zeichnet jede Wand ihre Linien selbst. Die Dachkante liegt auf ihren
obersten Pixeln, die Ecke zur Hälfte auf jeder der beiden Wände, die sich dort
treffen. So verdeckt die vorderste Wand alles dahinter, und an den Ecken
überlappt nichts. Oben und am Fuß blendet jede Wand über ihren letzten Pixel
aus; den Abstand in Pixeln liefern die Bildschirmableitungen. Die Umrisse
bleiben dadurch glatt, ohne die Kantenglättung der GPU, die auch jeden Pixel
der Straße kosten würde. Tiefe schreibt nur ein Pixel, den die Wand mindestens
zur Hälfte bedeckt.

Die Linien sind etwa doppelt so stark wie vorher, weil sie nicht mehr zur
Hälfte auf dem hellen Himmel liegen. Der eigene Kantenshader und seine
Geometrie fallen weg, ebenso der Tiefenversatz der Wände: ein Durchgang
weniger.

Verglichen wurde am selben Blick: das Rendering mit den OSM-Gebäuden und die
Demo-Szene bei 0:25. Die Shader-Prüfung verbindet jetzt auch das Wandprogramm,
mit und ohne Ableitungen.

## Neon (alpha.23)

Gewünscht war ein Neon-Stil wie in einem Video, das mit einem Auto durch eine
Retro-Neonstadt fährt. Zu sehen sind dort ein magenta Himmel mit Sternen, eine
große blasse Sonne am Fluchtpunkt, violette Hochhäuser mit türkisen
Lichtbändern und warmen Fensterrastern, gelbe Fahrbahnlinien und eine nasse
Straße, die alles spiegelt. Das Menü hat dafür die Zeile **Stil** mit Ambiente
(Standard) und Neon. Der Dienst nimmt das Feld `style` mit `ambient` oder
`neon` an, also acht Felder statt sieben. Ältere `options.json` bekommen
Ambiente.

So ist der Stil gebaut:

- **Himmel:** Er ersetzt den Schein und hängt nicht von der Ambientefarbe ab.
  Der Verlauf geht von Indigo über Magenta bis Pink am Horizont, mit einem
  Dunstband. Die Sterne liegen nach Richtung und Höhe am Himmel (200 Zellen auf
  eine volle Drehung) und bleiben beim Abbiegen stehen.
- **Sonne:** Sie hat einen Radius von 0,095 der Höhe, ihr Mittelpunkt liegt auf
  dem Horizont. Damit bleibt sie zwischen 0,485 und 0,58 der Höhe, unter
  Ankunftszeit und Restzeile (die enden bei etwa 0,475).
- **Straße:** Sie ist dunkelviolett und spiegelt Sonne und Dunst als Säule,
  deren Wellen zum Horizont dichter werden.
- **Spiegelung der Häuser:** Die Wände werden ein zweites Mal gespiegelt
  gezeichnet, mit eigener Tiefe. Davon kommt nur das Licht, mit Wellen, nach
  oben schwächer und mit etwas Abdunkelung. Diesen Durchgang gibt es nur im
  Neon-Stil.
- **Häuser:** Jedes Gebäude bekommt eine eigene Zahl, nicht jede Wand. Daraus
  wird eine von drei Arten: türkise Bänder an jeder Etage, ein Turm mit vielen
  warm erleuchteten Fenstern, oder dunkel mit Dachkante in Pink oder Türkis.
- **Dunst:** Im Neon-Stil bleiben die Wände deckend und nehmen mit der
  Entfernung die Farbe von Himmel und Dunst vor ihnen an. Sonst schien die
  Sonne durch ferne Häuser wie durch Glas.
- **Linien:** Die feinen Linien sind golden. Die weichen Bahnen sind ein rosa
  Schein und um 40 % schwächer, denn Gelb in dieser Breite überstrahlte das
  Bild und wurde gedimmt oliv.
- **Akzente:** Fortschrittslinie, Pfeil und Schalter auf der Seite nehmen das
  Gelb der Linien an.
- **Ohne WebGL:** Der Ersatz zeigt einen magenta Schein mit gelben Bahnen.

Die ganze Himmelsarbeit läuft nur, solange Neon eingeblendet ist; Ambiente
zahlt nichts dafür. Die Shader-Prüfung kennt den gemeinsamen Himmelsbaustein,
und ein Test prüft, dass die Seite jedes Feld der Optionen an den Dienst
schickt: Fehlt eines, antwortet er 400, und die Wahl springt zurück. Ambiente
blieb gegenüber alpha.22 gleich; verglichen wurde am selben Blick, bis auf das
zeitabhängige Atmen des Scheins und das Korn.

## Kurven (alpha.24)

„In Kurven sieht das mit dem Sonnenuntergang und den Gebäuden komisch aus“, in
der Demo: Die Sonne stand fest in der Bildmitte, während sich Stadt und Sterne
mit dem Auto drehten. In der Linkskurve bog die Bahn ab, die Sonne aber blieb
über leerem Land stehen, und ihre Spiegelsäule lief gerade durch die Kurve. In
der Rechtskurve zogen die Häuser vor einer Sonne vorbei, die mitfuhr.

Jetzt hat die Sonne eine eigene Richtung in der Welt. Solange das Auto abbiegt
(über etwa 2 bis 6° pro Sekunde), bleibt sie stehen und wandert wie die Stadt
über das Bild. Mit ihr wandern die Spiegelsäule, der Schein am Horizont und der
Dunst, den die Häuser annehmen.

Auf der Geraden dreht sie nach: im Bild höchstens 3° pro Sekunde, außerhalb des
Bildes mit 12° pro Sekunde, denn dort sieht das Aufholen niemand. Nach einer
90°-Kurve über 6 s steht sie 4 s später wieder am Bildrand (35°), nach 20 s
15° neben der Mitte und nach 30 s bei 3°.

Die Sterne hängen dagegen fest an der Welt, sonst rutschten sie beim Aufholen
über den Himmel. Springt die Richtung um mehr als 30° auf einmal, etwa beim
Szenenwechsel in der Demo, steht die Sonne gleich wieder vorn.

Geprüft wurde mit Standbildern der Demo, vor denen der Himmel die 20 s Fahrt
davor in Schritten von 50 ms durchlief, bei 0:17, 0:24 und 0:30.

Das Update-Skript für das Auto legt seinen API-Helfer wieder hin, wenn `/tmp`
nach einem Neustart leer ist. Es hört nur bei einem eindeutigen Ergebnis auf;
eine abgerissene Verbindung führt zu einem neuen Versuch.

## Sonne hinter den Häusern (alpha.25)

„Die Sonne ist teilweise noch vor den Gebäuden“, in der Demo. Deckend waren
die Häuser im Neon-Stil nur zwischen 140 und 310 m. Davor blendeten sie wie im
Ambiente-Stil ab 40 m ein, dahinter bis 390 m aus. In beiden Bändern waren sie
halb durchsichtig, und die helle Sonne schien durch: bei 0:39 durch einen
fernen Turm. Seit die Sonne in Kurven zur Seite wandert, traf es auch die
nahen Häuser.

Jetzt verschwinden ferne Häuser nicht mehr durch Durchsichtigkeit. Sie nehmen
bis 380 m ganz die Farbe von Himmel und Dunst an und sind davor vor dem Himmel
unsichtbar. Erst auf den letzten 20 m vor dem Ende der geladenen Häuser blenden
sie aus, damit vor der Sonne nichts aufspringt.

Nahe Häuser blenden weiter ruhig ein, verdecken aber Scheibe und inneren Schein
der Sonne ganz, sobald sie davor stehen, ab 25 bis 40 m. Sie schreiben dort
auch Tiefe, damit Häuser dahinter nicht durchscheinen.

Geprüft bei 0:39 mit vorgelaufenem Himmel: Die Sonne steht ganz hinter den
Häusern, der ferne Turm ist eine dunstige Silhouette.

## Häuser im Stand (alpha.26)

Im Auto, in P: „Die Gebäude werden nur kurz angezeigt und verschwinden dann
wieder.“ Der Dienst las die Position zweimal pro Sekunde, nahm sie aber nur,
wenn sie sich geändert hatte. Im Stand änderte sie sich nur, wenn das GPS
zufällig rauschte. Nach 5 s ohne Änderung galt die Position als alt: Die Ansicht
bekam keine Pose mehr, nach 10 s meldete die Auswahl „nofix“.

Die Seite verlor jedes Mal die Kamera, die Häuser sanken in den Boden und
wuchsen mit der nächsten Änderung wieder heraus. 15 s des Ereignisstroms im
stehenden Auto (alpha.25, App offen) zeigten genau das: Die Pose kam und ging,
die Auswahl sprang zwischen „ok“ und „nofix“. An jeder roten Ampel über 5 s wäre
es genauso gewesen.

Jetzt hält der Dienst die Position frisch, wenn das Auto beim Lesen dieselbe
Position meldet und steht (Anzeige unter 2 oder keine Geschwindigkeit). Beim
Fahren altert dieselbe Antwort weiter: Ein Tunnel ohne GPS soll die Stadt nicht
mitfahren lassen.

Auch die Seite behält ihre letzte Position, wenn die Pose fehlt, solange das
Auto steht. Ein Test im Dienst prüft beides, über drei Mal 6 s im Stand und
einmal beim Fahren. Ohne die Korrektur schlägt er fehl, mit dem Race-Detector
läuft er sauber.

## Nahe Häuser vor der Sonne (alpha.27)

Gefunden bei einer Durchsicht von Standbildern der Demo, beide Stile, acht
Szenen. Seit alpha.25 wurde ein nahes Haus, das noch einblendet, nur im Kreis
der Sonne und ihres inneren Scheins deckend. Daneben blieb es halb durchsichtig
und hell vom Himmel dahinter. So zeichnete sich auf dem Haus eine dunkle
Sonnenscheibe ab, bei 0:30 in der Demo auf einem langen, flachen Haus.

Jetzt ist ein solches Haus überall gleich durchsichtig. Im Kreis der Sonne
zeigt es dahinter den Himmel ohne ihre Scheibe, so wie der Shader der Straße
ihn zeichnet, mit Verlauf, Dunst, Schein, Vignette und Abrollen. Damit verdeckt
es die Sonne und sieht über ihr aus wie daneben, ihr Schein dringt weich durch.
Ein Haus, das gerade erst sichtbar wird, verdeckt sie nur zum Teil, ab 30 %
Deckkraft ganz. Der Kreis reicht 3 Pixel über den weichen Rand der Scheibe
hinaus, dorthin, wo beide Himmel gleich sind. Sonst bliebe ein feiner Ring.

Geprüft bei 0:30 mit vorgelaufenem Himmel: kein Fleck und kein Ring, die
Sonne steht hinter dem Haus. Bei 0:52 verdeckt ein fernes, deckendes Haus die
Sonne zur Hälfte, wie zuvor. Die übrigen Szenen unterscheiden sich nur in der
Uhrzeit und den funkelnden Sternen.

## Neustart nach Updates (alpha.28)

Vom Nutzer weitergegebener Hinweis: Ein Update legt die neuen Dateien ab,
startet die Dienste aber nicht verlässlich neu, und das alte Binary läuft
weiter. Hier kam der Neustart bisher etwa eine Minute später (alpha.10). Beim
Ersetzen des Pakets schreibt der Daemon einen neuen Token nach
`$CSDK_RUN/token`; das `run`-Skript liest ihn bei jedem Start
(`read -r CSDK_TOKEN`).
- Der Dienst liest die Datei alle 2 s. Steht zweimal hintereinander ein anderer
  Token darin als sein eigener, fährt er herunter wie bei SIGTERM und endet mit
  Exit-Code 3.
- Nicht 0: Am Auto gelesen nimmt das `finish`-Skript eines Dienstes mit
  `restart: on-failure` ihn nach Exit 0 ganz herunter (`sv d`). Nach jedem
  anderen Code startet er nach 2 s neu, aus dem `run`-Skript der neuen Version.
  SIGTERM endet weiter mit 0.
- Auf dem Mac mit echten Prozessen geprüft: neuer Token → Exit 3 nach etwa
  2,5 s, SIGTERM → sofort Exit 0.

**Am Auto bestätigt (alpha.28 → alpha.29, 2026-11-25):** Ein Leseprotokoll lief
alle 0,5 s auf dem Auto. Um 15:08:41 UTC kam der neue Token, im selben Moment
standen die `run`-Skripte auf der neuen Version und das alte Paketverzeichnis
war fort. Um 15:08:45 endete der Dienst von selbst mit Exit 3 (`backoff` 2),
um 15:08:46 lief alpha.29. Der Hash von `/proc/<pid>/exe` passt zum
installierten Binary. Der Daemon startete danach nicht noch einmal neu. Beim
Update um 14:11 UTC, noch ohne Wache und mit fünf Paketen auf einmal, kamen
die `run`-Skripte 4–9 s nach dem Token, und der Daemon startete die Dienste
erst 28–83 s später neu.

## Englisch (alpha.29)

Wunsch aus der Community (Discord): die App auch auf Englisch.
- **Sprache:** Der Dienst liest `GUI_locale` über die SDK-Schnittstelle (am
  Auto `de_DE`, über `/v1/dv/GUI_locale` lesbar). Deutsch, wenn die Sprache
  `de` ist, sonst Englisch; unbekannt bleibt Deutsch. Er gibt `lang` im View
  an die Seite und formuliert selbst in der Sprache: Abbiegungen (als Art,
  Entfernung und Wörter, die Seite zeichnet den Pfeil nach der Art),
  Dezimaltrennzeichen, Statusmeldungen. Die Seite behält Deutsch im HTML und
  tauscht die Texte nach `lang` aus einem englischen Wörterbuch.
- **Uhr:** Ankunftszeiten folgen `GUI_24hourTime` (am Auto `true`): mit der
  12-Stunden-Uhr „11:41 PM“.
- **Feed:** Titel „Quiet View (experimental)“, Beschreibung auf Englisch
  (Wunsch des Nutzers, die CoilShift-App selbst ist Englisch).
- **Geprüft:** Go-Tests für Sprachregel, 12-Stunden-Uhr, Abbiegungen und View
  in beiden Sprachen; Standbilder aus Chrome headless (1920×1200) der
  Fahransicht, einer scharfen Abbiegung, der Ankunft und des Menüs auf
  Englisch und Deutsch: kein Umbruch, Layout unverändert. Am deutschen Auto
  ist Englisch nicht zu sehen.

## Gleichmäßige Fahrt (alpha.30)

Rückmeldung nach einer Fahrt durch Berlin-Mitte am 25.11. (8,7 min, bis
66 km/h, mit offener App): bei höherem Tempo und vielen Gebäuden „nicht so
optimal“. Aus `turns.log` dieser Fahrt (nur Summen ausgewertet, keine Orte):
- **Kurs:** 99 % der Schritte von 4 bis 60 m liegen unter 15° vom gefahrenen
  Kurs (im Mittel 2,3°). `LOC_estimatedHdg` zählt also ab Norden im
  Uhrzeigersinn; die Gebäude stehen richtig herum.
- **Takt:** Position und Kurs kommen nur etwa einmal pro Sekunde neu (je Zeile,
  also etwa je Sekunde: 1,28 neue Positionen, 1,25 neue Kurse).
- **Gierrate:** `VAPI_yawRate` ist rad/s, nach links positiv (Korrelation
  −0,88 mit der Kursänderung, Faktor −52 ≈ −57,3 mit Verzug).
- **Lenkwinkel:** Die Drehrate aus dem Lenkwinkel (tan(Winkel/10)/2,89 m mal
  Tempo) korreliert mit 0,91 mit der Kursänderung, ist aber 1,5-mal zu groß:
  Faktor 0,65.
- **Gebäudelast:** Mit den Kacheln dieser Fahrt an 1718 Stellen auf Haupt-
  und Nebenstraßen nachgerechnet: höchstens 660 Umrisse, 6726 Wände
  (40 000 Ecken, 87 KB JSON) je Auswahl, im Median 235 Umrisse. Daran liegt
  es nicht.

Der Fehler lag in der Seite: Sie hielt jede Ansicht für eine neue Position und
setzte ihre Zeit zurück. Ansichten kommen aber mit jedem Lenkwinkel bis zu
30-mal pro Sekunde, die Position nur einmal. Die Kamera blieb so an der alten
Position hängen und sprang mit jeder neuen vor. Nachgerechnet mit diesem Takt
lief die Stadt bei 50 km/h im Sekundentakt zwischen 0,6 und 41 m/s.

Jetzt:
- **Nummer:** Der Dienst gibt jeder neuen Position eine Nummer (`n` in
  `pose`) und liest die Position sechs- statt zweimal pro Sekunde.
- **Seite:** Sie nimmt eine Position nur bei neuer Nummer und fährt dazwischen
  mit Tempo und der Drehrate aus dem Lenkwinkel (Faktor 0,65) weiter. Position
  und Kurs ziehen sie über etwa 1 s nach (vorher 0,35 s).
- **Simulation:** Nachgerechnet mit Positionen jede Sekunde, 0,15 s
  Erkennung, Ansichten alle 50–150 ms und 60 Bildern pro Sekunde läuft die
  Stadt bei 50 km/h mit 12,3–15,4 m/s (1. bis 99. Perzentil). In einer Kurve
  mit 15°/s dreht sie mit 13,7–16,4°/s.
- **Tests:** `TestPositionFromTheBus` prüft die Nummer: Dieselbe Position
  zweimal gelesen bleibt Nummer 1, eine neue wird 2.
- **Gleicher Code:** Dieselbe Simulation lief auch mit `takeFix`, `follow`
  und `turnRate` aus `app.js` selbst, mit denselben Werten.
- **Auflösung:** Sie konnte bis alpha.29 nur sinken: Ein langsames Fenster aus
  90 Bildern (eine neue Gebäudeauswahl, ein Ruckler) ließ das Bild für den Rest
  der Sitzung unschärfer. Jetzt zählt ein Fenster mit neuer Gebäudeauswahl
  nicht. Nach zehn Fenstern im Takt des Bildschirms (unter 18,5 ms, etwa
  15 s) geht sie eine Stufe hoch; wird eine solche Stufe wieder abgegeben,
  bleibt sie für die Sitzung unten, damit das Bild nicht pendelt.

## Echte Straßen (alpha.31)

Wunsch nach der Fahrt durch Berlin: statt der Linien des Lenkwinkels die
echten Straßen, Neon und Sonne weg, die Häuser klar statt dunkel und neblig,
alles schicker. Das Design entstand in der Demo (Versionen 24 bis 32) und wurde
dort abgenommen: Blickhöhe „Straße“, die eigene Straße leuchtet durchgehend über
ihre ganze Breite, ruhige Farbüberblendung, Self-Driving-Profil, im Profil
Mad Max ruhige Pfeile.
- **Dienst:** Er liest aus denselben Kacheln die Ebene `transportation`
  (Autobahn bis Zufahrt, ohne Tunnel, Fußwege, Gleise, Fähren), schneidet die
  Linien auf die eigene Kachel und schickt die Straßen, die bis 480 m
  herankommen, als `r` mit den Gebäuden (Art, Einbahn, Punkte in Metern).
  Abbiegungen tragen nun Meter und Winkel (`m`, `a`).
  `GUI_autopilotDrivingProfile` kommt im Sekundentakt dazu und geht mit
  Teslas Namen aus `QtCar_de.qm` an die Seite (Faultier, Lässig, Standard,
  Sportlich, Mad Max). Am Auto gelesen: „Hurry“, später „Standard“;
  `DAS_autopilotState` im Stand „Disabled“. Optionen: `view` (street, raised,
  high) statt `look` und `style`; eine Datei von alpha.23 bis 30 behält ihre
  übrigen Werte.
- **Seite:** Neuer Renderer (Himmel und Boden, Straßen als Streifen mit
  Rändern, Gebäude als beleuchtete Körper), die eigene Straße per Abgleich mit
  den Straßen in der Nähe, ihr Weg voraus bis 400 m mit der nächsten Abbiegung.
- **Mit echten Daten geprüft:** Mit den Kacheln der Berliner Fahrt an drei
  Stellen (Median, p90, schwerste: bis 692 Umrisse und 348 Straßen, 99 KB je
  Auswahl) die echte Seite gerendert, in Orange und Blau, Sportlich, Standard
  und Mad Max, dazu das Menü: Das Auto steht auf seiner Straße, das Leuchten
  läuft auf ihr voraus und biegt mit ihr ab.
- **Tests:** Go: Straßen aus einer handgebauten Kachel (Hauptstraße über den
  Rand geschnitten, Tunnel und Fußweg fallen weg), Auswahl der Straßen, Namen
  der Profile, alte Optionsdateien. Python: alle Shader kompiliert, auch das
  Straßenprogramm gelinkt.
- **Offen:** wie sich der Abgleich mit der Straße beim Fahren anfühlt, vor
  allem an Kreuzungen und auf mehrspurigen Straßen mit getrennten Fahrbahnen;
  welcher Wert zeigt, dass FSD gerade fährt.

## Am Auto offen

1. Wie die Straße voraus beim Fahren wirkt (alpha.31), auch an Kreuzungen
   und auf der Autobahn.
2. Ob sich die Gebäude mit alpha.30 beim Fahren ruhig mitbewegen. Kurs und
   Takt sind aus `turns.log` geklärt (alpha.30), dass sie ankommen mit
   alpha.17.
3. Wie Schrift und Layout von alpha.18, die weiche Lichtbahn von alpha.19 und
   die Stadt von alpha.20 auf dem Bildschirm im Auto wirken, auch in der
   Bildrate.
4. Ob sich das Fenster in D maximiert öffnet und ob es die linke Seite mit der
   Visualisierung und die untere Leiste überdeckt.
5. Wie die Animation auf der MCU läuft (Bildrate) und wie der Schein in anderen
   Farben aussieht, auch tagsüber.
6. Ob `GUI_rgbMap` bei Audio-Sync und Rainbow mitläuft und wie schnell.
7. Ob die Warnungen das Schließen auslösen. Ihre Werte stehen beim Auslösen im
   Paketlog.
8. Welche Werte `VAPI_turnSignalActive` und die Warnstufen wirklich tragen. Die
   Auslöser stehen mit ihrem Wert im Paketlog.
9. (Geklärt mit alpha.30: `VAPI_yawRate` ist rad/s, nach links positiv.)
10. Ob die Ankunft am echten Ziel erkannt wird, also wie nah die Navigation
    die Route beendet.
11. Ob die Wache auch bei vielen Paketen auf einmal die neue Version startet:
    Kommen die `run`-Skripte mehr als 2–4 s nach dem Token (am 14:11-Update
    9 s), startet sie womöglich noch einmal die alte Fassung.
