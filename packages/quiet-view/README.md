# Quiet-Ansicht für CoilShift

Experimentelles SDK-1.0-Paket nach dem Vorbild des „Quiet Mode“ von FSD v15.
Es bringt eine App mit der Kachel **Quiet** in den Launcher. Sie öffnet sich
direkt maximiert und ohne Titelleiste, auch in D. Zu sehen ist ein dunkler
Bildschirm mit einem Lichtschein in der Farbe deines Ambientelichts: oben ein
weicher, atmender Schein, unten zwei Lichtbahnen wie eine Straße bei Nacht, auf
denen Lichtpulse zu dir hin laufen. Mit aktiver Navigation stehen Ankunftszeit,
Restzeit und Reststrecke in der Mitte. Fest nach unten wischen schließt die App.

## Grenzen

- **Start per Kachel:** QtCar startet eine App von außen nur, wenn eine App auf
  dem Bildschirm das anfordert. Die Quiet-Ansicht öffnest du deshalb über ihre
  Kachel.
- **Kein Zielname:** Über die Schnittstelle des Autos kommt das Ziel nur als
  `<redacted>`. Die App zeigt deshalb Ankunftszeit, Minuten und Kilometer.
- **Farbe:** Sie kommt aus `GUI_rgbColor`. Ohne RGB-Ambientelicht ist der
  Schein weiß.
- **Tacho:** Auf dem Model Y gibt es nur diesen Bildschirm. Ein maximiertes
  Fenster überdeckt auch die Geschwindigkeitsanzeige.

## So funktioniert es

- **Kachel:** Der `apply`-Hook schreibt die Kachel-Definition selbst
  (`config`, `webapp.json`, Symbol) und installiert sie über `PUT /v1/tiles`.
  Gegenüber der Kachel, die CoilShift aus dem Manifest baut, setzt sie
  `appWindowDefaultOpensToMaximized`, `appWindowIsMaximizedOnly`,
  `canMaximizeAppWindow` und `allowInDrive` und blendet die Titelleiste aus.
  Der Ledger nimmt die Kachel beim Deinstallieren zurück.
- **Dienst `web`** (`hooks/web.sh`, `lib/quiet.sh`, `lib/http.sh`): Etwa alle
  2 s schreibt er `/state` und öffnet den Web-Port mit `socat` in jedem
  Netz-Namespace eines Browsers. Dazu gehören auch die Namespaces, die ein
  App-Fenster erst beim Start bekommt. Der Handler beantwortet nur Anfragen an
  `127.0.0.1` oder `localhost` auf diesem Port.
- **Fenster:** Die Seite meldet sich beim Öffnen mit `POST /window/max` und
  beim Wischen mit `POST /window/close`. Der Dienst ruft dann QtCars
  `maximizeAppWindow`/`setWebAppDismissGestureEnabled` oder `dismissApp` über
  D-Bus auf, mit dem Titel der App. Ohne den Header `X-Quiet` lehnt er ab, so
  kann keine fremde Seite das Fenster steuern.

| `/state` | Quelle |
| --- | --- |
| `color` | `GUI_rgbColor` („255,131,0“) als `#ff8300` |
| `trip`, `eta` | `GUI_navNextDestinationArrivalTime` („16:41:00“) als „16:41“, wenn `GUI_navNextDestinationArrivalInfoValid` |
| `min` | `NAV_minutesToArrival`, gerundet |
| `km` | `NAV_milesToArrival` in Kilometern mit Dezimalkomma |

Die Animation zeichnet ein Canvas: Der ruhende Teil entsteht einmal pro Farbe
und Größe, jedes Bild fügt nur das Atmen und die Pulse hinzu.

## Entwicklung und Validierungsstand

`python3 -m unittest tests.test_quiet_view` testet Bibliothek, HTTP-Handler,
Fensteranfragen und Hooks mit Bash 3.2 unter `umask 077` gegen einen
nachgebauten Daemon und ein nachgebautes `dbus-send`. Was am Auto geprüft ist,
steht in der [Validierung](../../docs/quiet-view-validation.md).
