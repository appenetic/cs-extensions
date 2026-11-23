# Appenetic CS Extensions

Experimental SDK packages for Tesla MCU.

## Public feed without application source

Publish only the output of `python3 tools/export-public-feed.py --output dist/public-feed`
into a separate artifacts repository. The export follows the private-source/public-feed
pattern and includes only the compiled Home Assistant and Claude Code packages. Their
Go source stays local/private and is ignored by this public checkout. See
[release separation and publishing](docs/private-source-public-feed.md).

## Claude Code (neu, experimentell)

Zeigt die Claude-Code-Sitzungen des Macs als eigene App-Kachel auf der MCU. Du
kannst sie verfolgen und vom Auto aus weiterarbeiten lassen. Fragen erscheinen
als Karte über der Navi, beantwortet werden sie per Touch, Diktat oder Sprachtaste.
Gekoppelt wird per QR-Code. Dazu gehört das Claude-Code-Plugin `coilshift` auf
dem Mac. Es ist öffentlich, auch für Kollegen:
`claude plugin marketplace add appenetic/cs-extensions`, dann
`claude plugin install coilshift@appenetic`.
[Einrichtung und Grenzen](packages/claude/README.md) ·
[Validierung](docs/claude-validation.md). Läuft seit alpha.8 am Auto
(Model Y, Firmware 2026.32.7).

## Welcome-Animation (neu, experimentell)

Zwei Pakete, „Welcome-Animation Performance“ und „Welcome-Animation Launch
Series“. Beim Einsteigen spielen sie die Animation dieser Ausstattung mit ihrem
Ambientelicht. Installieren schaltet ein, Deinstallieren zurück auf ab Werk;
es kann nur eins wirken. Sie legen per CoilShift-`overlay` Kopien über die
Startskripte des Intro-Dienstes und über die Lichtanimationen der Oberfläche.
Am Fahrzeug wird kein Wert geschrieben.
[Funktionsweise](packages/welcome-performance/README.md) ·
[Validierung](docs/welcome-animation-validation.md). Am Auto bisher nur lesend
durchgespielt.

## Quiet-Ansicht (neu, experimentell)

Nach dem „Quiet Mode“ von FSD v15: eine App mit eigener Kachel im Launcher. Sie
öffnet sich direkt maximiert, auch in D, und zeigt einen animierten Lichtschein
in der Farbe des Ambientelichts. Die Lichtbahnen biegen sich mit der Kurve, die
du fährst, ihre Pulse laufen mit deinem Tempo und blinken mit dem Blinker. Darüber ruhig Tacho, Ankunft, nächste Abbiegung und
Fortschritt; bei Warnungen schließt sie sich selbst. Fest nach unten wischen
schließt sie, lange drücken öffnet die Optionen.
[Funktionsweise](packages/quiet-view/README.md) ·
[Validierung](docs/quiet-view-validation.md).

## Home Assistant Bridge

New experimental package: [setup and limitations](packages/home-assistant/README.md).
Publishes GPS coordinates, speed, battery state of charge and driver-door state to Home Assistant over HTTPS.
Includes Cloud URL, username, secret password and optional API-token settings.
Includes a static x86_64 Linux service, verified in the firmware userland under
QEMU with local HTTPS/SDK test servers. Requires verified vehicle DataValue names;
live vehicle telemetry and a real HA instance remain untested. Disabled by default.


**Welcome Light is an unverified prototype, not a validated approach-light feature.**
It is disabled by default. Its current trigger is a locked-to-unlocked transition;
this can include remote unlock and does not detect your phone before unlocking.
Physical DRL and tail-light operation has not been verified.

The supplied 2026.38.5.12 firmware was inspected as data. It contains a temporary
`GUI_halloweenLightSwitchRequest` override with a `ParkingLights` enum. The SDK
writes through QtCarServer's Debug interface. It has not been established that
writing that listener copy reaches QtCarVehicle, so a successful API response
must not be interpreted as working exterior lights. See [validation](docs/validation.md).

## Package behavior

The experimental service requests `ParkingLights` for 5–30 seconds after unlock,
only with a confirmed `P` gear and `VAPI_driverPresent=false`. It requires a locked
baseline after startup, prevents repeated triggers with a cooldown, and releases
its SDK ledger entry on timeout, re-lock, occupancy, leaving Park, missing data,
disable, service restart, termination, and package removal. A failed release
remains pending and is retried on service restart. The SDK restores the previous
value; the package does not force the car's lighting switch to Off.

There is no proximity-range measurement, MCU wake mechanism, DRL-specific request,
or proof that a parking-light request produces the requested lamp combination.
The process must already be running to see a transition; it cannot detect one
that happened while the MCU was asleep. It refuses firmware other than 2026.38.5.12.

## Repository and installation

The stable Home Assistant package repository index URL is:

```
https://appenetic.github.io/cs-extensions/index.json
```

GitHub Actions validates and publishes the current compiled Home Assistant release
after feed updates on `main`. The URL stays the same for future versions.
The original feed (including Welcome Light) remains available at
`https://raw.githubusercontent.com/appenetic/cs-extensions/main/repository/index.json`.

The index is `repository/index.json`; archives are content-addressed under
`repository/pool/`. Add the index URL in the package manager, then select
**Welcome Light (experimental)**. Leave the experimental setting disabled until
the control path has been validated. Installation does not prove physical operation.

## Development

```
python3 -m unittest discover -s tests -v
python3 tools/build.py
```

Tests exercise the Bash state machine and curl against a fake local Unix-socket
HTTP server. They do not simulate the body controller or authenticate phone keys.
When available, also use the SDK's proprietary release tools:

```
csdk lint packages/welcome-light
csdk test packages/welcome-light
csdk build packages/welcome-light -o /tmp/welcome-light.csp
```

`tools/build.py` implements the documented tar/index format with Python's standard
library; it is not a replacement for official SDK validation.

Offline QEMU smoke and full-service tests passed inside the supplied firmware
userland using its Bash and curl. A native QtCarServer test also verified
D-Bus write/readback and restoration of the candidate light override. See the validation record for the exact scope and the
`tools/test-target-vm.py` reproduction command. No SDK binaries,
Tesla binaries, firmware dumps, credentials, or vehicle identifiers are included.
