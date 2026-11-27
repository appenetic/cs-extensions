# Sammel-Repo

Ein CoilShift-Repository, das die Pakete mehrerer Repositories bündelt. Im Auto
steht nur noch eine Adresse, neue Quellen kommen über die Admin-Seite dazu.

| | |
|---|---|
| Adresse fürs Auto | `https://cs.appenetic.de/index.json` |
| Öffentliche Seite (Pakete, zuletzt geändert) | `https://cs.appenetic.de` |
| Admin (Quellen, Statistik) | `https://cs.appenetic.de/admin` |

## Was der Dienst tut

- Er ruft alle Quellen alle 5 Minuten ab. Mit einem Cache-Brecher in der URL
  kommt der frische Index, auch wenn GitHub Pages noch eine bis zu 10 Minuten
  alte Kopie ausliefert.
- Er spiegelt jedes Archiv in seinen eigenen Pool (`pool/<sha256>`). Ein Archiv
  kommt erst hinein, wenn Größe und SHA-256 zum Eintrag passen. Die Einträge
  gehen Byte für Byte durch. Damit bleiben `manifest_sha256` und der
  Eintrags-Hash, den das Auto als `entry_sha256` zeigt, dieselben wie in der
  Quelle.
- Ein Eintrag, der eine bekannte Regel bricht, wird nicht übernommen: falscher
  Manifest-Hash, Zusammenfassung über 279 Bytes, ein Archiv, das sich nicht
  laden lässt oder nicht passt. Dann bleibt die vorige Version im Feed, und die
  Admin-Seite zeigt den Grund. CoilShift lehnt sonst den ganzen Feed ab
  (`bad_index`), mit allen Paketen aller Quellen.
- Aus dem Feed verschwindet nie ein Paket. Nimmt eine Quelle ein Paket heraus
  oder wird eine Quelle entfernt, bleibt es mit `"withdrawn": true` stehen,
  samt Archiv. Ist eine Quelle nicht erreichbar, bleiben ihre zuletzt geladenen
  Pakete unverändert.
- Steht dieselbe Paket-ID in mehreren Quellen, gilt die Quelle weiter oben. Die
  Reihenfolge lässt sich im Admin ändern.
- `/` liefert Browsern die öffentliche Seite und allen anderen den Index.

## Statistik

Unter Admin → Statistik:
- wie viele Absender den Index pro Tag abrufen (ein Absender ist ungefähr ein Auto)
- woher sie kommen (Land, Ort)
- mit welcher Software sie abrufen
- wie oft jedes Paket heruntergeladen wird
- wie oft die öffentliche Seite aufgerufen wird

Gespeichert werden nur Tageszähler. Die IP-Adresse wird beim ersten Abruf des
Tages im Speicher einem Ort zugeordnet und mit einem Tagesschlüssel gehasht,
der um Mitternacht verfällt. Die Orte kommen aus „IP to City Lite“ von DB-IP
(CC BY 4.0). Der Dienst lädt die Datenbank jeden Monat neu.

## Betrieb

- Server `root@159.69.252.1`, Dienst `cs-sammelrepo.service` (systemd,
  `DynamicUser`, lauscht nur auf `127.0.0.1:7356`).
  Protokoll: `journalctl -u cs-sammelrepo`.
- Binary und Benutzerdatei liegen in `/srv/sammelrepo/`, Zustand, Pool,
  Statistik und Geo-Datenbank in `/var/lib/cs-sammelrepo/`.
  `indexe/` hält die letzten 30 veröffentlichten Indexe. Meldet das Auto
  `bad_index`, zeigt ein Diff gegen den letzten angenommenen Index, was sich
  geändert hat.
- TLS und Weiterleitung macht der Caddy im Container `dachterrasse`. Der Block
  steht in `/srv/dachterrasse/Caddyfile` (Vorlage: `deploy/Caddyfile.block`),
  das Zertifikat kommt per TLS-ALPN. Nach einer Änderung am Caddyfile:
  `docker restart dachterrasse`. Das kostet alle Seiten dort ein paar Sekunden.
- DNS: A- und AAAA-Record `cs.appenetic.de` bei INWX.

### Update einspielen

```
GO=/pfad/zu/go services/sammelrepo/deploy.sh
```

Das Skript führt vet und die Tests aus, baut für linux/amd64, kopiert Binary
und Unit und startet den Dienst neu.

### Passwort ändern oder Benutzer anlegen

```
ssh -t root@159.69.252.1 '/srv/sammelrepo/cs-sammelrepo passwort sascha && systemctl restart cs-sammelrepo'
```

Nach einer Passwortänderung gelten alte Anmeldungen nicht mehr.

### Ersteinrichtung auf einem neuen Server

1. `install -d -m 0755 /srv/sammelrepo` und das Binary dorthin kopieren.
2. `/srv/sammelrepo/cs-sammelrepo passwort sascha` legt `/srv/sammelrepo/benutzer` an.
3. `deploy.sh` ausführen. Es installiert die Unit, aktiviert den Dienst und startet ihn.
4. `deploy/Caddyfile.block` an das Caddyfile hängen, mit einem
   `caddy:2`-Wegwerfcontainer prüfen (`caddy validate`) und Caddy neu starten.

## Entwicklung

```
go test ./...
SAMMELREPO_GEO_DB=/pfad/dbip-city-lite.mmdb go test -run Geo -v ./...
```

Nur Standardbibliothek, Go 1.25 oder neuer. Die Tests spielen Quellen mit
`httptest` nach. Sie prüfen das byte-genaue Durchreichen (auch mit `<`, `&`,
U+2028 und Escape-Folgen), das Zurückziehen, Fehler einer Quelle, kaputte
Einträge, die Reihenfolge, das Aufräumen des Pools, die Sperre gegen eigene
und private Netze, Login, CSRF und die Seiten.
