# Fahrzeug-DataValues ohne Auto ermittelt

Untersuchung vom 2026-11-15, Firmware ZEN3 `2026.38.5.12`.
Die Namen wurden anhand der lokal vorhandenen Firmware ermittelt und im echten
QtCarServer unter QEMU über `com.tesla.Debug.get_data_value` geprüft.
Es wurde keine Verbindung zu einem Auto hergestellt.

## Vorgeschlagene Konfiguration

| Plugin-Einstellung | Wert | Evidenz und Grenze |
| --- | --- | --- |
| `latitude_dv` | `NAV_vehicleLatitude` | Numerischer NavServer-Wert, Name und Datenfluss passen zum Breitengrad. Dezimalgrad ist die naheliegende Interpretation, noch kein Live-Abgleich. |
| `longitude_dv` | `NAV_vehicleLongitude` | Numerischer NavServer-Wert, Name und Datenfluss passen zum Längengrad. Dezimalgrad ist die naheliegende Interpretation, noch kein Live-Abgleich. |
| `speed_dv` | `NAV_vehicleSpeedMph` | Numerischer NavServer-Wert mit expliziter mph-Bezeichnung. |
| `speed_unit` | `mph` | Das Plugin rechnet damit in km/h um. Nicht beim bisherigen Standard `km/h` belassen. |
| `soc_dv` | `VAPI_batteryLevel` | Numerischer Firmware-Kandidat für Akkuladestand in Prozent; in QEMU auf Existenz und Format geprüft, Live-Abgleich fehlt. |
| `door_dv` | `VAPI_driverDoor` | Boolescher Wert; im Fahrzeug-Code aus der vorderen Fahrertür abgeleitet. `true` als offen ist aus dem Code abgeleitet, noch nicht physisch geprüft. |

Die Einstellungen bleiben im Paket zunächst leer, bis die Zuordnung am Zielauto
bestätigt wurde. Die Tabelle ist ein begründetes Firmware-Profil, keine Bestätigung
von Live-Messwerten oder Aktualisierungsraten.

`VAPI_vehicleSpeed` existiert ebenfalls. Seine Einheit ist in dieser Untersuchung
nicht abschließend belegt, deshalb ist `NAV_vehicleSpeedMph` hier die eindeutigere
Wahl. Ein Ausfall des NavServer kann dessen Werte natürlich unverfügbar machen.
`VAPI_driverDoorAlert` ist ein Warnsignal und wird nicht als Ersatz für den
Türzustand empfohlen. `VAPI_doorState` ist ein zusammengesetzter Türstatus.

## Native QEMU-Ergebnisse

Alle acht geprüften Namen (`NAV_vehicleLatitude`, `NAV_vehicleLongitude`,
`NAV_vehicleSpeedMph`, `VAPI_vehicleSpeed`, `VAPI_driverDoor`,
`VAPI_driverDoorAlert`, `VAPI_doorState`, `DOOR_frontDriverDoor`) lieferten:

```
boolean true
string "<invalid>"
```

Das erste Boolean bedeutet **Name gefunden**, nicht Tür offen oder gültige
Messung. Der erfundene Kontrollname lieferte `boolean false` und einen leeren
String. Ohne NavServer-/Vehicle-Publisher sind echte Telemetriedaten im Gast
nicht vorhanden.

Zusätzlich wurden nur im isolierten RAM-Gast künstliche Werte in die
QtCarServer-Kopie geschrieben und über dieselbe Debug-Schnittstelle ausgelesen:

| Künstlicher Eingang | Rückgabe |
| --- | --- |
| Breitengrad `52.512345` | `52.512` |
| Längengrad `13.412345` | `13.412` |
| Geschwindigkeit `10` | `10.000` |
| Fahrertür `true` / `false` | `true` / `false` |

**Wichtige Begrenzung:** Die Debug-Ausgabe rundet diese Koordinaten auf drei
Nachkommastellen. Bei Dezimalgrad ist das ein Raster von etwa 111 m in
Nord-Süd-Richtung; der Rundungsfehler beträgt bis etwa 56 m je Breitengradachse,
zusätzlich zum Fehler der eigentlichen Positionsquelle. Das Plugin bekommt über
diesen Weg daher keine metergenaue GPS-Position. Dies ist eine Grenze des
untersuchten Lesewegs, keine Aussage über die Genauigkeit des GPS-Empfängers.

Das Plugin akzeptiert die tatsächlich beobachteten skalaren Zahlen-/Bool-Formate
bereits. Es werden keine Schreibzugriffe auf Fahrzeugdaten im Plugin ergänzt.
Der synthetische Test ist ausdrücklich nur für eine isolierte QEMU-Instanz gedacht.

## Statische Nachweise

In `libQtCarVAPI.so.1.0.0`:

- `NavServerDataListener::processDataMessage(...)` ab `0x9f9970` übernimmt die
  Navigations-Daten. Im Bereich `0x9f9c6a` / `0x9f9c98` / `0x9f9cf4` werden
  Breitengrad, Längengrad und mph-Geschwindigkeit angesprochen.
- Die ELF-GOT-Relokationen `0xdb86c8`, `0xdb86d0`, `0xdb86e0` weisen diese
  Zugriffe den drei `NAV_`-Namen zu.
- `VehicleStatusManager::latchChanged()` ab `0x7918a0` liest
  `DOOR_frontDriverDoor` und `DOOR_frontDriverRequestSource` und aktualisiert
  den booleschen `VAPI_driverDoor` über die Relokation `0xdb3d98`.
- `VehicleUtils::isDoorOpen(...)` ab `0x747150` verwendet den zusammengesetzten
  Türstatus als Bitmaske; dieser ist kein einfacher einzelner Bool-Wert.

SHA-256 der untersuchten Bibliothek:
`40ab6b4e280dbb17f08557d8952680544c0edf49a20dc7913d504a7113723c49`.
Keine Firmware-Dateien oder vollständigen Disassemblierungen werden ins Repository aufgenommen.

## Reproduktion

```sh
python3 tools/test-target-vm.py --suite telemetry-values \
  --kernel /path/to/vmlinuz-virt --initrd /path/to/initramfs.cpio.gz \
  --firmware /path/to/ZEN3-2026.38.5.12.ssq \
  --log /tmp/home-assistant-telemetry-values.log
```

Der Runner prüft Namensauflösung, die negative Kontrolle und die synthetischen
Rückgabewerte. Die Debug-Busregistrierung wird exakt geprüft: `DebugService`
ist ein anderer Busname und darf das Warten auf `com.tesla.Debug` nicht beenden.
Der aktuelle lokale vollständige Log liegt unter
`/private/tmp/home-assistant-telemetry-values.log`.
