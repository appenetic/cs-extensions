#!/usr/bin/env python3
"""Reproducible SDK 1.0 tar/index builder from the documented wire format.
Run official csdk lint/test/build as well before promoting a release.
"""
import hashlib
import io
import json
import re
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / 'packages'
SITE = ROOT / 'repository'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_settings(manifest):
    # SDK enum IDs are tokens; display titles may contain units such as km/h.
    pattern = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')
    panel = manifest.get('panel', {})
    own = {manifest.get('id', '') + '.' + s['id'] for s in manifest.get('settings', [])}
    scope = panel.get('settings', [])
    if len(scope) != len(set(scope)):
        raise ValueError('Duplicate panel setting scope')
    if any(s not in own for s in scope) and not manifest.get('id', '').startswith('dev.coilshift.'):
        raise ValueError('Panel settings must belong to the package')
    for setting in manifest.get('settings', []):
        if setting['type'] != 'enum':
            continue
        values = [v['value'] for v in setting['values']]
        if (not 2 <= len(values) <= 64 or len(set(values)) != len(values)
                or any(not isinstance(v, str) or not pattern.fullmatch(v)
                       or v in ('true', 'false') for v in values)
                or setting.get('default', values[0]) not in values):
            raise ValueError('Invalid SDK enum setting: ' + setting['id'])


# Packages with a panel get a versioned HTML entry and content-addressed assets,
# so a cached old page can never be served under the URLs of a new release. The
# archive of such a package holds an explicit allowlist: no developer docs or source.
RELEASES = {
    'com.appenetic.home-assistant': {
        'entry': 'panel/settings-{version}.html',
        'assets': ['app.js', 'style.css', 'settings-schema.js'],
        'allowed': {'coilshift.json', 'hooks', 'hooks/apply.sh', 'hooks/remove.sh',
                    'hooks/service.sh', 'bin', 'bin/bridge-linux-amd64', 'NOTICE',
                    'LICENSE-CoilShift-SDK', 'LICENSE-QR-Code', 'panel', 'panel/index.html', 'panel/app.js',
                    'panel/style.css', 'panel/settings-schema.js', 'panel/csdk-panel.js', 'panel/csdk-panel.css'},
    },
    # No panel: the launcher tile is served by the package's own web service.
    'com.appenetic.claude': {
        'allowed': {'coilshift.json', 'hooks', 'hooks/apply.sh', 'hooks/remove.sh', 'hooks/link.sh',
                    'hooks/web.sh', 'bin', 'bin/claude-linux-amd64', 'ui', 'ui/card.uiml', 'NOTICE',
                    'LICENSE-CoilShift-SDK', 'LICENSE-QR-Code', 'web', 'web/app.html', 'web/app.js',
                    'web/app.css', 'web/csdk-panel.css', 'web/icon.png'},
    },
    # Shell only: hooks and the library they share, no README.
    'com.appenetic.welcome-animation': {
        'allowed': {'coilshift.json', 'hooks', 'hooks/apply.sh', 'hooks/remove.sh', 'lib', 'lib/intro.sh'},
    },
}


def build_package(PACKAGE):
    manifest = json.loads((PACKAGE / 'coilshift.json').read_text())
    validate_settings(manifest)
    release_files = set()
    release = RELEASES.get(manifest['id'])
    if manifest['id'] == 'com.appenetic.home-assistant':
        # Public declarations/defaults only; never runtime setting values/secrets.
        schema = {'package': manifest['id'], 'version': manifest['version'],
                  'settings': manifest['settings']}
        (PACKAGE / 'panel/settings-schema.js').write_text(
            'window.haSettingsSchema=' + json.dumps(schema, ensure_ascii=True, separators=(',', ':')) + ';\n')
    if release and 'entry' in release:
        # Change both the iframe URL and every changing asset URL per release.
        html = (PACKAGE / 'panel/index.html').read_text()
        for source in release['assets']:
            data = (PACKAGE / 'panel' / source).read_bytes()
            stem, suffix = source.rsplit('.', 1)
            filename = stem + '.' + sha(data)[:12] + '.' + suffix
            (PACKAGE / 'panel' / filename).write_bytes(data)
            html = html.replace('"' + source + '"', '"' + filename + '"')
            release_files.add('panel/' + filename)
        entry = manifest['panel']['entry']
        expected = release['entry'].format(version=manifest['version'])
        if entry != expected:
            raise ValueError('Panel entry must be versioned: ' + expected)
        html = html.replace('<body>', '<body><p class="release-version" id="release-version">Oberfläche '
                            + manifest['version'] + '</p>')
        (PACKAGE / entry).write_text(html)
        release_files.add(entry)
    tile = manifest.get('tile')
    if tile and not (PACKAGE / tile['icon']).is_file():
        raise ValueError('Missing tile icon: ' + tile['icon'])
    # Match JSON Compact without reordering keys or HTML escaping.
    compact = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False).encode()
    for hook in [manifest['hooks']['apply'], manifest['hooks']['remove']] + manifest['hooks'].get('service', []):
        p = PACKAGE / hook['run']
        if not p.is_file() or not p.stat().st_mode & 0o111:
            raise ValueError('Missing executable hook: ' + str(p))
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for p in sorted(PACKAGE.rglob('*')):
            if p.is_symlink() or not (p.is_dir() or p.is_file()):
                raise ValueError('Unsupported archive entry: ' + str(p))
            name = p.relative_to(PACKAGE).as_posix()
            # Explicit release allowlist: no developer docs or source files.
            if release and name not in release['allowed'] | release_files:
                continue
            entry = tarfile.TarInfo(name + '/' if p.is_dir() else name)
            entry.mode = 0o755 if p.is_dir() or p.stat().st_mode & 0o111 else 0o644
            if p.is_dir():
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            else:
                data = p.read_bytes()
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
    data = stream.getvalue()
    digest = sha(data)
    (SITE / 'pool').mkdir(parents=True, exist_ok=True)
    (SITE / 'pool' / digest).write_bytes(data)
    # Fixed timestamp for this prerelease keeps rebuilding deterministic.
    published = 1794614400
    print(f'{manifest["id"]}: {digest} {len(data)} bytes')
    return {
        'id': manifest['id'], 'version': manifest['version'], 'sdk': manifest['sdk'],
        'title': manifest['title'], 'published_unix': published, 'withdrawn': False,
        'manifest': manifest, 'manifest_sha256': sha(compact),
        'archive': {'url': 'pool/' + digest, 'sha256': digest, 'bytes': len(data)}}


def build():
    # Keep the original package first for existing consumers.
    packages = sorted(PACKAGES.iterdir(), key=lambda p: (p.name != 'welcome-light', p.name))
    entries = [build_package(p) for p in packages if (p / 'coilshift.json').is_file()]
    index = {'schema': 1, 'repository': {'name': 'Appenetic CS Extensions',
             'homepage': 'https://github.com/appenetic/cs-extensions'},
             'generated_unix': 1794614400, 'packages': entries}
    (SITE / 'index.json').write_text(json.dumps(index, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    build()
