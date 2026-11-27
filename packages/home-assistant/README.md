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
| `sensor.coilshift_car_gear` | Fahrstufe `P`, `R`, `N` oder `D`; automatisch über den SDK-Fahrzeugendpunkt |
| `sensor.coilshift_car_soc` | Akkuladestand in %, Geräteklasse `battery`; Standardquelle `VAPI_batteryLevel` |
| `binary_sensor.coilshift_car_driver_door` | `on` = offen, `off` = geschlossen, Geräteklasse `door` |
| `sensor.coilshift_car_charging_power` | Ladeleistung in kW (ab alpha.18), `0`, wenn das Auto nicht lädt |
| `sensor.coilshift_car_home_charging_energy` | zu Hause geladene Energie in kWh fürs Energie-Dashboard (ab alpha.18) |
| `sensor.coilshift_car_charging_state` | Ladestatus des Autos, roh, z. B. `Complete` (ab alpha.18) |
| `binary_sensor.coilshift_car_charging` | `on`, solange das Auto lädt, Geräteklasse `battery_charging` (ab alpha.18) |

Jede Entität besitzt das Attribut `updated_at` (UTC). Ungültige/fehlende Werte
werden als `unavailable` gesendet; für ungültige Positionen entfallen die Koordinaten.
Der Tracker-Zustand lautet bei gültigem GPS `home`, wenn das Auto in der Heimzone
`zone.home` steht, sonst `not_home` (ab alpha.18, siehe „Laden und
Energie-Dashboard“). Die Koordinaten können auf einer Karte dargestellt werden.

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

Quellcode: `services/home-assistant/`, Go-Standardbibliothek und fest versioniertes `go-qrcode` für den lokalen Einrichtungs-QR-Code.
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

## Graue Felder / Verbindungsdiagnose (ab alpha.5)

Die Seite wartet auf die vom CoilShift-Host gelieferten Einstellungen. Ab alpha.5
wird eine fehlgeschlagene oder verspätete Registrierung automatisch erneut
abgefragt. Oberhalb der Felder steht jetzt, ob die Verbindung besteht, welche
Einstellungen fehlen oder ob CoilShift den Zugriff verweigert bzw. Felder sperrt.
Bereits geladene Eingaben werden durch das Statuspolling nicht überschrieben.
Die genaue Ursache in der betroffenen Installation ist noch nicht bestätigt.

## Fahrstufe (ab alpha.6)

`sensor.coilshift_car_gear` und das Tracker-Attribut `gear` liefern `D` (Drive),
`N` (Neutral), `R` (Reverse) oder `P` (Park). Keine zusätzliche Einstellung nötig:
die Quelle ist `GET /v1/vehicle/gear` des CoilShift-SDK. Unbekannte/fehlende Werte
werden `unavailable`, niemals automatisch `P`. Numerische Firmware-Enums werden
nicht geraten. Der Wert wird im gleichen Zyklus wie die übrigen Daten gesendet.

## Expliziter Panel-Zugriff (alpha.7)

Das Panel listet jetzt alle 13 eigenen Einstellungen mit vollständigen IDs in
`panel.settings`. So hängt die Zuordnung nicht ausschließlich von der impliziten
Freigabe paketinterner Einstellungen ab. Nach dem Update die Panel-Seite schließen
und CoilShift neu laden. Ein Host-Test mit ausschließlich expliziter Freigabe
prüft das Laden und Speichern. Der Live-Abgleich der gemeldeten leeren Liste
steht noch aus.

## Bearbeiten trotz leerer Leseantwort (alpha.8)

Eine leere oder fehlgeschlagene Einstellungsabfrage sperrt nicht mehr alle
Eingaben und die Firmware-Profilübernahme. Die Seite nutzt dann ausdrücklich als
lokale Vorgaben gekennzeichnete Manifest-Defaults. Nicht geladene gespeicherte
Werte werden nicht als bekannt dargestellt; leere Geheimnisfelder bleiben beim
Speichern unverändert. Eigene Eingaben werden bei späteren Ladeversuchen bewahrt.

Speichern erfolgt weiterhin ausschließlich über `settings.set` des CoilShift-
Hosts. Dieser muss die Werte und Berechtigungen prüfen. Eine explizite
Zugriffsverweigerung sperrt das Speichern; explizit gesperrte Felder bleiben
schreibgeschützt. Werden Schreibvorgänge bestätigt, aber das Zurücklesen bleibt
leer, zeigt die Seite genau diese eingeschränkte Bestätigung. Ohne erfolgreiche
Schreibantwort wird kein Erfolg behauptet. Zur Sicherheit wird vor Änderungen
bei unbekanntem Aktivierungszustand zunächst die Übertragung deaktiviert.

## Speichern ohne CoilShift-Einstellungskatalog (alpha.10)

Wenn CoilShift bei `settings.set` mit `not_found` antwortet, funktioniert dieser
Schreibweg in der betroffenen Installation nicht. Ab alpha.10 ist auf der
Handy-Seite **Direkt im Plugin speichern** standardmäßig ausgewählt:

1. Plugin aktualisieren und den frischen QR-Code scannen.
2. URL und Zugangsdaten eintragen. **Direkt im Plugin speichern** und bei Bedarf
   **Übertragung nach dem Speichern aktivieren** angehakt lassen.
3. **Im Plugin speichern** drücken. Erst die Erfolgsmeldung bestätigt die
   lokale Speicherung. Ein weiterer Speicherklick auf der MCU ist nicht nötig.

Die Konfiguration liegt AES-256-GCM-verschlüsselt unter `$CSDK_STATE/connection.enc`.
Der separat erzeugte Schlüssel liegt unter `$CSDK_STATE/connection.key`; beide
Dateien haben Modus 0600. Updates und Dienstneustarts behalten die Konfiguration.
Der Dienst verwendet sie vorrangig vor SDK-Einstellungsdateien und bemerkt
Änderungen automatisch. Sie wird nicht in CoilShift-Cloud-Snapshots synchronisiert.
Root-Zugriff auf beide Dateien ermöglicht weiterhin die Entschlüsselung.

Auf der MCU erscheint **Direkt im Plugin gespeichert und vom Dienst verwendet**.
Die Werte sind dort zur Kontrolle sichtbar, Geheimnisse nur als „gesetzt“.
Bearbeiten erfolgt in diesem Modus über die Handy-Seite; die MCU-Speicherfunktion
ist zur Vermeidung widersprüchlicher SDK-/Plugin-Konfiguration deaktiviert.
Für weitere Änderungen den Plugin-Dienst für einen neuen QR-Code neu starten.

Ist **Direkt im Plugin speichern** nicht angehakt, bleibt der bisherige reine
Entwurfsweg aktiv; dieser behebt keinen `not_found`-Fehler beim SDK-Speichern.
Die Handy-Verbindung benötigt weiterhin lokale Netzwerk-Erreichbarkeit.

## Handy-Eingabe im gleichen WLAN (alpha.9)

1. Auto und Handy mit demselben WLAN verbinden, dann den Plugin-Dienst starten
   bzw. nach dem Update die Einstellungsseite öffnen.
2. Unter **Am Handy einrichten** den QR-Code scannen. Er zeigt auf eine private
   IPv4-Adresse der MCU. Falls mehrere Adressen angezeigt werden, die passende
   WLAN-Adresse auswählen. Es wird keine Firewall-Regel geändert.
3. Der lokale HTTPS-Server verwendet ein nur für diesen Start erzeugtes
   Zertifikat. Dieses muss im Handy-Browser einmal bestätigt werden; die Adresse
   muss der auf der MCU angezeigten lokalen Adresse entsprechen.
4. URL und Benutzername/Passwort oder API-Token am Handy eingeben. Mit
   **Auf MCU übernehmen** werden die Werte als Entwurf an die MCU übertragen.
5. Auf der MCU die Werte prüfen, **Home Assistant aktivieren** wählen und
   **Einstellungen speichern** drücken. Die Handy-Übertragung ist noch keine
   Bestätigung, dass CoilShift die Werte dauerhaft gespeichert hat.

Die DataValue-Namen und `mph` sind für die untersuchte Firmware vorbelegt.
Übertragung und Fahrzeugdaten liegen unter **Erweitert**. Individuell gespeicherte
Werte werden nicht automatisch durch die neuen Defaults überschrieben; für
früher leere Felder steht der Profilknopf außerhalb des aufgeklappten Bereichs bereit.

Der QR-Link gilt fünf Minuten nach Dienststart und nur für eine Übertragung.
Der Listener schließt nach erfolgreicher Übertragung, Ablauf oder Dienstende.
Für einen neuen QR-Code den Plugin-Dienst neu starten. Die temporären Eingaben
liegen höchstens bis zum Ablauf des Einrichtungsfensters als Datei mit Modus
0600 im bootflüchtigen SDK-Verzeichnis; sie werden beim Ablauf/Dienstende entfernt.
Im Entwurfsmodus werden keine Zugangsdaten durch den Einrichtungsserver in
persistenten Speicher oder Logs geschrieben. Der direkte Speichermodus ab
alpha.10 verwendet dagegen den oben beschriebenen verschlüsselten Plugin-Speicher.

Die Authentisierung verwendet einen zufälligen 192-Bit-Code im QR-Fragment;
Schreibanfragen verlangen diesen Code und dieselbe HTTPS-Origin. Öffentliche
Remote-IP-Adressen werden abgewiesen, Browser-CORS wird nicht freigegeben.
Zugriffe über private Netzwerke/Loopback sind während des Fensters möglich.
Die tatsächliche WLAN-Erreichbarkeit hängt von Routing und Firewall der MCU ab
und ist hier nicht am Auto geprüft; das gleiche WLAN allein garantiert sie nicht.

## UI-Version prüfen (alpha.11)

Oberhalb der Seite steht jetzt **Oberfläche 0.1.0-alpha.11**; im Untertitel
steht dieselbe UI-Version. Jede Version nutzt eine eigene HTML-Einstiegsadresse
und inhaltsadressierte App-/CSS-/Schema-Dateien, damit ein Cache keine alte
Oberfläche unter denselben Asset-URLs wiederverwenden kann.

**Am Handy einrichten** wird immer angezeigt, selbst ohne laufenden Dienst.
Fehlt bereits diese Überschrift, ist eine ältere/andere Oberfläche geöffnet;
das ist kein Beleg für einen fehlenden QR-Backenddienst. Nach dem Update
CoilShift vollständig schließen und neu öffnen. Fehlt die Versionsanzeige
weiterhin, ist die neue Oberfläche am Gerät noch nicht aktiv.

## Tailscale-/CGNAT-Zugriff (alpha.12)

Der Einrichtungsserver akzeptiert zusätzlich zu privaten LAN-/Loopback-Adressen
jetzt das geteilte IPv4-Netz `100.64.0.0/10`, aus dem Tailscale seine IPv4-Adressen
vergibt. Go klassifiziert diesen Bereich nicht als `IP.IsPrivate()`, weshalb der
bisherige Filter entsprechende Clients schon beim Seitenaufruf mit 403 ablehnte.
Die Adressermittlung für QR-Codes berücksichtigt den Bereich ebenfalls.

Der Zugriff benötigt weiterhin HTTPS, den Einmalcode, eine passende Origin und
ein gültiges Zeitfenster. Öffentliche Client-IP-Adressen bleiben abgewiesen.
Nach dem Update einen frisch erzeugten QR-Code verwenden; er enthält die aktuelle
Portnummer und den neuen Zugriffscode. Nur der Host-/Port-Text reicht nicht zum
Speichern, weil der QR-Link auch das geheime Fragment enthält.

Referenz: https://tailscale.com/docs/concepts/tailscale-ip-addresses

## GPS-Diagnose (alpha.13)

Bei fehlender Position enthält `device_tracker.coilshift_car` jetzt die Attribute
`gps_latitude_status`, `gps_longitude_status`, `gps_latitude_datavalue` und
`gps_longitude_datavalue` (bei geändertem Präfix entsprechend anderer Entitätsname).
Diese Angaben bleiben auch beim Zustand `unavailable` sichtbar.

| Status | Bedeutung |
| --- | --- |
| `ok` | Endlicher Zahlenwert innerhalb des Dezimalgrad-Bereichs |
| `no_value` | Leere Rückgabe, `null` oder Firmware-Rückgabe `<invalid>` |
| `sdk_http_404` | SDK findet den DataValue nicht |
| `sdk_http_401` / `sdk_http_403` | SDK verweigert den Lesezugriff |
| `sdk_read_failed` | SDK-Verbindung/Lesen fehlgeschlagen |
| `invalid_datavalue_name` | Konfigurierter Name fehlt oder ist ungültig |
| `not_a_finite_number` | Rückgabe ist keine endliche skalare Zahl |
| `out_of_range` | Zahl liegt außerhalb ±90° bzw. ±180° |

Weitere HTTP-Fehler erscheinen als `sdk_http_<Statuscode>`. Rohwerte und
Fehlerantworten werden nicht in Diagnoseattribute übernommen. Es wird keine
Koordinatenskalierung geraten. Diese Version verbessert die Eingrenzung;
sie bestätigt noch keine funktionierende Live-GPS-Quelle. Für die Eingrenzung
genügen zunächst die vier Diagnoseattribute, ohne Standortdaten weiterzugeben.

## GPS auf Produktionsfahrzeugen (alpha.14)

Am Zielauto wurde bestätigt: `NAV_vehicleLatitude` und `NAV_vehicleLongitude`
liefern über `com.tesla.Debug.get_data_value` den Text `<redacted>`. Die Werte
sind damit vorhanden, aber auf diesem Leseweg verborgen. Die separate
Nur-Lese-Methode `com.tesla.SensitiveDataValues.get_LOC_geoLocation` auf
`/SensitiveDataValues` liefert eine Position als `(Breitengrad N/S, Längengrad E/W)`.

Ab alpha.14 nutzt die Bridge bei `<redacted>` und den beiden unveränderten
Standard-DataValue-Namen diese Standortabfrage über `/usr/bin/dbus-send`.
Die Abfrage hat ein Zeitlimit; Zahlenbereiche und Himmelsrichtungen werden
geprüft. Sie verändert weder Fahrzeugwerte noch Datenschutzeinstellungen.
Benutzerdefinierte GPS-DataValues werden nicht durch einen anderen Leseweg ersetzt.

Das Attribut `gps_source` zeigt `datavalues` oder `sensitive_geolocation`.
`redacted` kennzeichnet geschwärzte DataValues; `location_read_failed` und
`location_invalid_response` grenzen Fehler der separaten Standortabfrage ein.
Bei Fehlern werden keine alten oder geratenen Koordinaten übertragen.
Die erfolgreiche Standortabfrage wurde am Auto bestätigt; der vollständige
Bridge-zu-Home-Assistant-Datenfluss dieser Version erfordert noch das Update.

## Fahrertür und Geschwindigkeit (alpha.15)

Am 17.11.2026 kam das Öffnen der Fahrertür beim Einsteigen nicht in Home
Assistant an. Zwischen 07:39 und 07:41 meldete die Bridge 14-mal „zu“; das
Einsteigen fiel zwischen zwei Lesungen im 10-s-Takt. Nach einer Schlafphase kam
die erste Meldung erst, als bereits D eingelegt war.

Ab alpha.15 liest die Bridge die Tür zwischen den Durchläufen jede Sekunde. Ein
Öffnen startet sofort einen Durchlauf; darin wird die Tür als Erstes gesendet und
einmal als `on` gemeldet, auch wenn sie inzwischen wieder geschlossen ist. Der
nächste Durchlauf sendet wieder den tatsächlichen Zustand. Solange ein Öffnen
nicht übertragen ist, versucht die Bridge es alle 2 s statt mit dem
exponentiellen Backoff, höchstens 90 s lang; danach verfällt es. Der erste
gültige Türwert nach einem Start gilt nur als Ausgangslage, ein Neustart erzeugt
also kein Öffnen.

`NAV_vehicleSpeedMph` lieferte am Zielauto auch während der Fahrt 0. Ist der
Geschwindigkeits-DataValue 0 oder ungültig, leitet die Bridge km/h aus zwei
aufeinanderfolgenden Positionen der Standortabfrage (`sensitive_geolocation`)
ab: Durchschnitt über das Intervall, auf ganze km/h gerundet, unter 2 km/h als
0, in P immer 0. Aus gerundeten DataValue-Koordinaten (Raster etwa 111 m) wird
keine Geschwindigkeit abgeleitet. Das Attribut `speed_source` zeigt `datavalue`,
`gps` oder `none`.

Die Go-Tests decken Latch, Ausgangslage, Verfall, schnellen Retry und die
Geschwindigkeitsableitung ab; am Auto ist diese Version noch nicht geprüft.

## Erweiterte Werte am Handy, Tailscale zuerst (alpha.16)

Ist die Konfiguration direkt im Plugin gespeichert (siehe alpha.10), sperrt das
MCU-Panel alle Felder, weil CoilShift dort nicht speichern kann
(`settings.set: not_found`). Die Handy-Seite bot bisher nur URL und Zugangsdaten
an. Intervall, Entitätsname, DataValues und Einheit ließen sich damit gar nicht
mehr ändern.

Ab alpha.16 hat die Handy-Seite einen Bereich **Erweitert** mit diesen Werten.
Sie sind mit den gespeicherten Werten vorbelegt (`GET /config`, nur mit gültigem
Einmalcode; Geheimnisse nur als „gesetzt“). Leere Felder bleiben unverändert.
Ungültige Werte lehnt der Server mit 400 ab, bevor etwas gespeichert wird. Ein
geändertes Intervall gilt ab dem nächsten Durchlauf. Das MCU-Panel weist im
Bereich „Erweitert“ auf diesen Weg hin.

Im QR-Code steht eine Tailscale-Adresse jetzt an erster Stelle; die übrigen
Adressen bleiben über die Adress-Schaltflächen erreichbar. Tailscale wird am
Interface-Namen `tailscale*` erkannt, weil auch Mobilfunknetze `100.64.0.0/10`
für Carrier-Grade-NAT verwenden.

## Laden und Energie-Dashboard (alpha.18)

Vier neue Entitäten zeigen das Laden. **`sensor.coilshift_car_home_charging_energy`**
zählt die Energie, die das Auto zu Hause aus dem Netz nimmt. Der Sensor erfüllt,
was das Energie-Dashboard verlangt: kWh, `device_class: energy`,
`state_class: total_increasing`. Er gehört dort unter **Einzelne Geräte**. Als
Leistung (optional) passt `sensor.coilshift_car_charging_power`; der zeigt aber
auch unterwegs die Ladeleistung.

- **Quelle:** der Lebenszähler des Autos für AC-Ladeenergie,
  `VAPI_acChargerKwhTotal`. Gezählt wird, wie weit er wächst, in 0,001-kWh-Schritten.
  Er läuft laufend mit, also auch dann, wenn das Auto mit vollem Akku an der
  Wallbox hängt und Strom für 12 V oder die Klimatisierung nimmt (am Auto
  gemessen: etwa 40 W). Auch das kommt aus deinem Netz und wird gezählt.
  Nach der letzten Ladung des Autos (20,876 kWh AC, 19,58 kWh im Akku) misst der
  Zähler auf der Netzseite. Bestätigen lässt sich das mit einem Zähler an der
  Wallbox.
- **Nur zu Hause:** Die Bridge holt sich die Heimzone `zone.home` aus Home
  Assistant (Mittelpunkt und Radius, mindestens 100 m, dazu 50 m
  GPS-Toleranz) und vergleicht sie mit der Position des Autos. Unterwegs
  geladene Energie zählt nicht. Fehlt die Heimzone oder die Position, zählt
  nichts; was in dieser Zeit hereinkommt, wird verbucht, sobald der Ort wieder
  bekannt ist. Ohne lesbare `zone.home` meldet der Dienst „degraded“.
- **Neustarts und Updates:** Der Zählerstand liegt in `$CSDK_STATE/energy.json`.
  Startet der Dienst mitten in einer Ladung zu Hause neu (gleiche Ladesitzung
  `VAPI_chargingID`), wird die Lücke nachgezählt; bei einer anderen Sitzung
  nicht, sie könnte woanders gewesen sein. Geht der Stand verloren, etwa durch
  Deinstallieren, beginnt der Sensor bei 0. Home Assistant wertet das bei
  `total_increasing` als Zählerwechsel; es geht nichts verloren und nichts wird
  doppelt gezählt.
- **Ladeleistung:** `VAPI_chargerPower` in kW, nur während das Auto lädt
  (`VAPI_isCharging`), bei Gleichstrom `GUI_fastChargePower`. Steht das Auto
  voll an der Wallbox, meldet es eine Ladeleistung um 1,7 kW, die nicht fließt;
  deshalb steht der Sensor dann auf 0, der gemeldete Wert ist als Attribut
  `reported_power_kw` zu sehen. Weitere Attribute: `at_home`, `charge_state`,
  `charger_type`, `voltage_v`, `current_a`, `phases_raw` (ein Code des Autos,
  keine Anzahl: `2` war eine dreiphasige 11-kW-Ladung) und `session_energy_kwh`.
- Die Ladewerte gehen bei jeder Änderung an Home Assistant, sonst einmal pro
  Minute.
- **Tracker:** `device_tracker.coilshift_car` steht in der Heimzone auf `home`,
  sonst auf `not_home`. Die Position bleibt wie bisher als Attribut.

Steht im Energie-Dashboard schon ein Zähler für die Wallbox, würde ein
zusätzliches Gerät mit diesem Sensor dieselbe Energie doppelt zählen. Dann
entweder den alten Zähler ersetzen oder diesen Sensor nur zur Kontrolle nutzen.
