# Home Assistant Bridge für CoilShift

Experimentelles SDK-1.0-Paket. Liest ausschließlich Fahrzeugdaten und sendet sie
über HTTPS an deine Home-Assistant-Instanz, etwa die Nabu-Casa-Remote-URL.
Keine Fahrzeugsteuerung. Standardmäßig deaktifünft.

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
   GPS-Genauigkeitsgrenze. Die **fünf am Fahrzeug zu bestätigenden DataValue-Namen** für Breitengrad,
   Längengrad, Geschwindigkeit, Akkuladestand und Fahrertür eintragen. Sie bleiben absichtlich
   leer, da die Namen und ihre Semantik hier nicht am Auto verifiziert wurden.
   Der SDK-Endpunkt `/v1/dv/<Name>` muss einen skalaren Wert liefern: GPS in
   Dezimalgrad, Geschwindigkeit in der gewählten Einheit, Tür als boolesches
   `true` (offen) bzw. `false` (geschlossen). Ein Alarm-/Warnsignal ist nicht
   automatisch der physische Türzustand. Keine unbestätigten Feldnamen übernehmen.
6. Geschwindigkeits-Einheit des Quellwertes auswählen, optional Entitätspräfix und
   Intervall ändern, anschließend aktifünfen. Das Intervall beträgt standardmäßig 10 s.

Passwort und API-Token sind SDK-`secret`-Einstellungen. Zugangsdaten und Tokens
werden nicht protokolliert oder vom Plugin persistent gespeichert. Beim Passwort-Login
bleiben Access- und Refresh-Token im Prozessspeicher. TLS-Zertifikate werden geprüft;
HTTP, Zugangsdaten in URLs und Weiterleitungen werden abgelehnt.

## Entitäten

Mit dem Standardpräfix `coilshift_car` werden über die Home-Assistant-States-API angelegt:

| Entität | Inhalt |
| --- | --- |
| `device_tracker.coilshift_car` | `latitude`, `longitude`, `source_type: gps`; zusätzlich Geschwindigkeit, `battery_level` und Türzustand als Attribute |
| `sensor.coilshift_car_speed` | Geschwindigkeit in km/h, Geräteklasse `speed` |
| `sensor.coilshift_car_soc` | Akkuladestand in %, Geräteklasse `battery`; Standardquelle `VAPI_batteryLevel` |
| `binary_sensor.coilshift_car_driver_door` | `on` = offen, `off` = geschlossen, Geräteklasse `door` |

Jede Entität besitzt das Attribut `updated_at` (UTC). Ungültige/fehlende Werte
werden als `unavailable` gesendet; für ungültige Positionen entfallen die Koordinaten.
Der Tracker-Zustand lautet bei gültigem GPS `not_home`; eine Home-Zonenberechnung
ist hier nicht implementiert. Die Koordinaten können auf einer Karte dargestellt werden.

Die States-API erzeugt Zustände, keine registrierte HA-Integration bzw. keinen
Geräteregister-Eintrag mit `unique_id`. Nach einem Home-Assistant-Neustart legt der
nächste erfolgreiche Sendezyklus die Zustände wieder an. Beim Deinstallieren oder
Deaktifünfen werden vorhandene HA-Zustände nicht gelöscht. Änderungen am Präfix
lassen frühere Entitäten ebenfalls bestehen.

Wenn die MCU schläft, das Auto offline ist oder der Dienst deaktifünft wird,
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

## Version 0.1.0-alpha.3

SoC wird zusätzlich als `sensor.coilshift_car_soc` und als `battery_level`-Attribut
am Tracker übertragen. Ungültige Werte außerhalb 0–100 % werden `unavailable`.
Die Quelle `soc_dv` ist konfigurierbar und mit `VAPI_batteryLevel` vorbelegt.

Der Installationsfehler bei `speed_unit` ist behoben: SDK-Enum-Werte dürfen keinen
Schrägstrich enthalten. Die internen Werte sind jetzt `kph`, `mps`, `mph`, während
die sichtbaren Beschriftungen weiterhin `km/h`, `m/s`, `mph` lauten. Der Dienst
akzeptiert die alten internen Werte zusätzlich für bestehende Konfigurationen.

## Eigene Einstellungsseite (ab 0.1.0-alpha.4)

Das Paket registriert ein SDK-Panel **Home Assistant · Einstellungen**, das
CoilShift neben seinen eigenen Seiten anzeigt. Nach dem Update auf alpha.4
CoilShift neu laden, damit das Panel registriert wird. Der genaue Navigationsort
hängt von der CoilShift-App-Version ab.

Die Seite enthält Verbindung, verschlüsselte Zugangsdaten, Intervall,
Fahrzeug-DataValues und den aktuellen Dienststatus. **Firmware-Profil übernehmen**
trägt die offline geprüften Namen ein, ohne sie sofort zu speichern. Anschließend
**Einstellungen speichern** wählen. Das Profil ist noch nicht am Auto bestätigt.

Leere Passwort-/Tokenfelder behalten den gespeicherten Wert bei. **Löschen**
merkt die Löschung bis zum Speichern vor. Während einer Änderung wird ein
bereits aktiver Dienst zuerst deaktiviert und erst nach vollständigem Speichern
wieder aktiviert. Bei einem Teilfehler die angezeigten Einstellungen prüfen.

Die Seite verwendet ausschließlich die SDK-Nachrichtenbrücke und keine eigenen
HA-Netzwerkanfragen. Die JavaScript-Dateien der Oberfläche sind wie bei anderen
Web-Panels auslesbar; die Fahrzeug-/HA-Dienstlogik bleibt in der Binärdatei.
