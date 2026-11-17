import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('public_feed', ROOT / 'tools/export-public-feed.py')
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


class PublicFeed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run(['python3', 'tools/build.py'], cwd=ROOT, check=True, capture_output=True)
        cls.index = json.loads((ROOT / 'repository/index.json').read_text())
        cls.entry = next(e for e in cls.index['packages'] if e['id'] == feed.HOME_ASSISTANT)
        cls.claude = next(e for e in cls.index['packages'] if e['id'] == feed.CLAUDE)

    def test_export_is_only_runtime_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = feed.export(ROOT / 'repository', Path(tmp) / 'public')
            shas = [self.entry['archive']['sha256'], self.claude['archive']['sha256']]
            files = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
            self.assertEqual(files, {'.nojekyll', 'README.md', 'cs-extensions/.nojekyll',
                                    'cs-extensions/index.json', 'cs-extensions/index.html'}
                             | {'cs-extensions/pool/' + sha for sha in shas})
            index = json.loads((output / 'cs-extensions/index.json').read_text())
            self.assertEqual(sorted(e['id'] for e in index['packages']), [feed.CLAUDE, feed.HOME_ASSISTANT])
            self.assertEqual((output / 'cs-extensions/index.html').read_bytes(),
                             (output / 'cs-extensions/index.json').read_bytes())
            for sha in shas:
                self.assertEqual(hashlib.sha256((output / 'cs-extensions/pool' / sha).read_bytes()).hexdigest(), sha)

    def test_welcome_light_stays_out_of_the_public_feed(self):
        entry = next(e for e in self.index['packages'] if e['id'] == 'com.appenetic.welcome-light')
        with self.assertRaisesRegex(ValueError, 'approved'):
            feed.validate_package(entry, ROOT / 'repository')

    def test_existing_output_refused_without_modification(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'secret.go'
            p.write_text('private source')
            with self.assertRaises(ValueError):
                feed.export(ROOT / 'repository', Path(tmp))
            self.assertEqual(p.read_text(), 'private source')

    def test_hash_and_path_tampering_rejected(self):
        for url in ['../secret', '/tmp/secret', 'https://example.invalid/archive']:
            entry = copy.deepcopy(self.entry)
            entry['archive']['url'] = url
            with self.assertRaises(ValueError):
                feed.validate_package(entry, ROOT / 'repository')
        entry = copy.deepcopy(self.entry)
        entry['archive']['bytes'] += 1
        with self.assertRaises(ValueError):
            feed.validate_package(entry, ROOT / 'repository')

    def test_source_in_archive_rejected_even_with_correct_hash(self):
        for entry in [copy.deepcopy(self.entry), copy.deepcopy(self.claude)]:
            with self.subTest(entry['id']):
                self.assert_source_rejected(entry)

    def assert_source_rejected(self, entry):
        original = (ROOT / 'repository' / entry['archive']['url']).read_bytes()
        stream = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(original)) as source, tarfile.open(fileobj=stream, mode='w') as target:
            for member in source:
                target.addfile(member, source.extractfile(member) if member.isfile() else None)
            member = tarfile.TarInfo('main.go')
            data = b'package main\n'
            member.size = len(data)
            target.addfile(member, io.BytesIO(data))
        data = stream.getvalue()
        sha = hashlib.sha256(data).hexdigest()
        entry['archive'] = dict(url='pool/' + sha, sha256=sha, bytes=len(data))
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / 'pool').mkdir()
            (repo / 'pool' / sha).write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'Source or unexpected file'):
                feed.validate_package(entry, repo)

    def test_public_checkout_does_not_track_service_source(self):
        for service in ['home-assistant', 'claude']:
            result = subprocess.run(['git', 'check-ignore', f'services/{service}/main.go'],
                                    cwd=ROOT, check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), f'services/{service}/main.go')
            tracked = subprocess.check_output(['git', 'ls-files', f'services/{service}'], cwd=ROOT)
            self.assertEqual(tracked, b'')

    def test_repeated_exports_are_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            outputs = [feed.export(ROOT / 'repository', Path(tmp) / name) for name in ['a', 'b']]
            def snapshot(output):
                return {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}
            self.assertEqual(snapshot(outputs[0]), snapshot(outputs[1]))


if __name__ == '__main__':
    unittest.main()
