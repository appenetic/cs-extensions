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

## Am Auto offen

1. Ob QtCar die Kachel ohne Neustart zeigt.
2. Ob sich das Fenster in D maximiert öffnet und ob es die linke Seite mit der
   Visualisierung und die untere Leiste überdeckt.
3. Ob das Wischen nach unten die App über `dismissApp` schließt.
4. Wie die Animation auf der MCU läuft (Bildrate) und wie der Schein in anderen
   Farben aussieht, auch tagsüber.
