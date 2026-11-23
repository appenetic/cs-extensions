# Privater Quellcode, öffentlicher Paketfeed

Das Vorbild [michije.github.io](https://github.com/michije/michije.github.io)
veröffentlicht laut seiner README ausschließlich generierte Artefakte aus einem
privaten Quellrepository. Dies ist eine Trennung der Repositories, keine
Verschlüsselung des ausführbaren Programms.

## Umsetzung hier

- `services/home-assistant/` enthält den Go-Quellcode und seine Tests. Dieser
  bisher ungetrackte Ordner wird im aktuellen Checkout durch `.gitignore` vom
  normalen `git add` ausgeschlossen. Er bleibt lokal vollständig erhalten.
- Für dauerhafte private Versionsverwaltung muss dieser Ordner in einem
  **separaten privaten Git-Repository** versioniert werden. Es wurde kein
  privates Remote angelegt und keine Repository-Sichtbarkeit geändert.
- Das öffentliche Paket enthält ausschließlich die kompilierte Linux-Datei,
  Manifest, drei kleine Lifecycle-Skripte, das SDK-Einstellungspanel und Lizenzhinweise. Entwickler-README,
  Go-Dateien, Tests und Analysedokumente werden nicht eingepackt.
- `tools/export-public-feed.py` erzeugt einen neuen, getrennten Ordner, der als
  Inhalt eines öffentlichen Artefakt-Repositories verwendet werden kann.
  Er übernimmt keine Git-Historie oder Dateien aus dem Entwicklungsbaum.
- Der Export prüft Archiv-/Manifest-Hashes, Dateipfade, erlaubte Inhalte und die
  ELF-Datei vor dem Schreiben. Vorhandene Zielordner werden abgelehnt, damit
  übrig gebliebene Quelltexte nicht unbemerkt veröffentlicht werden.

Der bisherige Remote `appenetic/cs-extensions` ist öffentlich. Bereits darin
veröffentlichter Welcome-Light-Code und dessen Git-Historie bleiben öffentlich.
Eine neue Veröffentlichungsstruktur kann früher veröffentlichte Dateien nicht
nachträglich geheim machen. Der neue Export enthält nur Home Assistant; das
shellbasierte Welcome-Light-Paket wird absichtlich nicht aufgenommen.

## Claude Code (ab 2026-11-17)

`services/claude/` folgt demselben Muster: privat und von `.gitignore`
ausgeschlossen. Veröffentlicht werden nur das Linux-Binary, das Panel, die
UIML-Karte und die Lifecycle-Skripte. Der Export verlangt jetzt genau ein HA-
und genau ein Claude-Release. Ein Push von `repository/` veröffentlicht also
beide Pakete im Pages-Feed. Das Mac-Plugin in `claude-code/` ist Node-Quelltext
und ist absichtlich öffentlich, weil es von dort installiert wird. Eine Sicherung
des Go-Quelltexts liegt unter `../CS_Plugins-backup/claude-src-alpha.1-2026-11-17.tgz`.

## Welcome-Animation (ab 2026-11-23)

`com.appenetic.welcome-performance` und `com.appenetic.welcome-launch` bestehen
nur aus Shell-Skripten: zwei Hooks und `lib/intro.sh`. Es gibt keinen privaten
Quelltext. Der Export nimmt beide mit einer festen Dateiliste auf, ohne README
und ohne ELF-Prüfung. Er verlangt jetzt genau ein Release je zugelassenem
Paket: HA, Claude und die beiden Welcome-Pakete. Die erste Fassung
`com.appenetic.welcome-animation` ist nicht mehr im Feed.

## Build und Export

Auf dem Entwicklungsrechner mit lokalem/private ausgechecktem Quellcode:

```sh
GO=go tools/build-home-assistant.sh
python3 tools/export-public-feed.py --output dist/public-feed
```

Nach einem früheren Export für einen weiteren Build einen neuen Zielordner
angeben, z. B. `dist/public-feed-alpha-3`. Der Export überschreibt nichts.

Ergebnis, entsprechend dem Vorbild:

```
public-feed/
├── .nojekyll
├── README.md
└── cs-extensions/
    ├── .nojekyll
    ├── index.json
    ├── index.html
    └── pool/<sha256>
```

`index.html` enthält wie beim Vorbild dieselben Indexdaten wie `index.json`.
Der Feed benötigt keine im Browser ausgeführte Anwendungslogik.

Zum Veröffentlichen ausschließlich den **Inhalt dieses Exportordners** in ein
frisches öffentliches Repository übernehmen, ohne die Historie des
Entwicklungsrepositories. Bei einer GitHub-Pages-User-Site wäre die Feed-URL
`https://<account>.github.io/cs-extensions/index.json`; bei einer Project-Site
kommt deren Repository-Pfad dazu. GitHub Pages muss auf dem Ziel eingerichtet
werden. Der Export wurde lokal vorbereitet, aber nicht gepusht oder live geschaltet.

## Grenzen

Die ursprünglichen `.go`-Dateien fehlen im veröffentlichten Feed. Manifest,
Einstellungen, HTML/JavaScript/CSS des Einstellungspanels, kleine Startskripte und die herunterladbare Binärdatei sind
weiterhin einsehbar. Die Binärdatei enthält keine Debugsymbole oder absoluten
Buildpfade (`-s -w -trimpath`), kann aber analysiert bzw. dekompiliert werden.
Geheimnisse werden deshalb nie in die Binärdatei eingebaut; die Anmeldedaten
kommen weiterhin aus den geschützten SDK-Einstellungen.
