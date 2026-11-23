import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Package(unittest.TestCase):
    def test_archive_index_and_deterministic_build(self):
        def build():
            subprocess.run(['python3', 'tools/build.py'], cwd=ROOT, check=True, capture_output=True)
            index = (ROOT / 'repository/index.json').read_bytes()
            entry = json.loads(index)['packages'][0]
            archive = (ROOT / 'repository' / entry['archive']['url']).read_bytes()
            return index, entry, archive
        index, entry, archive = build()
        self.assertEqual(hashlib.sha256(archive).hexdigest(), entry['archive']['sha256'])
        self.assertEqual(len(archive), entry['archive']['bytes'])
        manifest = entry['manifest']
        compact = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False).encode()
        self.assertEqual(hashlib.sha256(compact).hexdigest(), entry['manifest_sha256'])
        self.assertFalse(next(s for s in manifest['settings'] if s['id'] == 'enabled')['default'])
        self.assertNotIn('dv.write.any', manifest['capabilities'])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            names = tar.getnames()
            self.assertEqual(names, sorted(names))
            self.assertEqual(len(names), len(set(names)))
            self.assertEqual(json.load(tar.extractfile('coilshift.json')), manifest)
            for member in tar:
                self.assertTrue(member.isfile() or member.isdir())
                self.assertEqual(member.mtime, 0)
                self.assertEqual((member.uid, member.gid), (0, 0))
                self.assertNotIn('..', Path(member.name).parts)
            for hook in [manifest['hooks']['apply'], manifest['hooks']['remove']] + manifest['hooks']['service']:
                self.assertEqual(tar.getmember(hook['run']).mode, 0o755)
        next_index, next_entry, next_archive = build()
        self.assertEqual(index, next_index)
        self.assertEqual(archive, next_archive)

    def test_home_assistant_archive(self):
        subprocess.run(['python3', 'tools/build.py'], cwd=ROOT, check=True, capture_output=True)
        entries = json.loads((ROOT / 'repository/index.json').read_text())['packages']
        entry = next(e for e in entries if e['id'] == 'com.appenetic.home-assistant')
        data = (ROOT / 'repository' / entry['archive']['url']).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), entry['archive']['sha256'])
        self.assertEqual(len(data), entry['archive']['bytes'])
        self.assertEqual({s['id'] for s in entry['manifest']['settings'] if s['type'] == 'secret'},
                         {'password', 'access_token'})
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            binary = archive.extractfile('bin/bridge-linux-amd64').read()
            self.assertEqual(binary[:4], b'\x7fELF')
            self.assertEqual(archive.getmember('hooks/service.sh').mode, 0o755)
            self.assertIn('panel/index.html', archive.getnames())
            self.assertIn('panel/app.js', archive.getnames())
            entry_html = entry['manifest']['panel']['entry']
            self.assertIn(entry_html, archive.getnames())
            self.assertIn('Oberfläche ' + entry['version'], archive.extractfile(entry_html).read().decode())
            self.assertIn('panel', entry['manifest']['capabilities'])
            self.assertFalse(any(n.endswith('.pyc') or '__pycache__' in n for n in archive.getnames()))
            self.assertEqual(json.load(archive.extractfile('coilshift.json')), entry['manifest'])

    def test_claude_archive(self):
        subprocess.run(['python3', 'tools/build.py'], cwd=ROOT, check=True, capture_output=True)
        entries = json.loads((ROOT / 'repository/index.json').read_text())['packages']
        entry = next(e for e in entries if e['id'] == 'com.appenetic.claude')
        manifest = entry['manifest']
        data = (ROOT / 'repository' / entry['archive']['url']).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), entry['archive']['sha256'])
        # A tile ID on the car is the package ID with dashes plus the tile: letters and dashes only.
        self.assertRegex(manifest['id'].replace('.', '-') + '.' + manifest['tile']['id'], r'^[a-z-]+\.[a-z-]+$')
        self.assertEqual(manifest['web'][0]['service'], 'web')
        self.assertFalse(any(c.startswith('dv.write') for c in manifest['capabilities']))
        self.assertNotIn('requires', manifest, 'a missing UI host must not make the package unsupported')
        self.assertNotIn('panel', manifest, 'the app is the launcher tile; no tab in the CoilShift app')
        self.assertNotIn('panel', manifest['capabilities'])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            names = set(archive.getnames())
            binary = archive.extractfile('bin/claude-linux-amd64').read()
            self.assertEqual(binary[:4], b'\x7fELF')
            for hook in ['hooks/apply.sh', 'hooks/remove.sh', 'hooks/link.sh', 'hooks/web.sh']:
                self.assertEqual(archive.getmember(hook).mode, 0o755)
            for name in ['web/app.html', 'web/app.js', 'web/app.css', 'web/icon.png', 'ui/card.uiml', manifest['tile']['icon']]:
                self.assertIn(name, names)
            self.assertFalse(any(n.startswith('panel') for n in names))
            self.assertFalse(any(n.endswith(('.go', '.md', '.mjs', '.py')) for n in names))
            self.assertEqual(json.load(archive.extractfile('coilshift.json')), manifest)

    def test_welcome_archives(self):
        subprocess.run(['python3', 'tools/build.py'], cwd=ROOT, check=True, capture_output=True)
        entries = json.loads((ROOT / 'repository/index.json').read_text())['packages']
        ids = [e['id'] for e in entries]
        self.assertNotIn('com.appenetic.welcome-animation', ids, 'its settings were unreachable; retired')
        for kind in ['performance', 'launch']:
            entry = next(e for e in entries if e['id'] == 'com.appenetic.welcome-' + kind)
            manifest = entry['manifest']
            data = (ROOT / 'repository' / entry['archive']['url']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry['archive']['sha256'])
            # Overlays and a parked UI restart only: no DataValue is written.
            self.assertEqual(manifest['capabilities'], ['overlay', 'restart:ui'])
            self.assertNotIn('service', manifest['hooks'])
            self.assertNotIn('settings', manifest)
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                self.assertEqual(sorted(archive.getnames()),
                                 ['coilshift.json', 'hooks', 'hooks/apply.sh', 'hooks/remove.sh', 'lib', 'lib/intro.sh'])
                for hook in ['hooks/apply.sh', 'hooks/remove.sh']:
                    self.assertEqual(archive.getmember(hook).mode, 0o755)
                self.assertEqual(json.load(archive.extractfile('coilshift.json')), manifest)

    def test_sdk_enum_tokens(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'tools/build.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        for path in (ROOT / 'packages').glob('*/coilshift.json'):
            builder.validate_settings(json.loads(path.read_text()))
        manifest = json.loads((ROOT / 'packages/home-assistant/coilshift.json').read_text())
        self.assertEqual(set(manifest['panel']['settings']),
                         {manifest['id'] + '.' + s['id'] for s in manifest['settings']})
        manifest['panel']['settings'].append('other.package.password')
        with self.assertRaisesRegex(ValueError, 'belong'):
            builder.validate_settings(manifest)
        with self.assertRaisesRegex(ValueError, 'speed_unit'):
            builder.validate_settings({'settings': [{'id': 'speed_unit', 'type': 'enum',
                'values': [{'value': 'km/h'}, {'value': 'm/s'}], 'default': 'km/h'}]})

    def test_shell_syntax(self):
        for path in (ROOT / 'packages').rglob('*.sh'):
            subprocess.run(['/bin/bash', '-n', str(path)], check=True)


if __name__ == '__main__':
    unittest.main()
