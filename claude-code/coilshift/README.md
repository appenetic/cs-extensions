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
| `commands/*.md` | `/coilshift:pair`, `/coilshift:status`, `/coilshift:away on\|off\|auto` |

## So kommen Antworten in die Sitzung

| Fall | Weg |
| --- | --- |
| `AskUserQuestion` oder Freigabe im Unterwegs-Modus | Der Hook wartet auf das Auto. Er antwortet mit `updatedInput.answers` beziehungsweise `decision.behavior` |
| Text an eine laufende Sitzung | Das Relay der Sitzung schreibt ihn in ihren Inbox-Socket |
| Text an eine beendete Sitzung | `claude --bg --resume <id> "[Aus dem Auto] …"` |
| Neue Sitzung | `claude --bg -n "Auto · …" "[Aus dem Auto] …"` im gewählten Projekt |

Warum das Relay: Claude Code liefert Inbox-Nachrichten fremder Prozesse in einer
Sitzung mit `--dangerously-skip-permissions` nicht aus. Sie warten dann auf
Bestätigung. Nachrichten eigener Kindprozesse liefert es sofort aus. Das Relay
ist ein solcher Kindprozess.

Hooks blockieren Claude Code nie. Fehlt die Bridge oder antwortet sie nicht,
läuft alles weiter wie ohne Plugin.

Kosten: Jede Sitzung hat ihren Relay-Prozess, real etwa 21 MB (`footprint`).
Die Bridge fragt `claude agents --json` alle 8 Sekunden ab, solange ein Auto
verbunden ist, sonst jede Minute. Ein Aufruf dauert etwa 0,2 Sekunden.
Sitzungen ohne Hooks (vor der Installation gestartet) verfolgt sie über die
Änderungen an ihrem Transkript.

## Daten und Einstellungen

Die Daten liegen in `~/.claude/plugins/data/coilshift-appenetic/` (Modus 0700):

- `config.json`: Port, gekoppelte Autos (nur Token-Hashes), Unterwegs-Modus,
  `permission_mode` für Sitzungen aus dem Auto (`default`, `acceptEdits`, `plan`
  oder `bypassPermissions`) und `wait_minutes` (1–120, Vorgabe 20)
- `cert.pem` und `key.pem`: das selbst signierte Zertifikat, das das Auto pinnt
- `bridge.log`

Umgebungsvariablen:
- `COILSHIFT_PORT` (Vorgabe 47621)
- `COILSHIFT_HOSTS`: Adressen im Kopplungslink, etwa ein MagicDNS-Name
- `COILSHIFT_CLAUDE_BIN`

Gibt es auf dem Mac keine LAN- oder Tailscale-Adresse, nennt `/coilshift:pair`
keinen Link.

`/coilshift:status` zeigt die gekoppelten Autos, den Unterwegs-Modus, die
Sitzungen und die letzte Diagnose jedes Autos: Web-Port, Karte, Sprache und
Verbindung (ab Paket alpha.5). `coilshift-bridge.mjs unpair` entkoppelt alle
Autos.
