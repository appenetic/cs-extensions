"""The quiet view app's shell side: the tile the apply hook installs and the
service hook, against a fake CoilShift daemon (Bash 3.2, umask 0077 as on the
car). The web service is a Go binary; its source and tests stay private."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'packages/quiet-view'
PORT = '29911'
TILE = 'com-appenetic-quiet-view.app'

# The routes the hooks use; every request is logged as "METHOD path body".
FAKE_CURL = '''#!{python} -I
import os, sys
from pathlib import Path
args, method, url, body = sys.argv[1:], 'GET', '', ''
i = 0
while i < len(args):
    if args[i] == '-X':
        method = args[i + 1]
    elif args[i] == '--data-binary':
        body = args[i + 1]
    elif args[i] not in ('-H', '--unix-socket', '--connect-timeout', '--max-time'):
        url = args[i] if args[i].startswith('http://csdk') else url
        i += 1
        continue
    i += 2
daemon = Path(os.environ['FAKE_CSDK'])
path = url[len('http://csdk'):]
with open(daemon / 'requests', 'a') as log:
    log.write(f'{{method}} {{path}} {{body}}\\n')
if (method, path) == ('PUT', '/v1/status'):
    (daemon / 'status').write_text(body)
    sys.exit(0)
if (method, path) == ('PUT', '/v1/web/app'):
    print('{{"port":29911,"netns":"chromium-entertainment","origin":"http://127.0.0.1:29911"}}')
    sys.exit(0)
if (method, path) == ('PUT', '/v1/tiles/app'):
    if (daemon / 'fail-tiles').exists():
        sys.exit(22)
    print('{{"id":"com-appenetic-quiet-view.app"}}')
    sys.exit(0)
sys.exit(22)
'''


class QuietView(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.daemon, self.bin = self.tmp / 'daemon', self.tmp / 'bin'
        self.run_dir, self.state_dir = self.tmp / 'run', self.tmp / 'state'
        for d in [self.daemon, self.bin, self.run_dir, self.state_dir]:
            d.mkdir(parents=True)
        (self.bin / 'curl').write_text(FAKE_CURL.format(python=sys.executable))
        (self.bin / 'curl').chmod(0o755)

    def env(self, **extra):
        env = dict(os.environ, CSDK_PKG='com.appenetic.quiet-view', CSDK_PACKAGE_DIR=str(PACKAGE),
                   CSDK_RUN=str(self.run_dir), CSDK_STATE=str(self.state_dir), CSDK_WEB_APP_PORT=PORT,
                   CSDK_API_SOCKET=str(self.tmp / 'api.sock'), CSDK_TOKEN='test-token', FAKE_CSDK=str(self.daemon),
                   PATH=f'{self.bin}:{os.environ["PATH"]}')
        env.update(extra)
        return env

    def hook(self, name, **extra):
        return subprocess.run(['/bin/bash', '-c', f'umask 077; exec /bin/bash "$CSDK_PACKAGE_DIR/hooks/{name}.sh"'],
                              env=self.env(**extra), capture_output=True, text=True)

    def test_apply_installs_a_maximized_tile_for_the_web_port(self):
        result = self.hook('apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        tile = self.state_dir / 'tile'
        requests = (self.daemon / 'requests').read_text().splitlines()
        # The route names the tile; the daemon makes the tile ID of it.
        self.assertIn(f'PUT /v1/tiles/app {{"dir":"{tile}"}}', requests)
        definition = tile / 'def'
        self.assertEqual(sorted(p.name for p in definition.iterdir()),
                         ['config', 'icon.png', 'webapp.json', 'webappLocData_en.json'])
        self.assertEqual(oct(definition.stat().st_mode & 0o777), '0o755')
        for f in definition.iterdir():
            self.assertEqual(oct(f.stat().st_mode & 0o777), '0o644', f.name)
        config = (definition / 'config').read_text()
        self.assertIn(f'export CHROMIUM_CONFIG_INSTANCE_ID="{TILE}"\n', config)
        self.assertIn(f'export CHROMIUM_CONFIG_X11_WINDOW_NAME="WebApp.{TILE}"\n', config)
        self.assertIn(f'export CHROMIUM_CONFIG_STARTING_URL="http://127.0.0.1:{PORT}/"\n', config)
        self.assertIn('export CHROMIUM_CONFIG_SANDBOX_PROFILE="chromium-entertainment"\n', config)
        app = json.loads((definition / 'webapp.json').read_text())[TILE]
        self.assertEqual(app['title'], 'Quiet')
        self.assertEqual(app['url'], f'http://127.0.0.1:{PORT}/')
        for key in ['allowInDrive', 'canMaximizeAppWindow', 'appWindowDefaultOpensToMaximized',
                    'appWindowIsMaximizedOnly', 'showInLauncher', 'isBackgroundMainlyDark']:
            self.assertIs(app[key], True, key)
        self.assertIs(app['showAppWindowTopBar'], False)
        allowed = [re.compile(p) for p in app['allowedUrls']]
        self.assertTrue(all(any(p.match(u) for p in allowed)
                            for u in [f'http://127.0.0.1:{PORT}/state', f'http://localhost:{PORT}/']))
        self.assertFalse(any(p.match(u) for p in allowed
                             for u in [f'http://127.0.0.10:{PORT}/', f'http://127.0.0.1:{PORT}0/', 'https://example.com/']))
        self.assertEqual(json.loads((definition / 'webappLocData_en.json').read_text()), {TILE: {'title': 'Quiet'}})
        self.assertEqual((definition / 'icon.png').read_bytes(), (PACKAGE / 'web/icon.png').read_bytes())
        # The same definition again: the daemon sees no change.
        before = (definition / 'webapp.json').read_bytes()
        self.assertEqual(self.hook('apply').returncode, 0)
        self.assertEqual((definition / 'webapp.json').read_bytes(), before)

    def test_apply_fails_without_a_port_or_a_tile(self):
        result = self.hook('apply', CSDK_WEB_APP_PORT='')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Kein Web-Port', (self.daemon / 'status').read_text())
        (self.daemon / 'fail-tiles').touch()
        result = self.hook('apply')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Kachel', (self.daemon / 'status').read_text())

    def test_remove_leaves_the_rest_to_the_ledger(self):
        result = self.hook('remove')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.daemon / 'requests').exists())

    def test_service_hook_runs_only_on_an_x86_64_mcu(self):
        uname = self.bin / 'uname'
        uname.write_text('#!/bin/sh\necho aarch64\n')
        uname.chmod(0o755)
        result = self.hook('web')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.daemon / 'status').read_text())['state'], 'unsupported')
        self.assertEqual(list(self.run_dir.iterdir()), [])
        script = (PACKAGE / 'hooks/web.sh').read_text()
        self.assertIn('cp "$CSDK_PACKAGE_DIR/bin/quiet-linux-amd64" "$CSDK_RUN/quiet.new"', script)
        self.assertIn('exec "$CSDK_RUN/quiet"', script)


class QuietViewFiles(unittest.TestCase):
    def test_manifest_declares_no_tile_of_its_own(self):
        manifest = json.loads((PACKAGE / 'coilshift.json').read_text())
        self.assertNotIn('tile', manifest)
        self.assertIn('tile', manifest['capabilities'])
        self.assertEqual(manifest['web'], [{'name': 'app', 'service': 'web'}])
        self.assertEqual(manifest['hooks']['service'], [{'id': 'web', 'run': 'hooks/web.sh', 'restart': 'on-failure'}])

    def test_page_loads_only_its_own_files(self):
        html = (PACKAGE / 'web/index.html').read_text()
        self.assertIn('src="app.js"', html)
        self.assertIn('href="app.css"', html)
        self.assertNotIn('http', html)
        js = (PACKAGE / 'web/app.js').read_text()
        for needle in ["new EventSource('events')", "fetch('state'", "askWindow('max')", "askWindow('close')",
                       "'X-Quiet': '1'", "fetch('options'", 'bendFor(v.yaw)', 'paceFor(v.kmh)']:
            self.assertIn(needle, js)

    @unittest.skipUnless(shutil.which('node'), 'node checks the script syntax')
    def test_script_parses(self):
        subprocess.run(['node', '--check', str(PACKAGE / 'web/app.js')], check=True)


if __name__ == '__main__':
    unittest.main()
