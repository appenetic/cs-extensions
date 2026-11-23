# Quiet-Ansicht für CoilShift

Experimentelles SDK-1.0-Paket nach dem Vorbild des „Quiet Mode“ von FSD v15.
Es bringt eine App mit der Kachel **Quiet** in den Launcher. Sie öffnet sich
direkt maximiert und ohne Titelleiste, auch in D. Zu sehen ist ein dunkler
Bildschirm mit einem Lichtschein in der Farbe deines Ambientelichts: oben ein
weicher, atmender Schein, unten zwei Lichtbahnen wie eine Straße bei Nacht, auf
denen Lichtpulse zu dir hin laufen. In einer Linkskurve biegen sich die Bahnen
nach links, in einer Rechtskurve nach rechts. Mit aktiver Navigation stehen
Ankunftszeit, Restzeit und Reststrecke in der Mitte. Fest nach unten wischen
schließt die App.

## Grenzen

- **Start per Kachel:** QtCar startet eine App von außen nur, wenn eine App auf
  dem Bildschirm das anfordert. Die Quiet-Ansicht öffnest du deshalb über ihre
  Kachel.
- **Kein Zielname:** Über die Schnittstelle des Autos kommt das Ziel nur als
  `<redacted>`. Die App zeigt deshalb Ankunftszeit, Minuten und Kilometer.
- **Farbe:** Sie folgt dem Ambientelicht, auch wenn es die Farbe des
  Albumcovers übernimmt. Ohne RGB-Ambientelicht ist der Schein weiß.
- **Tacho:** Auf dem Model Y gibt es nur diesen Bildschirm. Ein maximiertes
  Fenster überdeckt auch die Geschwindigkeitsanzeige.

## So funktioniert es

- **Kachel:** Der `apply`-Hook schreibt die Kachel-Definition selbst
  (`config`, `webapp.json`, Symbol) und installiert sie über `PUT /v1/tiles`.
  Gegenüber der Kachel, die CoilShift aus dem Manifest baut, setzt sie
  `appWindowDefaultOpensToMaximized`, `appWindowIsMaximizedOnly`,
  `canMaximizeAppWindow` und `allowInDrive` und blendet die Titelleiste aus.
  Der Ledger nimmt die Kachel beim Deinstallieren zurück.
- **Dienst `web`** (`hooks/web.sh`, `lib/quiet.sh`, `lib/http.sh`): Zwei Mal
  pro Sekunde schreibt er `/state` mit der Drehrate, alle 2 s auch Farbe und
  Fahrt. Ebenso oft öffnet er den Web-Port mit `socat` in jedem Netz-Namespace
  eines Browsers. Dazu gehören auch die Namespaces, die ein App-Fenster erst
  beim Start bekommt. Der Handler beantwortet nur Anfragen an `127.0.0.1` oder
  `localhost` auf diesem Port und startet für `/state` keinen weiteren Prozess.
- **Kurve:** Die Drehrate ist die Änderung von `LOC_estimatedHdg` über die
  letzte Sekunde, rechts positiv. Im Stand (`VAPI_vehicleSpeed` unter 1) und bei
  Sprüngen über 60 °/s, also einem neuen GPS-Fix, ist sie 0. Die Seite macht
  daraus eine Biegung: Etwa 25 °/s, eine Abzweigung, biegt voll, eine
  Autobahnkurve mit 2 °/s leicht, unter 0,4 °/s bleibt die Straße gerade. Sie
  gleitet in etwa 0,7 s dorthin. Kommt 3 s lang nichts Neues,
  laufen die Bahnen wieder gerade. `VAPI_steeringAngle` und `VAPI_yawRate`
  wären direkter, sind im Stand aber `<invalid>` und ihre Vorzeichen am Auto
  nicht geprüft.
- **Fenster:** Die Seite meldet sich beim Öffnen mit `POST /window/max` und
  beim Wischen mit `POST /window/close`. Der Dienst ruft dann QtCars
  `maximizeAppWindow`/`setWebAppDismissGestureEnabled` oder `dismissApp` über
  D-Bus auf, mit dem Titel der App. Ohne den Header `X-Quiet` lehnt er ab, so
  kann keine fremde Seite das Fenster steuern.

| `/state` | Quelle |
| --- | --- |
| `color` | Was die Ambientelichter zeigen: `red`, `green`, `blue` aus `GUI_rgbMap` („{blue:36,…,green:73,…,red:255,…}“) als `#ff4924`. Ohne sie `GUI_rgbAlbumColor`, wenn `GUI_rgbSyncAlbumArtColor` an ist, sonst `GUI_rgbColor` („255,131,0“). Die Seite blendet in etwa 0,6 s über |
| `trip`, `eta` | `GUI_navNextDestinationArrivalTime` („16:41:00“) als „16:41“, wenn `GUI_navNextDestinationArrivalInfoValid` |
| `min` | `NAV_minutesToArrival`, gerundet |
| `km` | `NAV_milesToArrival` in Kilometern mit Dezimalkomma |
| `yaw` | Drehrate in °/s aus `LOC_estimatedHdg`, rechts positiv, „0.0“ im Stand |

Die Animation zeichnet ein Canvas: Hintergrund und Schein entstehen einmal pro
Farbe und Größe. Die Lichtbahnen zeichnet die Seite bei jeder Änderung der
Biegung in einen Puffer mit einem Viertel der Größe, weichgezeichnet und dann
hochskaliert. Jedes Bild fügt das Atmen und die Pulse hinzu.

## Entwicklung und Validierungsstand

`python3 -m unittest tests.test_quiet_view` testet Bibliothek, HTTP-Handler,
Fensteranfragen und Hooks mit Bash 3.2 unter `umask 077` gegen einen
nachgebauten Daemon und ein nachgebautes `dbus-send`. Was am Auto geprüft ist,
steht in der [Validierung](../../docs/quiet-view-validation.md).
