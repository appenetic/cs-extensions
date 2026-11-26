# Claude Code für CoilShift

Experimentelles SDK-1.0-Paket. Zeigt die Claude-Code-Sitzungen deines Macs auf
der MCU. Du kannst sie verfolgen und vom Auto aus weiterarbeiten lassen. Fragen
von Claude erscheinen als Karte über der Navigation. Antworten gibst du per
Touch, per Diktat über die Tesla-Tastatur oder mit der Sprachtaste („Claude, …“).
Gekoppelt wird mit einem Code aus dem Auto oder per QR-Code. Tailscale ist nicht
nötig. Am Fahrzeug selbst wird nichts geschrieben.

## So hängt es zusammen

| Teil | Wo | Aufgabe |
| --- | --- | --- |
| Plugin `coilshift` | Claude Code auf dem Mac | Bridge-Dienst, Hooks und Inbox-Relay je Sitzung, siehe [Plugin-README](../../claude-code/coilshift/README.md) |
| Paket `com.appenetic.claude` | MCU (CoilShift) | Dienst `link` (Verbindung zum Mac, Kopplung, Karte, Sprache) und Dienst `web` (App) |
| Kachel „Claude Code“ | App-Launcher | Die App: Sitzungsliste, Verlauf, Fragen, Antwortfeld, neue Sitzung |
| Karte über der Navi | QtCar über `dev.coilshift.qtcar-host` | Offene Frage mit Antwort-Buttons, auch während der Fahrt |

Das Auto verbindet sich direkt per HTTPS mit dem Mac, wenn es ihn erreicht:
über Tailscale oder dasselbe WLAN. Sonst, etwa unterwegs im Mobilfunk mit dem
Mac zu Hause hinter dem Router, geht die Verbindung über das
**Internet-Relay**. Dabei bauen Mac und Auto beide eine ausgehende Verbindung
zu einem öffentlichen MQTT-Broker auf, standardmäßig `broker.emqx.io` und
`broker.hivemq.com`.

Die Nachrichten sind Ende-zu-Ende verschlüsselt (AES-256-GCM) mit einem
Schlüssel, den nur Mac und Auto aus der Kopplung kennen. Der Broker sieht nur
Chiffretext unter zufälligen Themennamen, dazu Zeitpunkt und Größe der
Nachrichten. Im Auto liegen keine Claude-Zugangsdaten.

Die Bridge nutzt nur Schnittstellen, die Claude Code selbst anbietet: Hooks,
`claude agents --json`, `claude --bg` und den Inbox-Socket der Sitzung.

**Broker des Internet-Relays:** Die öffentlichen Broker sind kostenlose
Testdienste ohne Verfügbarkeitszusage. Antworten brauchen über sie meist 0,2
bis 1 Sekunde, manchmal ein paar Sekunden. Auf dem Mac lässt sich das
Internet-Relay über die Variable `COILSHIFT_RELAY` steuern:
- `COILSHIFT_RELAY=off` schaltet es aus.
- `COILSHIFT_RELAY=mqtt.example.com:8883` setzt einen eigenen Broker
  (MQTT über TLS).

Die Variable gehört etwa unter `env` in `~/.claude/settings.json`. Das Auto
übernimmt die Brokerliste bei der nächsten Verbindung.

Ein gekoppeltes Auto hält seine Verbindung zum Broker ständig offen, mit
einem Ping alle 15 Sekunden, auch wenn es den Mac gerade direkt erreicht. So
geht der Wechsel aufs Relay ohne Verbindungsaufbau, wenn der direkte Weg
wegfällt. Der Broker sieht dabei, dass das Auto online ist, aber keine
Inhalte. Mit `COILSHIFT_RELAY=off` auf dem Mac gibt das Auto bei der
nächsten direkten Verbindung auch diese Verbindung auf.

## Einrichtung

1. **Mac:** Das Plugin ist öffentlich auf GitHub, auch für Kollegen:

   ```sh
   claude plugin marketplace add appenetic/cs-extensions
   claude plugin install coilshift@appenetic
   ```

   Aus einem ausgecheckten Repository geht auch `claude plugin marketplace add ./`.
   Jeder Kollege koppelt damit sein eigenes Auto, auf dem das CoilShift-Paket
   installiert ist.

   Danach neu gestartete Claude-Code-Sitzungen melden sich bei der Bridge.
   Bereits laufende Sitzungen erscheinen mit Liste und Verlauf. Ihr Verlauf
   folgt dem Transkript. Text nehmen sie erst nach einem Neustart an, weil ihnen
   das Relay fehlt.

   Erster Test: `/coilshift:status` in einer neuen Sitzung. Steht dort bei offenen
   Sitzungen „Sitzungen mit Relay: 0“, finden CLI und Hooks nicht denselben
   Datenordner. Hinweise stehen dann in `bridge.log` im Plugin-Datenordner.
2. **Auto:** Im CoilShift-Paketmanager **Claude Code (experimental)** installieren.
   Die Kachel „Claude Code“ erscheint im App-Launcher. Je nach Firmware geschieht
   das erst nach einem Neustart der Oberfläche im Stand. Einen eigenen Reiter in
   der CoilShift-App hat das Paket nicht. Ihr Symbol, der Funke von Claude Code
   auf Terrakotta, ist gebaut wie Teslas eigene Launcher-Icons: 180 × 180 px,
   das Motiv auf den mittleren 88 × 88 px, der Rest transparent.
3. **Koppeln:** Die App zeigt ohne Kopplung einen Code wie `K7QM-4ZP2-XR9T-HB3D`.
   - **Mit dem Code, überall:** In Claude Code auf dem Mac
     `/coilshift:pair K7QM-4ZP2-XR9T-HB3D` eingeben. Der Mac schickt die
     Kopplung über das Internet-Relay ans Auto. Ein gemeinsames Netz ist nicht
     nötig, nur Internet auf beiden Seiten.
   - **Per QR-Code, im selben WLAN oder Tailnet:**
     - Auf dem Mac `/coilshift:pair` ohne Code ausführen. Der Kopplungslink
       landet in der Zwischenablage und per Universal Clipboard auch auf dem
       iPhone.
     - Den QR-Code im Auto mit dem Handy scannen und das lokale Zertifikat
       einmal bestätigen.
     - Auf der Handy-Seite den Link einfügen und **Koppeln** tippen.
     - Das Handy muss die MCU erreichen: im selben WLAN oder über Tailscale.

Der Code des Autos besteht aus 80 Bit des Hashs eines Schlüssels, den das Auto
für jedes Kopplungsfenster neu erzeugt. Er gilt, solange das Fenster offen ist
(zehn Minuten). Der Kopplungslink des Macs gilt zehn Minuten und
genau einmal. Beide Wege übertragen den Fingerabdruck des Mac-Zertifikats. Auf
dem direkten Weg vertraut das Auto danach nur diesem Zertifikat. Über das
Internet-Relay gilt der Schlüssel aus der Kopplung.

Neu koppeln geht unter **Technik → Neuen Kopplungs-QR-Code**. Ein Auto, das vor
dem Internet-Relay gekoppelt wurde, holt sich seinen Schlüssel dafür beim
nächsten direkten Kontakt selbst.

## Bedienung

- **Sitzungen:** alle laufenden Sitzungen (Terminal und Hintergrund) und die der
  letzten drei Tage. Ein Punkt markiert eine offene Frage. **Ausblenden** nimmt
  eine Sitzung aus der Liste, bis dort wieder etwas passiert.
  - Sitzungen ohne ein Wort mit Claude fehlen, etwa die Proben, die CodexBar
    alle halbe Stunde mit `/usage` startet. Eine neue, noch leere Sitzung
    erscheint nach einer Minute oder mit ihrem ersten Prompt.
- **Verlauf:** Prompts, Claudes Antworten mit Tabellen und Listen, und
  Werkzeugaufrufe als kleine Blase mit Punkten. Text aus dem Auto ist als „Aus
  dem Auto“ markiert.
  - Was Claude zwischen den Werkzeugaufrufen schreibt, steht klein als
    Zwischenstand da; die letzte Antwort eines Durchgangs ist die große Blase.
  - Sub-Agents sind Karten mit Typ, Aufgabe und Stand („läuft · 2 Min.“,
    „fertig nach 3 Min.“). Ist einer fertig, zeigt die Karte den Anfang seines
    Berichts, **Ergebnis lesen** den ganzen (bis 2000 Zeichen).
  - Hintergrund-Befehle, die enden, und andere Meldungen von Claude Code sind
    eine ruhige Zeile mit Zeichen: „Hintergrund-Befehl fertig · „…“ ·
    Exit-Code 0“, rot bei einem Fehler. Wo Claude Code den Verlauf
    zusammengefasst hat, steht „Verlauf zusammengefasst“.
  - Bilder, die du in einen Prompt eingefügt hast, stehen als Vorschau unter dem
    Text. Antippen zeigt sie in voller Breite. Der Mac lädt jedes erst, wenn du
    die Sitzung öffnest, und verkleinert es mit `sips` auf höchstens 1024 Pixel.
    Bilder, die Claude selbst mit Werkzeugen liest, zeigt das Auto nicht.
  - **▶ Vorlesen** unter einer Antwort von Claude liest sie vor. Der Mac
    spricht sie mit `say` (Vorgabe: Anna), das Auto spielt den Ton ab.
    Codeblöcke und Tabellen sagt er nur an. Ein zweiter Tipp hält an.
  - Läuft dabei Musik aus Apple Music, hält das Auto sie an und spielt sie
    nach dem Vorlesen weiter. Hat man sie inzwischen selbst bedient, bleibt
    sie, wie sie ist. Abschalten lässt sich das mit „Musik beim Vorlesen
    anhalten“. Dafür nutzt das Paket eine interne Schnittstelle von Tesla
    (`ChromiumAdapterDbus`), nicht CoilShift. Geprüft ist sie mit Apple Music
    auf Firmware 2026.32.7; andere Quellen wie Spotify, Bluetooth oder Radio
    sind ungeprüft, und ein Firmware-Update kann sie ändern.
- **Weiterarbeiten:**
  - Text an eine laufende Sitzung geht direkt hinein. Ist Claude gerade
    beschäftigt, liest Claude ihn zwischen zwei Werkzeugaufrufen, sonst beginnt
    ein neuer Turn.
  - Eine beendete Sitzung setzt **Fortsetzen** mit `claude --bg --resume` im
    Hintergrund fort.
  - **+ Neue Sitzung** startet `claude --bg` in einem der zuletzt genutzten
    Projektordner.
- **Fragen und Freigaben:** `AskUserQuestion` und Freigabedialoge erscheinen in
  der App und auf der Karte.
  - Im **Unterwegs-Modus** wartet Claude bis zu 20 Minuten auf die Antwort aus
    dem Auto. Danach öffnet sich der normale Dialog im Terminal.
  - Der Modus ist automatisch an, solange das Auto in D, R oder N ist, und
    5 Minuten danach. Mit dem Schalter oben in der App oder mit
    `/coilshift:away on` schaltest du ihn dauerhaft ein.
  - Ohne Unterwegs-Modus siehst du die Frage im Auto nur. Beantwortet wird sie
    im Terminal.
- **Rückfragen im Text:** Endet ein Turn mit einer Frage, erscheint
  „Claude wartet auf dich“. Die Antwort gibst du als Text.

## Sprache

1. **Diktat:** Das Antwortfeld antippen und das Mikrofon der Tesla-Tastatur
   nutzen. Ob die Tastatur in Web-Apps ein Mikrofon anbietet, ist am Auto noch
   nicht geprüft.
2. **Sprachtaste:**
   - Die Sprachtaste drücken und „Claude, …“ sagen. Der Dienst liest das
     Transkript des Tesla-Assistenten aus `GUI_carAssistUserTranscript`, ohne
     etwas zu schreiben.
   - Beginnt es mit einem Rufwort, geht der Rest an die neueste offene Frage,
     sonst an die zuletzt aktive Sitzung.
   - Optionen wählst du mit „die zweite“, „Option drei“ oder dem Wortlaut.
     Freigaben mit „ja“ oder „nein, …“. Englisch geht immer auch („option
     two“, „yes“, „no, …“), gleich in welcher Sprache das Auto steht.
   - Teslas Assistent reagiert zusätzlich selbst auf den Satz.
   - Die Rufwörter lassen sich einstellen. Vorgabe:
     `claude, clod, klod, klaud, cloud, glod`.
   - Transkripte ohne Rufwort werden ignoriert. Nichts davon wird gespeichert
     oder protokolliert.

Der DataValue-Name wurde offline in der Firmware 2026.38.5.12 gefunden, im
`QtCarSpeechRecognizer`. Ob er am Auto lesbar ist oder wie die Navi-Koordinaten
`<redacted>` liefert, zeigt **Technik → Sprachtaste**.

## Deutsch oder Englisch

Im Auto folgt alles der Sprache des Autos (`GUI_locale`): App, Karte über der
Navi, Kopplungsseite am Handy, Meldungen und Diagnose, und was die Bridge ins
Auto schickt, auch die Stimme beim Vorlesen. Deutsch, wenn das Auto auf Deutsch
steht, sonst Englisch. Das Plugin auf dem Mac schreibt in der Sprache des Macs
(`LC_ALL`, `LC_MESSAGES`, `LANG`). Die Beschreibungen im Feed und im
Plugin-Marktplatz sind Englisch.

## Karte über der Navi

Die Karte braucht den CoilShift-UI-Host `dev.coilshift.qtcar-host`. Das Paket
registriert sie nur, wenn der Host läuft und `slot:map.overlay`, `uiml.template`
und `ctx.bind` meldet. Deshalb löst es nie selbst einen Neustart der Oberfläche
aus und wird ohne Host auch nicht `unsupported`. Buttons: bis zu vier Optionen,
Erlauben/Ablehnen, Schließen. Die Button-Stile stammen aus Teslas eigener UIML,
die Darstellung ist am Auto ungeprüft. Abschalten lässt sich die Karte mit der
Einstellung `card_enabled`.

## Technik und Diagnose

Der Bereich **Technik** in der App zeigt:
- die Verbindung zum Mac und den Weg dorthin: direkt (mit Adresse) oder
  Internet-Relay (mit Broker)
- Web-Port und Netzwerk-Namespace-Modus (`inside`, `setns` oder `current`)
- den Kartenstatus
- den Status des Sprach-DataValues
- die letzte erkannte Sprachantwort

Der Paketstatus in CoilShift folgt der Verbindung.

## Sicherheit

- **Bridge auf dem Mac:**
  - Nimmt direkte Verbindungen nur aus LAN, Tailscale (`100.64.0.0/10`,
    `fd7a:…`) und Loopback an.
  - Das Gerätetoken hat 256 Bit und liegt auf dem Mac nur als SHA-256-Hash.
- **Internet-Relay:**
  - Jedes gekoppelte Auto hat einen eigenen 256-Bit-Schlüssel. Daraus folgen
    Themennamen und je Richtung ein AES-256-GCM-Schlüssel. Der Mac speichert ihn
    in `config.json` (Modus 0600), das Auto in der verschlüsselten Kopplung.
  - Eine Anfrage trägt zusätzlich das Gerätetoken und gilt nur auf dem Kanal
    ihres Autos.
  - Der Mac beantwortet jede Anfrage-ID einmal und verwirft Anfragen, die mehr
    als zehn Minuten von seiner Uhr abweichen. Ein mitgeschnittenes `/v1/reply`
    oder `/v1/start` wirkt also nicht doppelt.
  - Kopplung per Code: Der Code legt sich auf einen X25519-Schlüssel des Autos
    fest. Der Mac verschlüsselt sein Angebot an diesen Schlüssel. Wer den Code
    nur am Bildschirm abliest, kann es nicht öffnen.
  - Token und Relay-Schlüssel einer Kopplung verschlüsselt der Mac an einen
    Schlüssel, den das Auto eigens dafür erzeugt. Wer den Code oder den
    Kopplungslink kennt, kann sie nicht mitlesen.
  - Restrisiko: Wer den Code am Bildschirm sieht, kann dem Auto im offenen
    Kopplungsfenster ein eigenes Angebot unterschieben. Das Auto koppelt sich
    dann mit seinem Mac, an den Mac des Nutzers kommt er so nicht heran. Zu
    erkennen ist das an zwei Stellen: `/coilshift:pair` meldet, das Auto habe
    sich nicht gemeldet, und die App zeigt einen fremden Mac-Namen.
- **Auto:**
  - Die Kopplung liegt AES-256-GCM-verschlüsselt in `$CSDK_STATE/pairing.enc`.
    Der Schlüssel liegt in `pairing.key`, beide mit Modus 0600.
  - Der Web-Port der App prüft den `Host`-Header gegen DNS-Rebinding.
  - Die API verlangt ein Token, das bei jedem Start neu erzeugt wird. Die
    Kachel holt es nur per Same-Origin.
- **Nachrichten aus dem Auto:**
  - Sie erreichen Claude als Nachricht „einer anderen Sitzung“ mit dem Präfix
    `[Aus dem Auto]`.
  - Claude behandelt sie wie die Bitte eines Teammitglieds. Als Freigabe gelten
    sie nicht.
- **Sitzungen aus dem Auto:**
  - Hintergrundsitzungen starten im Standard-Berechtigungsmodus. Freigaben
    erscheinen dann im Auto.
  - Den Modus legt `permission_mode` in der Bridge-Konfiguration fest.

## Version 0.1.0-alpha.2

Erste Rückmeldung vom Auto: Die Kopplung klappt, und die Sitzungen erscheinen im
CoilShift-Panel. Es gab aber drei Fehler:

1. **„127.0.0.1 Verbindung abgelehnt“ in der Kachel.** Die Firmware hat viele
   Browser-Profile mit eigenen Netzwerk-Namespaces (`chromium`,
   `chromium-entertainment`, `chromium1-…`, …). In welchem davon die Kachel
   öffnet, entscheidet CoilShift. alpha.1 lauschte nur in `chromium-entertainment`.
   Ab alpha.2 öffnet der Web-Dienst den Port im eigenen Namespace und in jedem
   `chromium*`-Namespace. Alle zehn Sekunden sucht er nach neuen, denn die
   Sandbox legt einen Namespace erst beim ersten Start seines Browsers an.
   **Technik → Web-Port** zeigt alle bedienten Namespaces und Fehler je
   Namespace.
2. **„Noch kein Verlauf“ im Panel.** Ohne erreichbaren Web-Port liest das Panel
   `state.json` (höchstens 64 KiB). War die Datei zu groß, warf alpha.1 sofort
   alle Nachrichten weg. Jetzt werden erst die Texte gekürzt, dann die Anzahl
   der Nachrichten, zuletzt der Verlauf älterer Sitzungen. Die Liste bleibt
   vollständig.
3. **Layout.** Die Höhen hingen an `100vh`, und im Panel-Frame ist diese Höhe
   unbestimmt. Die Seite fließt jetzt als Ganzes:
   - Das Antwortfeld steht direkt unter der Frage, die neuesten Nachrichten oben.
   - Im schmalen Panel wechseln Liste und Sitzung, mit „‹ Alle Sitzungen“.
   - Eine neue Frage öffnet ihre Sitzung von selbst.

## Version 0.1.0-alpha.3

Das Dock-Icon ist jetzt das Claude-Symbol: 180×180 Pixel mit transparentem
Hintergrund, wie Teslas eigene Kachel-Icons. Teslas Launcher kann alte Icons
zwischenspeichern. Das neue erscheint unter Umständen erst nach einem Neustart
der Oberfläche im Stand.

## Version 0.1.0-alpha.4

Arbeitet Claude gerade in einer Sitzung, pulsiert vor ihrem Namen ein kleiner
grüner Punkt, in der Liste und im Kopf der Sitzung. Eine offene Frage zeigt
weiterhin den orangen Punkt. Die Animation läuft im Takt der Uhr weiter, auch
wenn ein Live-Update die Liste neu zeichnet.

## Version 0.1.0-alpha.5

Die Kachel meldete mit alpha.4 weiter „localhost Verbindung abgelehnt“.

- **Lauschen:** Der Web-Dienst sucht die Namespaces jetzt auch über die
  laufenden Browser-Prozesse (`/proc/<pid>/ns/net` jedes `tesla-chromium-*`).
  Dort öffnet er den Port, egal wie das Sandbox-Profil heißt. Er lauscht
  zusätzlich auf `[::1]` für `localhost` und prüft alle 3 Sekunden statt
  alle 10.
- **Diagnose am Mac:** Das Auto schickt seine Technik-Werte an die Bridge
  (Web-Port und Namespaces, Karte, Sprache, Verbindung). `/coilshift:status`
  zeigt sie, `bridge.log` protokolliert jede Änderung.
- **Fehlerseite:** Hat Chromium einmal eine Fehlerseite gezeigt, lädt die Kachel
  nicht von selbst neu. Nach dem Update die Kachel schließen und neu öffnen.

## Version 0.1.0-alpha.6

Per SSH am Auto (Firmware 2026.32.7) gefunden: Der Web-Dienst lief seit
alpha.1 nie.

- **Ursache:** CoilShift startet einen Dienst mit Web-Port über
  `nsenter --net=/run/netns/chromium-entertainment`. Auf dieser Firmware sind
  `/run` und `/var/run` aber getrennte tmpfs, und die Browser-Namespaces liegen
  nur unter `/var/run/netns`. `nsenter` scheiterte bei jedem Start. Der
  Supervisor zog den Dienst zurück und räumte dabei auch den `link`-Dienst ab.
- **Lösung:** Der Apply-Hook legt bei jeder Installation über die Car-API
  (`PUT /v1/binds`, im Ledger, beim Entfernen rückgängig) einen Bind-Mount
  `/var/run/netns/<ns>` → `/run/netns/<ns>` an. Das geschieht nur, wenn `/run`
  und `/var/run` getrennt sind. Entsteht der Namespace erst nach dem Apply,
  holt der `link`-Dienst den Bind-Mount nach und startet den Web-Dienst neu.
  **Technik** zeigt dazu `web.bind` und `web.service`.
- **Für CoilShift:** Der Daemon sollte für `nsenter` den Pfad
  `/var/run/netns/<ns>` verwenden (oder `ip netns exec`). Dann wäre der
  Bind-Mount überflüssig.

## Version 0.1.0-alpha.7

Kein eigener Reiter mehr in der CoilShift-App: Die App ist die Kachel im
Launcher.
- Das Paket deklariert kein Panel mehr, die Dateien der Kachel liegen unter
  `web/`.
- Der Panel-Modus samt Nur-Lese-Ausweichweg (`state.json`, `endpoint.json`)
  entfällt.
- Unter **Technik** stehen zusätzlich der Zustand des Web-Dienstes und des
  Namespace-Binds.

## Version 0.1.0-alpha.8

Der Einrichtungsschritt in der App und die Handy-Seite hinter dem QR-Code nennen
die Befehle, mit denen das Claude-Code-Plugin auf dem Mac installiert wird. Der
Code muss dafür nicht auf der Platte liegen:
`claude plugin marketplace add appenetic/cs-extensions` und
`claude plugin install coilshift@appenetic`.

## Entwicklung und Validierungsstand

Quellcode: `services/claude/` (Go, privat wie der HA-Dienst, ignoriert von git),
`claude-code/coilshift/` (Node, ohne Abhängigkeiten) und `packages/claude/web/`.

```sh
GO=go tools/build-claude.sh                     # statisch, linux/amd64 v1, reproduzierbar
go -C services/claude test -race ./...          # inkl. Ende-zu-Ende gegen die echte Node-Bridge
node --test claude-code/coilshift/tests/ tests/claude-app.test.mjs
python3 -m unittest discover -s tests -v
python3 tools/build.py
```

Siehe [Validierungsbericht](../../docs/claude-validation.md). Seit alpha.8 läuft
das Paket am Auto (Model Y, Firmware 2026.32.7). Laut Nutzer funktioniert alles.
