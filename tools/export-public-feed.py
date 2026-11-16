#!/usr/bin/env python3
"""Export only verified release artifacts, never the development checkout."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
HOME_ASSISTANT = 'com.appenetic.home-assistant'
# Shell lifecycle adapters are intentionally readable; application logic is ELF.
RUNTIME_FILES = {
    'coilshift.json', 'hooks/apply.sh', 'hooks/remove.sh', 'hooks/service.sh',
    'bin/bridge-linux-amd64', 'NOTICE', 'LICENSE-CoilShift-SDK', 'LICENSE-QR-Code',
    'panel/index.html', 'panel/app.js', 'panel/style.css', 'panel/settings-schema.js',
    'panel/csdk-panel.js', 'panel/csdk-panel.css',
}
PUBLIC_README = '''# Appenetic CS package feed

This export contains generated Home Assistant package artifacts only.
The application source belongs in a separate private repository and is not
included here. The package contains a compiled Linux executable and small,
readable lifecycle scripts. Compiled executables can still be reverse engineered.

Feed path: `cs-extensions/index.json`

`index.json`, `index.html` and `pool/<sha256>` are generated from the development
build. Package archives are content-addressed and verified against the index.
Publish only this directory to the public feed repository, never its parent.
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_package(entry, repository):
    if entry['id'] != HOME_ASSISTANT:
        raise ValueError('Only the compiled Home Assistant package is approved for this feed')
    archive = entry['archive']
    sha = archive['sha256']
    if not re.fullmatch(r'[0-9a-f]{64}', sha) or archive['url'] != 'pool/' + sha:
        raise ValueError('Unsafe or non-content-addressed archive path')
    path = repository / 'pool' / sha
    if path.is_symlink():
        raise ValueError('Archive must not be a symlink')
    data = path.read_bytes()
    if digest(data) != sha or len(data) != archive['bytes']:
        raise ValueError('Archive checksum or length mismatch')
    manifest = entry['manifest']
    compact = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False).encode()
    if digest(compact) != entry['manifest_sha256']:
        raise ValueError('Manifest checksum mismatch')
    if manifest['id'] != entry['id'] or manifest['version'] != entry['version']:
        raise ValueError('Manifest identity mismatch')
    release_entry = 'panel/settings-' + manifest['version'] + '.html'
    if manifest.get('panel', {}).get('entry') != release_entry:
        raise ValueError('Expected versioned panel entry')
    seen = set()
    files = set()
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar:
            name = member.name
            parts = PurePosixPath(name).parts
            if (name in seen or not parts or name.startswith('/') or '..' in parts
                    or str(PurePosixPath(name)) != name):
                raise ValueError('Unsafe or duplicate archive member')
            seen.add(name)
            if member.isdir():
                if name not in {'hooks', 'bin', 'panel'}:
                    raise ValueError('Unexpected package directory: ' + name)
                continue
            if not member.isfile() or (name not in RUNTIME_FILES and name != release_entry
                    and not re.fullmatch(r'panel/(app|style|settings-schema)\.[0-9a-f]{12}\.(js|css)', name)):
                raise ValueError('Source or unexpected file in public archive: ' + name)
            files.add(name)
        required = RUNTIME_FILES | {release_entry}
        if not required <= files:
            raise ValueError('Missing runtime artifacts')
        html = tar.extractfile(release_entry).read().decode()
        if 'Oberfläche ' + manifest['version'] not in html:
            raise ValueError('Missing visible panel version')
        for source, suffix in [('app', 'js'), ('style', 'css'), ('settings-schema', 'js')]:
            pattern = source + r'\.([0-9a-f]{12})\.' + suffix
            references = re.findall(pattern, html)
            if len(references) != 1:
                raise ValueError('Expected exactly one versioned asset: ' + source)
            filename = 'panel/' + source + '.' + references[0] + '.' + suffix
            if filename not in files or digest(tar.extractfile(filename).read())[:12] != references[0]:
                raise ValueError('Versioned asset checksum mismatch: ' + source)
        if json.load(tar.extractfile('coilshift.json')) != manifest:
            raise ValueError('Embedded manifest mismatch')
        binary = tar.extractfile('bin/bridge-linux-amd64').read()
        if binary[:6] != b'\x7fELF\x02\x01' or binary[18:20] != b'\x3e\x00':
            raise ValueError('Expected compiled Linux AMD64 executable')
    return sha, data


def export(repository, output):
    repository, output = Path(repository).resolve(), Path(output).absolute()
    # Refuse an existing directory: stale source/files must never hitch a ride.
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new directory; do not export into an existing checkout')
    index = json.loads((repository / 'index.json').read_text())
    entries = [e for e in index['packages'] if e['id'] == HOME_ASSISTANT]
    if len(entries) != 1:
        raise ValueError('Expected exactly one Home Assistant release')
    blobs = [validate_package(e, repository) for e in entries]
    public_index = {'schema': index['schema'], 'repository': {
        'name': 'Appenetic CS Extensions',
    }, 'generated_unix': index['generated_unix'], 'packages': entries}
    encoded = (json.dumps(public_index, indent=2, ensure_ascii=False) + '\n').encode()
    # Validation completes before creating any output.
    output.mkdir(parents=True)
    feed = output / 'cs-extensions'
    (feed / 'pool').mkdir(parents=True)
    (output / '.nojekyll').write_bytes(b'')
    (output / 'README.md').write_text(PUBLIC_README)
    (feed / '.nojekyll').write_bytes(b'')
    for name in ['index.json', 'index.html']:
        (feed / name).write_bytes(encoded)
    for sha, data in blobs:
        (feed / 'pool' / sha).write_bytes(data)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New directory for a source-free public repository')
    parser.add_argument('--no-build', action='store_true', help='Validate and export the existing index')
    args = parser.parse_args()
    if not args.no_build:
        subprocess.run([sys.executable, str(ROOT / 'tools/build.py')], check=True)
    print(export(ROOT / 'repository', args.output))


if __name__ == '__main__':
    main()
