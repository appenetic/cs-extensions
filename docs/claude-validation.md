# Claude Code für CoilShift: Validierung, 2026-11-17

Version `0.1.0-alpha.1`, Plugin `coilshift` 0.1.0, Claude Code 2.1.304, Go 1.27.4,
Node 26. Der Bericht beginnt mit dem Stand vor dem ersten Test am Auto; die
Abschnitte am Ende halten die Befunde am Auto fest.

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
7. Ob das Internet-Relay (alpha.9) ohne Tailscale trägt: Kopplung per Code,
   dann im Mobilfunk „Weg zum Mac“ unter Technik. Vom Auto aus erreichbar waren
   am 2026-11-18 `broker.emqx.io:8883` und `broker.hivemq.com:8883`, über WLAN
   und über das Mobilfunk-Interface `eth0.2`.

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

## Am Auto per SSH, 2026-11-17 (alpha.5)

- **Firmware:** 2026.32.7, Model Y. `/run` und `/var/run` sind getrennte tmpfs,
  `/run/netns` fehlt. Unter `/var/run/netns` liegen `carplay`, `chromium` und
  `chromium-entertainment`.
- **Startskript:** `/run/ssp/services/com.appenetic.claude.web/run` ruft
  `nsenter --net=/run/netns/chromium-entertainment` auf und scheitert daran.
  Der Dienst stand mit Backoff 60 auf `down-by-ssp`. Der `link`-Dienst war danach
  `absent`, sein Dienstverzeichnis fehlte.
- **Im Browser-Namespace** `chromium-entertainment` lauschen der CoilShift-Port
  29942 und die Web-Ports anderer Pakete.
- **Diagnose von alpha.5:** Karte `ok` (UI-Host aktiv), Sprachtaste
  `bereit · GUI_carAssistUserTranscript` (lesbar, nicht geschwärzt).
- **Handtest:** Ein Bind-Mount über `PUT /v1/binds` und danach
  `POST /v1/services/web/restart` ließen den Web-Dienst laufen. Er lauscht auf
  127.0.0.1:29899 in `chromium-entertainment`. alpha.6 macht das automatisch.

## alpha.7

Wunsch aus dem Auto: Die App reicht als Kachel im Launcher, ein Reiter in der
CoilShift-App ist überflüssig.
- Das Panel ist entfernt, die Kachel-Dateien liegen unter `web/`.
- Die App-Tests laufen jetzt im Kachel-Modus.
- Archiv- und Export-Tests verlangen, dass das Paket kein Panel deklariert.

## Am Auto bestätigt (alpha.8)

Model Y, Firmware 2026.32.7, 17.11.2026: Nach dem Update auf alpha.8 meldet der
Nutzer „funktioniert alles“.
- **Diagnose an die Mac-Bridge:** Verbindung online, Web-Dienst läuft,
  Namespace-Bind ok, Karte über der Navi ok, Sprach-Transkript bereit.
- **Plugin:** Die Installation von GitHub
  (`claude plugin marketplace add appenetic/cs-extensions`) funktioniert in
  einer isolierten Claude-Code-Konfiguration.

## Am Auto, 2026-11-18 (bis alpha.22)

- **Karte über der Navi:**
  - Der UI-Host benennt den Datenkontext nach der Vorlagendatei. alpha.13
    nannte sie `card-<hash>.uiml`, alle Bindungen blieben leer, die Karte war
    unsichtbar. Seit alpha.14 liegt sie als `ui/card-<hash>/card.uiml` in einem
    Ordner, der nach ihrem Inhalt heißt.
  - Tipps kommen kleingeschrieben an (`card tap opt4`). Bis alpha.17 hat der
    Link-Dienst sie deshalb verworfen. Mit alpha.18 beantwortet ein Tipp die
    Frage, am Auto bestätigt.
  - Paketdienste laufen mit umask 0077. alpha.18 legte den Vorlagenordner mit
    0700 an, QtCar konnte die Vorlage nicht lesen (`cannot read the template`).
    Am Auto von Hand korrigiert, in alpha.19 behoben.
- **Musik beim Vorlesen (alpha.21):** Der Touchscreen hält Apple Music mit
  `com.tesla.ChromiumAdapterDbus.togglePause("AppleMusic", true)` an und spielt
  mit `togglePlay` weiter. Mitgeschnitten am 2026-11-18, root darf das laut
  `com.tesla.MusicDbus.conf`. Von Hand geprüft: Pause nach 1 s sichtbar in
  `GUI_mediaPlaybackStatus`, Weiterspielen sofort. Andere Quellen ungeprüft.
  Während die App vorliest, meldet `GUI_mediaNowPlayingSource` „msBrowser“ und
  erst nach dem Ende wieder „AppleMusic“; alpha.21 hielt das für einen Wechsel
  von Hand und spielte nicht weiter. Der Medienserver schläfert Apple Music
  dabei ein (`sleepPlayback`, `toggleStop`) und stellt nach dem Vorlesen den
  letzten Zustand wieder her (`restorePlayback(…, "paused")`, etwa 1,5 s).
  alpha.22 wartet bis zu 5 s auf die Quelle, dann 2 s, spielt weiter und prüft
  es, sonst noch einmal.
- **Bestätigt (alpha.22):** Apple Music hält beim Vorlesen an und spielt danach
  weiter (`angehalten: AppleMusic` um 15:19:47 UTC, `weitergespielt:
  AppleMusic` um 15:20:09). Früher offen: Weiterspielen nach dem Vorlesen.
- **Bestätigt (alpha.20):** Vorlesen spielt im Auto (`web.audio=aac=probably ·
  stimmen=0`, `web.play=ok`). Früher offen: Vorlesen. Die App meldet `web.audio` (spielt das Auto
  AAC, hat Chromium eigene Stimmen, bleibt die Seite im Hintergrund) und nach
  jedem Versuch `web.play`. Teslas eigene Sprachdienste (`NuanceServer`,
  `SpeechDbus`) waren am 2026-11-18 nicht auf dem System-Bus.
- **Bestätigt (alpha.19):** Ein eingefügter Screenshot erscheint in der App
  unter dem Prompt. Früher offen: Bilder aus Prompts in der App, also Vorschau,
  Vergrößern per Tipp und Laden über das Internet-Relay. Auf dem Mac sind sie
  mit Tests und gegen ein echtes Transkript geprüft (28 MB, Bild in 53 ms
  gefunden, in 72 ms auf 1024×685 verkleinert, 123 KB).

## Neustart nach Updates (alpha.23)

Vom Nutzer weitergegebener Hinweis: Ein Update legt die neuen Dateien ab,
startet die Dienste aber nicht verlässlich neu, und das alte Binary läuft
weiter. Beim Ersetzen des Pakets schreibt der Daemon einen neuen Token nach
`$CSDK_RUN/token`. Beide Dienste, `link` und `web`, lesen die Datei alle 2 s.
Steht zweimal hintereinander ein anderer Token darin als ihr eigener, fahren sie
herunter wie bei SIGTERM und enden mit Exit-Code 3. Bei `restart: on-failure`
nimmt das `finish`-Skript einen Dienst nach Exit 0 ganz herunter (`sv d`, am
Auto gelesen); nach Exit 3 startet er nach 2 s neu, aus dem `run`-Skript der
neuen Version. Auf dem Mac geprüft: neuer Token → Exit 3 nach etwa 2,5 s,
SIGTERM → sofort Exit 0. Am Auto prüfbar erst beim Update nach alpha.23.

## Deutsch und Englisch (alpha.24, Plugin 0.2.11)

Wunsch des Nutzers: das Claude-Plugin zweisprachig, wie die Quiet-Ansicht.
- **Im Auto:** Der `link`-Dienst liest `GUI_locale` vor allem anderen und dann
  einmal pro Minute, der `web`-Dienst ebenso. Deutsch, wenn die Sprache `de`
  ist, sonst Englisch; unbekannt bleibt Deutsch. Der View trägt `lang`, die App
  tauscht ihre Texte danach und baut die Seite neu, ohne Getipptes zu
  verlieren. Karte über der Navi: Titel, Hinweis und die Beschriftungen
  Erlauben/Ablehnen/Schließen kommen aus dem Modell (`{card.lallow}`,
  `{card.ldeny}`, `{card.lclose}`). Kopplungsseite am Handy, Diagnose und
  Statusmeldungen folgen ebenfalls. Sprachantworten verstehen Deutsch und
  Englisch („Variante zwei“, „option two“, „ja“, „yes“).
- **Zur Bridge:** Der Long-Poll schickt `lang=de|en` mit. Die Bridge merkt sich
  die Sprache des Autos und formuliert danach, was ins Auto geht: Fragen,
  Freigaben, Fehlermeldungen, den Hinweis „[Aus dem Auto]“ an Claude und die
  Stimme beim Vorlesen (Englisch: Samantha und andere, Deutsch: Anna). Ohne
  `lang`, also bei einem älteren Paket, bleibt alles Deutsch.
- **Auf dem Mac:** Die Ausgaben der Befehle (`pair`, `status`, `away`, `stop`)
  folgen der Sprache des Macs. Plugin- und Marktplatz-Beschreibungen sind
  Englisch, die READMEs bleiben Deutsch.
- **Geprüft:** Go-Tests (Sprachregel, Karte auf Englisch samt Abgleich mit
  `card.uiml`, `lang` im View und in der Anfrage, Kopplungsseite, Sprachantworten),
  App-Tests in beiden Sprachen und beim Wechsel, Plugin-Tests für die Sprache
  des Autos und des Macs. Am Auto offen: ob die drei neuen Beschriftungen der
  Karte erscheinen. Die geänderte Vorlage meldet der UI-Host wie bisher erst
  nach einem Neustart der Oberfläche an.
