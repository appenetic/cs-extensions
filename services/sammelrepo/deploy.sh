#!/bin/bash
# Testet und baut das Sammel-Repo für den Server und spielt es ein.
#   GO=/pfad/zu/go services/sammelrepo/deploy.sh
# Die Ersteinrichtung (Benutzerdatei, Caddy) steht in README.md.
set -euo pipefail
HOST=${HOST:-root@159.69.252.1}
GO=${GO:-go}
cd "$(dirname "$0")"
export GOTOOLCHAIN=local
"$GO" vet ./...
"$GO" test -count=1 ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 "$GO" build -trimpath -ldflags="-s -w" -o build/cs-sammelrepo .
ssh "$HOST" 'test -s /srv/sammelrepo/benutzer' || {
	echo "Auf dem Server fehlt /srv/sammelrepo/benutzer, siehe README.md (Ersteinrichtung)." >&2
	exit 1
}
scp -q build/cs-sammelrepo "$HOST":/srv/sammelrepo/cs-sammelrepo.neu
scp -q deploy/cs-sammelrepo.service "$HOST":/etc/systemd/system/cs-sammelrepo.service
ssh "$HOST" 'set -e
chmod 0755 /srv/sammelrepo/cs-sammelrepo.neu
mv /srv/sammelrepo/cs-sammelrepo.neu /srv/sammelrepo/cs-sammelrepo
systemctl daemon-reload
systemctl enable --quiet cs-sammelrepo
systemctl restart cs-sammelrepo
sleep 2
systemctl is-active cs-sammelrepo
journalctl -u cs-sammelrepo -n 3 --no-pager -o cat'
