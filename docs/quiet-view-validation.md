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

## Am Auto offen

1. Wie sich die Bahn mit dem Lenkwinkel anfühlt, auch auf der Autobahn
   (alpha.14 und 15 bisher nur in der Demo und im Rendering gesehen).
2. Ob sich das Fenster in D maximiert öffnet und ob es die linke Seite mit der
   Visualisierung und die untere Leiste überdeckt.
3. Wie die Animation auf der MCU läuft (Bildrate) und wie der Schein in anderen
   Farben aussieht, auch tagsüber.
4. Ob `GUI_rgbMap` bei Audio-Sync und Rainbow mitläuft und wie schnell.
5. Ob die Warnungen das Schließen auslösen. Ihre Werte stehen beim Auslösen im
   Paketlog.
6. Welche Werte `VAPI_turnSignalActive` und die Warnstufen wirklich tragen. Die
   Auslöser stehen mit ihrem Wert im Paketlog.
7. Die Einheit von `VAPI_yawRate`.
8. Ob die Ankunft am echten Ziel erkannt wird, also wie nah die Navigation die
   Route beendet.
