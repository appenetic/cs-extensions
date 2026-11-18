# CoilShift-Plugin für Claude Code

Die Mac-Seite der [Claude-App für die Tesla-MCU](../../packages/claude/README.md).
Es hat keine Abhängigkeiten: nur Node (ab 22) und `openssl` aus macOS.

```sh
claude plugin marketplace add appenetic/cs-extensions   # öffentlich, auch für Kollegen
claude plugin install coilshift@appenetic
```

Aus einem ausgecheckten Repository: `claude plugin marketplace add ./`.

## Bestandteile

| Datei | Aufgabe |
| --- | --- |
| `bin/coilshift-bridge.mjs` | Der Bridge-Dienst. Er startet mit der ersten Sitzung und läuft weiter. Er ist zugleich die CLI hinter den Befehlen |
| `bin/coilshift-hook.mjs` | Hooks: Sitzungsstart und -ende, Prompts, Werkzeuge, Turn-Ende, Fragen und Freigaben |
| `bin/coilshift-relay.mjs` | Ein MCP-Server ohne Werkzeuge pro Sitzung (`plugin:coilshift:inbox`). Er schreibt Text aus dem Auto in den Inbox-Socket seiner Sitzung |
| `lib/relay.mjs` | Das Internet-Relay: Verbindung zum Auto über einen öffentlichen MQTT-Broker, Ende-zu-Ende-verschlüsselt, wenn das Auto den Mac nicht direkt erreicht |
| `commands/*.md` | `/coilshift:pair [Code]`, `/coilshift:status`, `/coilshift:away on\|off\|auto` |

## So kommen Antworten in die Sitzung

| Fall | Weg |
| --- | --- |
| `AskUserQuestion` oder Freigabe im Unterwegs-Modus | Der Hook wartet auf das Auto. Er antwortet mit `updatedInput.answers` beziehungsweise `decision.behavior` |
| Text an eine laufende Sitzung | Das Relay der Sitzung schreibt ihn in ihren Inbox-Socket |
| Text an eine beendete Sitzung | `claude --bg --resume <id> "[Aus dem Auto] …"` |
| Neue Sitzung | `claude --bg -n "Auto · …" "[Aus dem Auto] …"` im gewählten Projekt |

Warum das Inbox-Relay: Claude Code liefert Inbox-Nachrichten fremder Prozesse in einer
Sitzung mit `--dangerously-skip-permissions` nicht aus. Sie warten dann auf
Bestätigung. Nachrichten eigener Kindprozesse liefert es sofort aus. Das
Inbox-Relay ist ein solcher Kindprozess.

Hooks blockieren Claude Code nie. Fehlt die Bridge oder antwortet sie nicht,
läuft alles weiter wie ohne Plugin.

Kosten: Jede Sitzung hat ihren Relay-Prozess, real etwa 21 MB (`footprint`).
Die Bridge fragt `claude agents --json` alle 8 Sekunden ab, solange ein Auto
verbunden ist, sonst jede Minute. Ein Aufruf dauert etwa 0,2 Sekunden.
Sitzungen ohne Hooks (vor der Installation gestartet) verfolgt sie über die
Änderungen an ihrem Transkript.

## Daten und Einstellungen

Die Daten liegen in `~/.claude/plugins/data/coilshift-appenetic/` (Modus 0700):

- `config.json`: Port, gekoppelte Autos (Token nur als Hash, dazu je Auto der
  Schlüssel des Internet-Relays), Unterwegs-Modus,
  `permission_mode` für Sitzungen aus dem Auto (`default`, `acceptEdits`, `plan`
  oder `bypassPermissions`) und `wait_minutes` (1–120, Vorgabe 20)
- `cert.pem` und `key.pem`: das selbst signierte Zertifikat, das das Auto pinnt
- `bridge.log`

Umgebungsvariablen:
- `COILSHIFT_PORT` (Vorgabe 47621)
- `COILSHIFT_HOSTS`: Adressen im Kopplungslink, etwa ein MagicDNS-Name
- `COILSHIFT_CLAUDE_BIN`
- `COILSHIFT_RELAY`: Broker des Internet-Relays als `host[:port]` (MQTT über TLS,
  Port 8883), kommagetrennt, oder `off`. Vorgabe: `broker.emqx.io` und
  `broker.hivemq.com`

Gibt es auf dem Mac keine LAN- oder Tailscale-Adresse, nennt `/coilshift:pair`
keinen Link. Die Kopplung per Code geht dann trotzdem.

## Internet-Relay

Ohne Tailscale und ohne gemeinsames WLAN erreichen sich Mac und Auto nicht
direkt. Dann bauen beide eine ausgehende TLS-Verbindung zu einem öffentlichen
MQTT-Broker auf. Die Bridge hält sie zu allen Brokern der Liste, das Auto nur
zu einem.

- Das Auto fragt wie sonst per HTTPS: dieselben Routen, als verschlüsselte
  Nachricht. Lange Antworten gehen in Teilen zu 32 KB.
- Geht der direkte Weg wieder, etwa im heimischen WLAN, kehrt das Auto binnen
  zwei Minuten dorthin zurück.
- Kopplung ohne gemeinsames Netz: Die App im Auto zeigt einen Code. Ihn mit
  `/coilshift:pair K7QM-4ZP2-XR9T-HB3D` angeben. Der Befehl wartet bis zu 90
  Sekunden, bis sich das Auto meldet.

Das Format (Kanäle, Schlüssel, Teile) steht oben in `lib/relay.mjs`. Die
Gegenseite im Auto ist `services/claude/relay.go` (privat, nicht im
Repository); die beiden müssen übereinstimmen. `tests/relay.test.mjs` und der
Go-Test prüfen dieselben Testvektoren.

`/coilshift:status` zeigt die gekoppelten Autos, den Unterwegs-Modus, den
Zustand des Internet-Relays, die Sitzungen und die letzte Diagnose jedes
Autos: Web-Port, Karte, Sprache, Verbindung (ab Paket alpha.5) und den Weg zum
Mac (ab alpha.9). `coilshift-bridge.mjs unpair` entkoppelt alle
Autos.
