# Claude Code für CoilShift

Experimentelles SDK-1.0-Paket. Zeigt die Claude-Code-Sitzungen deines Macs auf
der MCU. Du kannst sie verfolgen und vom Auto aus weiterarbeiten lassen. Fragen
von Claude erscheinen als Karte über der Navigation. Antworten gibst du per
Touch, per Diktat über die Tesla-Tastatur oder mit der Sprachtaste („Claude, …“).
Gekoppelt wird per QR-Code. Am Fahrzeug selbst wird nichts geschrieben.

## So hängt es zusammen

| Teil | Wo | Aufgabe |
| --- | --- | --- |
| Plugin `coilshift` | Claude Code auf dem Mac | Bridge-Dienst, Hooks und Inbox-Relay je Sitzung, siehe [Plugin-README](../../claude-code/coilshift/README.md) |
| Paket `com.appenetic.claude` | MCU (CoilShift) | Dienst `link` (Verbindung zum Mac, Kopplung, Karte, Sprache) und Dienst `web` (App) |
| Kachel „Claude Code“ | App-Launcher | Die App: Sitzungsliste, Verlauf, Fragen, Antwortfeld, neue Sitzung |
| Panel „Claude Code“ | CoilShift-App | Dieselbe App. Ohne erreichbaren Web-Port nur lesend |
| Karte über der Navi | QtCar über `dev.coilshift.qtcar-host` | Offene Frage mit Antwort-Buttons, auch während der Fahrt |

Das Auto verbindet sich direkt per HTTPS mit dem Mac, über Tailscale oder das
WLAN. Es gibt keinen Cloud-Dienst dazwischen. Im Auto liegen keine
Claude-Zugangsdaten. Die Bridge nutzt nur Schnittstellen, die Claude Code selbst
anbietet: Hooks, `claude agents --json`, `claude --bg` und den Inbox-Socket der
Sitzung.

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
   das erst nach einem Neustart der Oberfläche im Stand. Der Dienst steht auch im
   CoilShift-Panel.
3. **Koppeln:** Die App zeigt ohne Kopplung einen QR-Code.
   - Auf dem Mac `/coilshift:pair` ausführen. Der Kopplungslink landet in der
     Zwischenablage und per Universal Clipboard auch auf dem iPhone.
   - Den QR-Code im Auto mit dem Handy scannen und das lokale Zertifikat einmal
     bestätigen.
   - Auf der Handy-Seite den Link einfügen und **Koppeln** tippen.
   - Auto und Handy müssen die MCU erreichen: im selben WLAN oder über Tailscale.
     Die Tailscale-Adresse steht im QR-Code zuerst.

Der Link gilt zehn Minuten und genau einmal. Er enthält den Fingerabdruck des
Mac-Zertifikats, und das Auto vertraut danach nur diesem Zertifikat.
Neu koppeln geht unter **Technik → Neuen Kopplungs-QR-Code**.

## Bedienung

- **Sitzungen:** alle laufenden Sitzungen (Terminal und Hintergrund) und die der
  letzten drei Tage. Ein Punkt markiert eine offene Frage.
- **Verlauf:** Prompts, Antworten von Claude und Werkzeugaufrufe in Kurzform.
  Text aus dem Auto ist als „Aus dem Auto“ markiert.
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
     Freigaben mit „ja“ oder „nein, …“.
   - Teslas Assistent reagiert zusätzlich selbst auf den Satz.
   - Die Rufwörter lassen sich einstellen. Vorgabe:
     `claude, clod, klod, klaud, cloud, glod`.
   - Transkripte ohne Rufwort werden ignoriert. Nichts davon wird gespeichert
     oder protokolliert.

Der DataValue-Name wurde offline in der Firmware 2026.38.5.12 gefunden, im
`QtCarSpeechRecognizer`. Ob er am Auto lesbar ist oder wie die Navi-Koordinaten
`<redacted>` liefert, zeigt **Technik → Sprachtaste**.

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
- die Verbindung zum Mac
- Web-Port und Netzwerk-Namespace-Modus (`inside`, `setns` oder `current`)
- den Kartenstatus
- den Status des Sprach-DataValues
- die letzte erkannte Sprachantwort

Der Paketstatus in CoilShift folgt der Verbindung.

## Sicherheit

- **Bridge auf dem Mac:**
  - Nimmt nur Verbindungen aus LAN, Tailscale (`100.64.0.0/10`, `fd7a:…`) und
    Loopback an.
  - Das Gerätetoken hat 256 Bit und liegt auf dem Mac nur als SHA-256-Hash.
- **Auto:**
  - Die Kopplung liegt AES-256-GCM-verschlüsselt in `$CSDK_STATE/pairing.enc`.
    Der Schlüssel liegt in `pairing.key`, beide mit Modus 0600.
  - Der Web-Port der App prüft den `Host`-Header gegen DNS-Rebinding.
  - Die API verlangt ein Token, das bei jedem Start neu erzeugt wird. Die
    Kachel holt es nur per Same-Origin. Das Panel liest es über `data.get`.
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

## Entwicklung und Validierungsstand

Quellcode: `services/claude/` (Go, privat wie der HA-Dienst, ignoriert von git),
`claude-code/coilshift/` (Node, ohne Abhängigkeiten) und `packages/claude/panel/`.

```sh
GO=go tools/build-claude.sh                     # statisch, linux/amd64 v1, reproduzierbar
go -C services/claude test -race ./...          # inkl. Ende-zu-Ende gegen die echte Node-Bridge
node --test claude-code/coilshift/tests/ tests/claude-panel.test.mjs
python3 -m unittest discover -s tests -v
python3 tools/build.py
```

Siehe [Validierungsbericht](../../docs/claude-validation.md). Am Auto ist noch
nichts davon geprüft.
