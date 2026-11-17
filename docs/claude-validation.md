# Claude Code für CoilShift: Validierung, 2026-11-17

Version `0.1.0-alpha.1`, Plugin `coilshift` 0.1.0, Claude Code 2.1.304, Go 1.27.4,
Node 26. Am Auto ist noch nichts davon geprüft.

## Auf dem Mac geprüft (Host)

- **Inbox-Zustellung:**
  - In einer Wegwerf-Hintergrundsitzung mit `--dangerously-skip-permissions`
    hat ein MCP-Kindprozess der Sitzung eine Nachricht über
    `CLAUDE_CODE_MESSAGING_SOCKET` zugestellt. Claude hat sofort geantwortet.
  - Dieselbe Nachricht von einem fremden Prozess wurde zurückgehalten
    („Held peer message … not delivered“). Deshalb gibt es das Relay je Sitzung.
  - MCP-Server erhalten `CLAUDE_CODE_MESSAGING_SOCKET` und `…_TOKEN` in ihrer
    Umgebung.
- **AskUserQuestion per Hook:** In einer Hintergrundsitzung beantwortete ein
  `PreToolUse`-Hook mit `permissionDecision: allow` und `updatedInput.answers`
  die Frage. Claude erhielt „User answered Claude's questions: … → Blau“.
- **Plugin live:** In einer `claude -p`-Sitzung mit `--plugin-dir` hat der
  SessionStart-Hook die Bridge gestartet, und das Relay hat sich angemeldet.
  `claude agents --json --all` listet die realen Sitzungen. Alle Testsitzungen,
  Transkripte und Dienste wurden danach entfernt.
- **Zertifikat:** LibreSSLs einstufiges `req -newkey ec` schreibt explizite
  Kurvenparameter, die Go nicht lesen kann. Die Bridge erzeugt den Schlüssel
  deshalb mit `ecparam -param_enc named_curve`.

## Automatische Tests

- **Go mit Race-Detector, 13 Tests:**
  - Kopplungslink, verschlüsselter Speicher (Manipulation wird erkannt),
    Bereinigung der Daten, Sprach-Parser, Kartenmodell (≤ 4095 Byte, Zeilen
    ≤ 1023 Byte), `state.json` ≤ 60 KiB
  - Web-Port: Host-Prüfung, Same-Origin-Bootstrap, CORS-Preflight, Token
  - Handy-Kopplungsseite: Token, Origin, Einmal-Kopplung gegen eine falsche
    Bridge mit gepinntem Zertifikat
- **Ende zu Ende** gegen die echte Node-Bridge:
  - falscher Fingerabdruck, Einmalcode, fremdes Token
  - gehaltene Frage per gesprochener Antwort („die zweite“ → „Blau“), danach 409
  - MCP-Handshake des Relays mit `server/discover` → klassisches `initialize`
  - Inbox-Zeilen (Auth und Nachricht), Rückfrage am Turn-Ende
  - Fortsetzen per `claude --bg --resume`, neue Sitzung, Entkoppeln
- **Systemtest** beider Autodienste gegen einen nachgebauten CoilShift-Daemon:
  - Kachel-HTML und Bootstrap, QR-Kopplung übers „Handy“, Verbindung zum Mac,
    Theme und Fahrstufe
  - Kartenregistrierung, Kartenmodell, Tipp auf „Opt2“ beantwortet die Frage,
    Karte verschwindet
  - Sprach-Transkript ohne Rufwort wird ignoriert, „Claude, die erste bitte“ → „Rot“
  - Diagnose und `state.json`
- **Node:** 10 Bridge-Tests (Transkripte, Hooks, Freigaben, Unterwegs-Modus,
  Discovery, Zustellwege, Kopplung, neue Revision bei Transkript-Änderung) und 7 Panel-Tests mit dem SDK-Testhost
  (Nur-Lese-Fallback, Antwort per Tipp, Eingabefeld bleibt beim Update dasselbe
  Element, Fehler, QR, neue Sitzung). Die 18 HA-Paneltests sind unverändert grün.
- **Python, 21 Tests:**
  - Paketbau deterministisch, Claude-Archiv nur mit Laufzeitdateien
  - öffentlicher Export mit HA und Claude, Quelltext im Archiv wird abgelehnt
  - HA-Archiv weiter byte-identisch (`46c86868…`)
- Das Linux-Binary baut reproduzierbar
  (SHA-256 `7813c0635ec9480d1962d8928ad5a993a3a320193e8ac07a48f0d32246f822f0`).

## Offline aus der Firmware 2026.38.5.12

- **Browser-Namespace:**
  - Web-Ports liegen im Namespace `chromium-entertainment`
    (`/var/run/netns/chromium-entertainment`, veth 37, NAT, Kette `INTERNET`).
  - Der Dienst `web` öffnet seinen Port dort, bei Bedarf per `setns`.
  - Der Dienst `link` bleibt im Root-Namespace, so wie die HA-Bridge, die
    nachweislich ins Internet und ins Tailnet kommt.
- **Sprache:** `QtCarSpeechRecognizer` veröffentlicht `GUI_carAssistUserTranscript`
  (und `GUI_carAssistDictationCount`, `GUI_carAssistSessionId`). Die Tastatur
  kennt `ActiveKeyboardSpeech` und `GUI_keyboardDictationLanguage`.
- **Karte:** Die UIML-Syntax (`ButtonView label="{…}"`, `visible="{…}"`,
  `ProfilePanel/OutlineButton`) stammt aus Teslas eigenen Vorlagen.

## Am Auto offen

1. Ob der Web-Port aus Kachel und Panel erreichbar ist (Diagnose „Web-Port“).
2. Ob die Kachel im Launcher erscheint und die Oberfläche dafür neu startet.
3. Ob der UI-Host installiert ist und wie die Karte aussieht. Die Buttons und
   ihre Tap-Events sind ungeprüft.
4. Ob `GUI_carAssistUserTranscript` lesbar ist oder `<redacted>` liefert, und ob
   der Wert pro Äußerung wechselt.
5. Ob die Tesla-Tastatur in Web-Apps ein Diktier-Mikrofon anbietet.
6. Ob das Auto den Mac über Tailscale oder das WLAN erreicht. Das hängt vom
   Tailnet und der Mac-Firewall ab: Port 47621 muss eingehend erlaubt sein.

## Am Auto, 2026-11-17 (alpha.1)

- **Funktioniert:** Paketinstallation, die Kachel im Launcher, die QR-Kopplung
  und die Sitzungsliste im CoilShift-Panel.
- **Fehler:**
  - Die Kachel zeigt „127.0.0.1 Verbindung abgelehnt“.
  - Das Panel zeigt in jeder Sitzung „Noch kein Verlauf“.
  - Die Liste ist im Panel verschoben.
- **Ursachen und Korrekturen in alpha.2:**
  - Der Web-Port war nur in einem von mehreren Browser-Namespaces offen.
  - `state.json` verwarf bei Platzmangel alle Nachrichten.
  - Das Layout hing an `100vh`, und im Panel-Frame ist diese Höhe unbestimmt.
- **Geprüft:**
  - Neue Go-Tests für die Namespace-Liste und die gekürzte `state.json`.
  - Ein Paneltest für Liste und Detail im schmalen Fenster.
  - Screenshots aus Chrome headless bei 1280×800 und 760×900. Teslas Browser
    ist laut Firmware Chromium 148.
