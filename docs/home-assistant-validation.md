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
