# Home Assistant Bridge für CoilShift

Experimentelles SDK-1.0-Paket. Liest ausschließlich Fahrzeugdaten und sendet sie
über HTTPS an deine Home-Assistant-Instanz, etwa die Nabu-Casa-Remote-URL.
Keine Fahrzeugsteuerung. Standardmäßig deaktiviert.

## Voraussetzungen und Einrichtung

1. Unterstützt **x86_64-MCUs** (die bereitgestellte Intel-/ZEN3-Firmware).
   Der statisch gelinkte Linux-Dienst ist enthalten; Python oder zusätzliche
   Laufzeitpakete auf dem Auto sind nicht nötig. Das Startskript kopiert ihn vom
   `noexec`-Paketbereich in das ausführbare SDK-Verzeichnis `$CSDK_RUN`.
   Andere CPU-Architekturen meldet diese Version als `unsupported`.
2. Im CoilShift-Paketmanager das Repository hinzufügen und **Home Assistant Bridge
   (experimental)** installieren.
3. In den Paketeinstellungen die HTTPS-Basis-URL eintragen,
   z. B. `https://deine-instanz.ui.nabu.casa`, ohne `/api`.
4. Home-Assistant-Benutzernamen und Passwort eintragen. Unterstützt den integrierten
   `homeassistant`-Login ohne MFA. Alternativ im Home-Assistant-Profil unter
   **Sicherheit → Langlebige Zugriffstoken** einen Token erstellen und im optionalen
   Tokenfeld hinterlegen. Ein gesetzter Token hat Vorrang; bei MFA ist er nötig.
   Nabu-Casa-Kontozugangsdaten sind keine Home-Assistant-Benutzerdaten.
5. Ein [offline ermitteltes Firmware-Profil](../../docs/home-assistant-datavalues.md)
   enthält konkrete Namen für die gelieferte Firmware sowie eine wichtige
   GPS-Genauigkeitsgrenze. Die **vier am Fahrzeug zu bestätigenden DataValue-Namen** für Breitengrad,
   Längengrad, Geschwindigkeit und Fahrertür eintragen. Sie bleiben absichtlich
   leer, da die Namen und ihre Semantik hier nicht am Auto verifiziert wurden.
   Der SDK-Endpunkt `/v1/dv/<Name>` muss einen skalaren Wert liefern: GPS in
   Dezimalgrad, Geschwindigkeit in der gewählten Einheit, Tür als boolesches
   `true` (offen) bzw. `false` (geschlossen). Ein Alarm-/Warnsignal ist nicht
   automatisch der physische Türzustand. Keine unbestätigten Feldnamen übernehmen.
6. Geschwindigkeits-Einheit des Quellwertes auswählen, optional Entitätspräfix und
   Intervall ändern, anschließend aktivieren. Das Intervall beträgt standardmäßig 10 s.

Passwort und API-Token sind SDK-`secret`-Einstellungen. Zugangsdaten und Tokens
werden nicht protokolliert oder vom Plugin persistent gespeichert. Beim Passwort-Login
bleiben Access- und Refresh-Token im Prozessspeicher. TLS-Zertifikate werden geprüft;
HTTP, Zugangsdaten in URLs und Weiterleitungen werden abgelehnt.

## Entitäten

Mit dem Standardpräfix `coilshift_car` werden über die Home-Assistant-States-API angelegt:

| Entität | Inhalt |
| --- | --- |
| `device_tracker.coilshift_car` | `latitude`, `longitude`, `source_type: gps`; zusätzlich Geschwindigkeit und Türzustand als Attribute |
| `sensor.coilshift_car_speed` | Geschwindigkeit in km/h, Geräteklasse `speed` |
| `binary_sensor.coilshift_car_driver_door` | `on` = offen, `off` = geschlossen, Geräteklasse `door` |

Jede Entität besitzt das Attribut `updated_at` (UTC). Ungültige/fehlende Werte
werden als `unavailable` gesendet; für ungültige Positionen entfallen die Koordinaten.
Der Tracker-Zustand lautet bei gültigem GPS `not_home`; eine Home-Zonenberechnung
ist hier nicht implementiert. Die Koordinaten können auf einer Karte dargestellt werden.

Die States-API erzeugt Zustände, keine registrierte HA-Integration bzw. keinen
Geräteregister-Eintrag mit `unique_id`. Nach einem Home-Assistant-Neustart legt der
nächste erfolgreiche Sendezyklus die Zustände wieder an. Beim Deinstallieren oder
Deaktivieren werden vorhandene HA-Zustände nicht gelöscht. Änderungen am Präfix
lassen frühere Entitäten ebenfalls bestehen.

Wenn die MCU schläft, das Auto offline ist oder der Dienst deaktiviert wird,
erhält Home Assistant keine Aktualisierungen und behält den letzten Zustand.
Automationen müssen deshalb auch das Alter von `updated_at` berücksichtigen.
Ein fehlender SDK-Wert wird erkannt; ein vom SDK unverändert zurückgegebener alter
Messwert lässt sich ohne Quellzeitstempel nicht als veraltet erkennen.

## Entwicklung und Validierungsstand

Quellcode: `services/home-assistant/`, ausschließlich Go-Standardbibliothek.
Binärdatei: `bin/bridge-linux-amd64`, statisch, Baseline AMD64 v1. Reproduzierbarer
Build mit Go 1.27.4 (verwendete Toolchain):

```sh
GO=go tools/build-home-assistant.sh
go -C services/home-assistant test -race ./...
python3 -m unittest discover -s tests -v
python3 tools/build.py
```

QEMU-Tests bauen und starten:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C services/home-assistant test \
  -c -trimpath -o /tmp/ha-tests-linux-amd64
python3 tools/test-target-vm.py --suite home-assistant \
  --ha-test-binary /tmp/ha-tests-linux-amd64 \
  --kernel /path/to/vmlinuz-virt --initrd /path/to/initramfs.cpio.gz \
  --firmware /path/to/ZEN3-2026.38.5.12.ssq
```

Der QEMU-Test verwendet das Firmware-Userland, die echte Paket-Binärdatei und
das unveränderte Startskript. Der Paketbereich ist `noexec`, SDK und Home Assistant
sind lokale Unix-/HTTPS-Testserver. TLS-Zertifikatsprüfung bleibt eingeschaltet.
Der Gast erhält keinen Netzwerkadapter, Firmware wird nur gelesen; alle
Teständerungen erfolgen im RAM. Siehe [Validierungsbericht](../../docs/home-assistant-validation.md).

Nicht erfolgt: offizielle `csdk lint/test/build`-Validierung, Anmeldung an einer
echten Home-Assistant-Instanz, Prüfung der Internet-Erreichbarkeit auf der MCU
und Zuordnung der realen Fahrzeug-DataValues. Die QEMU-Prüfung ersetzt keine
Messung von Position, Geschwindigkeit oder physischem Türzustand am Fahrzeug.

Referenzen:
- https://contributors.home-assistant.io/core/internals/rest-api/
- https://contributors.home-assistant.io/core/internals/auth-api/
