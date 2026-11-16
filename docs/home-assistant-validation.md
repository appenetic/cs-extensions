# Home Assistant Bridge validation — 2026-11-15

Version tested: `0.1.0-alpha.2`, ZEN3 `2026.38.5.12` firmware userland,
QEMU x86_64 TCG, Alpine test kernel. The firmware drive was read-only; there was
no network adapter. SDK and Home Assistant were local Unix-socket/HTTPS test doubles.

## Findings and corrections

- The original Python implementation could not run on the supplied MCU firmware:
  QEMU confirmed `python3: command not found` and the expected `unsupported`
  status. Replaced it with a static Linux AMD64 v1 Go executable. No interpreter,
  libc or downloaded runtime is needed on the MCU.
- Package storage is `noexec`. The production shell hook now copies the binary
  into the SDK's executable boot directory (`CSDK_RUN`) before starting it.
- Network failures previously discarded refresh tokens and caused unnecessary
  password logins. Cached tokens now survive transport failures; authentication
  rejection invalidates them. A rejected refresh grant can fall back to a new login.
- Retry waits could delay disabling the plugin for up to five minutes. Settings
  are now checked every second during waits, including changes during a send cycle.
  SIGTERM/SIGINT cancel active HTTP requests as well as waits. Disabling is applied
  after any current cycle completes; each SDK/remote request has a 3/10 s timeout.
- The SDK appends one newline to settings. The reader now removes exactly that
  delimiter, preserving any trailing newline belonging to a password.

## Results

The eight Go tests passed inside QEMU, including `TestProductionService`, which
runs the actual packaged binary through the unchanged production `service.sh`.
The package directory was mounted read-only and `noexec`. The firmware system
trust store contained 141 CA certificates. The positive service test used its own
local test CA through `SSL_CERT_FILE`; no TLS verification bypass was used.

Coverage:

- Username/password flow, JSON escaping and password preservation.
- Access-token priority, caching and refresh.
- GPS, speed conversion, boolean door state, combined tracker attributes and three
  HA entity payloads over actual HTTP connections.
- Missing/invalid telemetry becomes `unavailable`, without stale GPS coordinates.
- Invalid URL rejection, MFA challenge rejection and HTTP 401 handling.
- Rejection of untrusted TLS certificates and redirects without forwarding secrets.
- Valid tokens survive transport failures; disabling interrupts a 300 s retry wait.
- Clean termination of the actual service process using SIGTERM.

Host checks: Go tests with the race detector (production Linux subprocess test
skipped on macOS), `go vet`, and all 12 Python package/regression tests passed.
The binary rebuild was byte-identical using Go 1.27.4, CGO disabled, `-trimpath`,
`-buildvcs=false`, stripped symbols and an empty build ID.

Binary SHA-256:

```
5445d108089cb1281ec63443e5e071a92825df84922aa7b86164ee1113f6784e
```

The local full QEMU serial log is `/private/tmp/home-assistant-vm.log`.
The runner and test sources are in the repository; reproduction instructions
are in [the package README](../packages/home-assistant/README.md).

## Limits

This does not verify an actual CoilShift daemon, MCU internet routing, Nabu Casa,
a live Home Assistant instance, or the real GPS/speed/door DataValues. Those four
DataValue settings remain empty until their names, units and semantics have been
verified on the target vehicle. The tests do not simulate vehicle ECUs or physical
sensors. Official proprietary `csdk` lint/harness/build tools were not available.

The States API publishes state objects, not registered integration entities or
HA devices. A sleeping/offline MCU cannot mark its last values unavailable;
consumers must check `updated_at`. The tracker does not calculate Home zones.

## Ergänzende Offline-Analyse

Die DataValue-Namen wurden anschließend in der Firmware ermittelt und mit dem
echten QtCarServer unter QEMU geprüft. Siehe [Ergebnisse und GPS-Genauigkeitsgrenze](home-assistant-datavalues.md).
Die Bestätigung am realen Fahrzeug steht weiterhin aus.

## Version 0.1.0-alpha.3: SoC und Installationskorrektur

Die SDK-Dokumentation verlangt für Enum-Werte das Muster
`[A-Za-z0-9][A-Za-z0-9_.-]*`. Die bisherigen Werte `km/h` und `m/s` verletzten
diese Regel und verhinderten die Installation. Das Manifest verwendet jetzt
`kph`, `mps`, `mph`; die UI-Beschriftungen bleiben unverändert. Der Paketbauer
prüft diese Regel nun vor dem Archivbau, mit einem Regressionstest für den
ursprünglichen Fehler.

SoC wird als `sensor.coilshift_car_soc` (Geräteklasse `battery`, Einheit `%`)
und als `battery_level`-Attribut des Trackers übertragen. Die Quelle ist
konfigurierbar, Vorgabe `VAPI_batteryLevel`; Werte außerhalb 0–100 werden
`unavailable`. Die neun Go-Tests einschließlich Produktionstest bestanden im
Firmware-QEMU sowie auf dem Host mit Race Detector. Kein Live-Fahrzeugtest.

## Version 0.1.0-alpha.4: SDK-Einstellungspanel

Das Manifest deklariert jetzt die Fähigkeit `panel` und die eigene Seite
`panel/index.html` mit `settings.read`, `settings.write` und `status`.
Die unveränderte SDK-Brücke und das SDK-Stylesheet wurden unter Apache-2.0
übernommen; Lizenzhinweise sind im Paket enthalten.

Sieben Node-Tests gegen den SDK-Panel-Host prüfen Einstellungen, Geheimnisfelder,
gezieltes Löschen, Profilübernahme, die Reihenfolge Deaktivieren/Speichern/Aktivieren,
Eingabevalidierung, unveränderte Eingaben beim Statuspolling und Teilfehler.
Alle 19 Paket-/Regressionstests bestehen. Die Dienst-Binärdatei wurde nicht
verändert; ein Test in der tatsächlichen CoilShift-App steht noch aus.

## Version 0.1.0-alpha.5: Verbindungsdiagnose und erneutes Laden

Beim Panel-Start wurden Einstellungen bisher nur einmal geladen. Eine späte
Host-/Manifestregistrierung ließ alle Eingaben dauerhaft deaktiviert. Das Panel
wiederholt fehlgeschlagene Ladeversuche und zeigt die Einstellungsverbindung
oberhalb der Eingaben. Fehlende Einstellungsnamen und explizite Host-Sperren
werden unterschieden; Host-Sperren werden nicht umgangen. Zehn Paneltests
bestehen, darunter verspätete Registrierung, Zugriffsverweigerung und gesperrte
Felder. Die Ursache in der vom Nutzer gemeldeten Live-Installation steht noch aus.

## Version 0.1.0-alpha.6: Fahrstufe

Der Dienst liest die Fahrstufe über `GET /v1/vehicle/gear`, deklariert
`vehicle.read` und sendet `sensor.coilshift_car_gear` sowie das Tracker-Attribut
`gear`. Unterstützt werden `P`, `R`, `N`, `D` und deren ausgeschriebene Namen.
Unbekannte Werte, numerische Enums und HTTP-Fehler ergeben `unavailable`;
ein voriger gültiger Wert wird nicht als aktuelle Fahrstufe weitergesendet.

Alle zehn Diensttests bestehen im Firmware-QEMU und auf dem Host mit Race Detector,
inklusive des echten Produktionsdiensts. Zusätzlich bestehen zehn Paneltests,
19 Paket-/Regressionstests und `go vet`. Live-SDK-/Fahrzeugprüfung steht aus.

## Version 0.1.0-alpha.7: Expliziter Panel-Scope

Die gemeldete Antwort mit null Einstellungen zeigt, dass der bisherige Retry
allein die betroffene Installation nicht repariert. Das Manifest benennt nun
alle 13 eigenen Einstellungen explizit in `panel.settings`, analog zum
veröffentlichten Blitzer-Panel des Referenzrepositories. Das SDK beschreibt auch
eine implizite Freigabe eigener Einstellungen; auf diese wird nicht mehr allein
vertraut. Die genaue Live-Ursache ist damit noch nicht bewiesen.

Ein zusätzlicher Paneltest simuliert einen Host, der ausschließlich explizit
freigegebene Einstellungen liefert. Er prüft vollständige Anzeige sowie einen
Speichervorgang. Elf Paneltests bestehen. Der Paketbauer prüft außerdem, dass
die expliziten IDs dem eigenen Paket gehören; der Regressionstest verweigert
fremde IDs. Keine zusätzliche Berechtigung außerhalb der eigenen Einstellungen.

## Version 0.1.0-alpha.8: Entwürfe bei leerer Host-Antwort

Die aktuelle SDK-Referenz wurde bis Commit `b28793e` geprüft; die dokumentierte
Antwortform ist unverändert. Der Nutzer hat alpha.7 und weiterhin deaktivierte
Eingaben bestätigt. Die vorherige Annahme, expliziter Scope behebe die Live-
Anbindung, ist damit nicht bestätigt.

Die Eingabeseite hängt jetzt nicht mehr vollständig vom ersten Leseergebnis ab.
Sie rendert IDs und Defaults aus einem beim Paketbau erzeugten, rein öffentlichen
Manifest-Schema. Leere Antworten lassen URL, Zugangsdaten und Profilübernahme als
lokalen Entwurf editierbar. Fehlgeschlagene oder spätere Reads überschreiben
keine bearbeiteten Felder. Explizite SDK-Sperren werden weiterhin eingehalten.
Speichern bleibt ein SDK-Aufruf mit vollständiger eigener ID. Fehlercodes werden
ohne Fehlerantwort-Inhalte angezeigt; ein fehlendes Readback wird gesondert
benannt. Zwölf Paneltests bestehen, darunter leeres Read mit erfolgreichem Write
und leeres Read mit abgelehntem Write. Dies beweist nicht, dass der betroffene
Live-Host die Schreibvorgänge akzeptiert.

## Version 0.1.0-alpha.9: Lokale Handy-Eingabe

Der Dienst öffnet für fünf Minuten einen lokalen HTTPS-Einrichtungsserver auf
einem freien IPv4-Port. QR-Codes enthalten private Interface-Adressen und einen
192-Bit-Einmalcode; es werden keine externen QR-Dienste verwendet. Das selbst
signierte, pro Start erzeugte Zertifikat besitzt passende IP-SANs. Erfolgreiche
Übertragung erzeugt nur eine 0600-RAM-Datei für das eigene SDK-Panel und beendet
den Listener. Das Panel übernimmt die Eingaben als Entwurf, speichert nicht
automatisch und ignoriert abgelaufene/wiederholte Nachrichten.

Die fest versionierte QR-Bibliothek wird nur in die private Go-Quellstruktur
vendort. Der öffentliche Export enthält die kompilierte Datei und Lizenzhinweise.
Default-DataValues sind vorbelegt und fortgeschrittene Felder eingeklappt.

Tests: TLS mit explizit vertrautem Test-Zertifikat, Einmalcode, falsche Origin,
ungültige/zu große Eingaben, Ablauf und Löschung bei Dienstende. Die entsprechenden
13 Go-Tests bestehen im Firmware-QEMU, einschließlich echtem Produktionsdienst.
15 Paneltests prüfen u. a. Übernahme ohne automatisches Speichern, kein Replay und
Ignorieren abgelaufener Entwürfe. Im Gast gibt es ausschließlich Loopback, keine
physische WLAN-Schnittstelle: Erreichbarkeit vom Handy ist damit nicht belegt.

## Version 0.1.0-alpha.10: Eigener verschlüsselter Konfigurationsspeicher

Der Nutzer hat `settings.set: not_found` bestätigt. Der SDK-Schreibweg ist damit
in der betroffenen Installation nicht funktionsfähig; seine genaue serverseitige
Ursache bleibt ohne App-/Daemon-Diagnose offen. Statt weiterer Annahmen über
SDK-Registrierung kann der Einrichtungsserver nun explizit direkt in den
paketeigenen persistenten Zustand speichern.

`connection.enc` verwendet AES-256-GCM, einen zufälligen 256-Bit-Schlüssel, eine
neue Nonce pro Speichern und festen Schema-Kontext als AAD. Schlüssel und
Konfiguration sind reguläre 0600-Dateien. Ciphertext wird nach Validierung durch
eine neue Datei und atomisches Rename ersetzt und vor der Bestätigung synchronisiert.
Eine nicht entschlüsselbare Konfiguration wird nicht still überschrieben.

Die Direkt-Konfiguration hat im Dienst Vorrang vor den SDK-Settings und wird im
MCU-Panel als solche angezeigt, einschließlich maskierter Geheimnisse. Um eine
falsche Bestätigung von SDK-Writes zu vermeiden, ist das Panel in diesem Modus
zur Kontrolle gedacht; Änderungen werden über die Handy-Seite vorgenommen.

16 Go-Tests bestehen im Firmware-QEMU, darunter Speichern/Neustart/echte HA-Test-
Übertragung aus der geladenen Konfiguration, Integritätsfehler, Abweisung einer
ungültigen Aktualisierung, Dateimodi und lokale Handy-Speicherung trotz unverändert
deaktivierter SDK-Einstellungen. Der Host-Lauf mit Race
Detector ist ebenfalls erfolgreich; der Linux-Produktionsprozess wird nur in QEMU ausgeführt. 16 Paneltests prüfen auch die lokale Anzeige ohne SDK-Schreibaufrufe.
Kein Test belegt die Erreichbarkeit im konkreten WLAN oder Live-HA-Zugangsdaten.

## Version 0.1.0-alpha.11: Eindeutige UI-Version und neue Asset-Adressen

Der Nutzer sieht nicht nur keinen QR-Code, sondern den gesamten Abschnitt
„Am Handy einrichten“ nicht. Dieser Abschnitt ist seit alpha.9 statisch im
UI-Code enthalten, unabhängig von Dienstzustand/IP-Adresse/Zeitfenster. Das
öffentlich heruntergeladene alpha.10-Archiv wurde überprüft und enthält ihn.
Ein fehlender Abschnitt ist daher mit einer alten/anderen angezeigten Oberfläche
vereinbar, kein Nachweis eines Dienstfehlers.

Der Panel-Einstieg heißt nun `settings-<version>.html`. App, Stylesheet und
Schema werden zusätzlich unter SHA-256-Präfix-Dateinamen referenziert. Die
HTML-Seite enthält eine sichtbare Versionsanzeige außerhalb des dynamischen
Formulars. Der Export prüft Entry-Pfad, Version, referenzierte Dateien und
Asset-Hashes. Der neue Paneltest startet die tatsächlich aus dem Entry
referenzierten Skripte und verlangt Versionsanzeige sowie Handy-Abschnitt,
auch ohne Backend-Dateien. Die Live-Aktivierung auf der MCU bleibt zu prüfen.

## Version 0.1.0-alpha.12: Shared-Address-Space im Einrichtungsfilter

Die vom Nutzer genannte Zieladresse liegt im RFC-6598-/Tailscale-Bereich
`100.64.0.0/10`. Der bisherige Filter ließ nur Go-`IsPrivate` und Loopback zu;
Clients dieses Bereichs wurden dadurch mit 403 abgewiesen. Der Filter erlaubt
nun zusätzlich exakt dieses /10-Netz, sowohl für den Request-Peer als auch bei
der Ermittlung möglicher QR-Adressen. Keine Aufweichung der Token-/Originprüfung.

Zusätzliche Tests decken die /10-Grenzen, weiterhin blockierte öffentliche IPs,
einen Seitenaufruf mit synthetischer Tailscale-Peer-Adresse und eine erfolgreiche
Übertragung mit passendem Code/Origin ab. Falscher Code und fremde Origin werden
auch für Tailscale-Peers abgewiesen. Alle 18 Go-Tests bestehen in QEMU; der Host-
Race-Detector-Lauf und 17 Paneltests sind ebenfalls erfolgreich. Ein echter
Tailnet-Netzwerkpfad wurde nicht simuliert; der nachgewiesene Fehler liegt im
HTTP-Peer-Filter.

Beim Host-Abschlusstest wurde außerdem ein Rennen zwischen asynchroner Dienst-
Bereinigung und Testverzeichnis-Löschung gefunden. Dienst und Tests warten jetzt
auf die abgeschlossene Bereinigung; der Status einer direkt gespeicherten
Konfiguration bleibt dabei `saved` und wird nicht versehentlich `sent`.
