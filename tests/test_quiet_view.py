"""The quiet view app: helpers, /state, the HTTP handler socat runs, the window
requests to QtCar and the tile the apply hook installs, against a fake CoilShift
daemon and a fake dbus-send (Bash 3.2, umask 0077 as on the car)."""
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

# The routes the package uses; every request is logged as "METHOD path body".
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
if method == 'GET' and path.startswith('/v1/dv/'):
    value = daemon / 'dv' / path[len('/v1/dv/'):]
    if value.exists():
        sys.stdout.write(value.read_text())
        sys.exit(0)
sys.exit(22)
'''

FAKE_DBUS = '''#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_CSDK/dbus"
[ ! -e "$FAKE_CSDK/fail-dbus" ]
'''


class QuietView(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.daemon, self.bin = self.tmp / 'daemon', self.tmp / 'bin'
        self.run_dir, self.state_dir = self.tmp / 'run', self.tmp / 'state'
        for d in [self.daemon / 'dv', self.bin, self.run_dir, self.state_dir]:
            d.mkdir(parents=True)
        for name, script in [('curl', FAKE_CURL.format(python=sys.executable)), ('dbus-send', FAKE_DBUS)]:
            (self.bin / name).write_text(script)
            (self.bin / name).chmod(0o755)
        self.dv(GUI_rgbColor='255,131,0', GUI_navNextDestinationArrivalInfoValid='false')

    def dv(self, **values):
        for name, value in values.items():
            (self.daemon / 'dv' / name).write_text(value)

    def env(self, **extra):
        env = dict(os.environ, CSDK_PKG='com.appenetic.quiet-view', CSDK_PACKAGE_DIR=str(PACKAGE),
                   CSDK_RUN=str(self.run_dir), CSDK_STATE=str(self.state_dir), CSDK_WEB_APP_PORT=PORT,
                   CSDK_API_SOCKET=str(self.tmp / 'api.sock'), CSDK_TOKEN='test-token', FAKE_CSDK=str(self.daemon),
                   PATH=f'{self.bin}:{os.environ["PATH"]}')
        env.update(extra)
        return env

    def bash(self, script):
        result = subprocess.run(['/bin/bash', '-c', 'umask 077\n. "$CSDK_PACKAGE_DIR/lib/quiet.sh"\n' + script],
                                env=self.env(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def hook(self, name, **extra):
        return subprocess.run(['/bin/bash', '-c', f'umask 077; exec /bin/bash "$CSDK_PACKAGE_DIR/hooks/{name}.sh"'],
                              env=self.env(**extra), capture_output=True, text=True)

    def http(self, request):
        result = subprocess.run(['/bin/bash', str(PACKAGE / 'lib/http.sh')], input=request.encode(), env=self.env(),
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        head, _, body = result.stdout.partition(b'\r\n\r\n')
        lines = head.decode().split('\r\n')
        headers = dict(line.split(': ', 1) for line in lines[1:])
        return lines[0], headers, body

    def state(self):
        return json.loads((self.run_dir / 'state.json').read_text())

    def dbus(self):
        log = self.daemon / 'dbus'
        return log.read_text().splitlines() if log.exists() else []

    def test_colour_time_minutes_and_km(self):
        out = self.bash('''for c in 255,131,0 0,0,0 007,8,9 "" 256,0,0 1,2 1,2,3,4 "<invalid>"; do quiet_color "$c"; done
for t in 16:41:00 9:05:00 "<invalid>" 25:00:00; do printf '[%s]\\n' "$(quiet_time "$t")"; done
for m in 15.3 14.5 0 "<invalid>" 1.2.3; do printf '[%s]\\n' "$(quiet_minutes "$m")"; done
for k in 5.4 0 "<invalid>"; do printf '[%s]\\n' "$(quiet_km "$k")"; done''')
        self.assertEqual(out.splitlines(), [
            '#ff8300', '#000000', '#070809', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff',
            '[16:41]', '[9:05]', '[]', '[]',
            '[15]', '[15]', '[0]', '[]', '[]',
            '[8,7]', '[0,0]', '[]'])

    def test_state_without_a_trip_has_only_the_colour(self):
        self.bash('quiet_state')
        self.assertEqual(self.state(), {'color': '#ff8300', 'trip': False, 'eta': '', 'min': '', 'km': ''})

    def test_state_with_a_trip(self):
        self.dv(GUI_navNextDestinationArrivalInfoValid='true', GUI_navNextDestinationArrivalTime='16:41:00',
                NAV_minutesToArrival='14.6', NAV_milesToArrival='5.4', GUI_navDestinationLocationName='<redacted>')
        self.bash('quiet_state')
        self.assertEqual(self.state(), {'color': '#ff8300', 'trip': True, 'eta': '16:41', 'min': '15', 'km': '8,7'})
        self.assertNotIn('redacted', (self.run_dir / 'state.json').read_text())

    def test_http_serves_the_app_and_state(self):
        self.bash('quiet_state')
        for path, ctype, source in [('/', 'text/html; charset=utf-8', PACKAGE / 'web/index.html'),
                                    ('/app.js', 'text/javascript; charset=utf-8', PACKAGE / 'web/app.js'),
                                    ('/app.css', 'text/css; charset=utf-8', PACKAGE / 'web/app.css'),
                                    ('/icon.png', 'image/png', PACKAGE / 'web/icon.png'),
                                    ('/state?t=1', 'application/json', self.run_dir / 'state.json')]:
            with self.subTest(path):
                status, headers, body = self.http(f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nAccept: */*\r\n\r\n')
                self.assertEqual(status, 'HTTP/1.1 200 OK')
                self.assertEqual(headers['Content-Type'], ctype)
                self.assertEqual(body, source.read_bytes())
                self.assertEqual(int(headers['Content-Length']), len(body))
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertIn("default-src 'self'", headers['Content-Security-Policy'])

    def test_http_refuses_what_it_does_not_serve(self):
        cases = [('GET / HTTP/1.1\r\nHost: evil.example:29911\r\n\r\n', '421 Misdirected Request'),
                 ('GET / HTTP/1.1\r\n\r\n', '421 Misdirected Request'),
                 (f'POST /state HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '405 Method Not Allowed'),
                 (f'OPTIONS /window/max HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '405 Method Not Allowed'),
                 (f'GET /window/max HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '404 Not Found'),
                 (f'GET /../coilshift.json HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '404 Not Found'),
                 (f'GET /lib/quiet.sh HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '404 Not Found'),
                 (f'GET /state HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n', '503 Service Unavailable')]
        for request, expected in cases:
            with self.subTest(request.split('\r\n')[0]):
                status, _, body = self.http(request)
                self.assertEqual(status, 'HTTP/1.1 ' + expected)
                self.assertEqual(body, b'')
        self.assertEqual(self.dbus(), [])

    def test_http_head_has_no_body(self):
        status, headers, body = self.http(f'HEAD / HTTP/1.1\r\nHost: localhost:{PORT}\r\n\r\n')
        self.assertEqual(status, 'HTTP/1.1 200 OK')
        self.assertEqual(int(headers['Content-Length']), len((PACKAGE / 'web/index.html').read_bytes()))
        self.assertEqual(body, b'')

    def test_window_requests_go_to_qtcar_by_the_app_title(self):
        prefix = '--system --print-reply=literal --dest=com.tesla.CenterDisplayDbus /CenterDisplayDbus com.tesla.CenterDisplayDbus.'
        status, _, _ = self.http(f'POST /window/max HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nX-Quiet: 1\r\nContent-Length: 0\r\n\r\n')
        self.assertEqual(status, 'HTTP/1.1 204 No Content')
        status, _, _ = self.http(f'POST /window/close HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nx-quiet: 1\r\n\r\n')
        self.assertEqual(status, 'HTTP/1.1 204 No Content')
        self.assertEqual(self.dbus(), [prefix + 'maximizeAppWindow string:Quiet boolean:true',
                                       prefix + 'setWebAppDismissGestureEnabled string:Quiet boolean:true',
                                       prefix + 'dismissApp string:Quiet boolean:false'])

    def test_window_requests_need_the_header_and_report_a_failed_call(self):
        status, _, _ = self.http(f'POST /window/close HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n\r\n')
        self.assertEqual(status, 'HTTP/1.1 403 Forbidden')
        self.assertEqual(self.dbus(), [])
        (self.daemon / 'fail-dbus').touch()
        status, _, _ = self.http(f'POST /window/max HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nX-Quiet: 1\r\n\r\n')
        self.assertEqual(status, 'HTTP/1.1 502 Bad Gateway')

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


class QuietViewFiles(unittest.TestCase):
    def test_manifest_declares_no_tile_of_its_own(self):
        manifest = json.loads((PACKAGE / 'coilshift.json').read_text())
        self.assertNotIn('tile', manifest)
        self.assertIn('tile', manifest['capabilities'])
        self.assertEqual(manifest['web'], [{'name': 'app', 'service': 'web'}])

    def test_page_loads_only_its_own_files(self):
        html = (PACKAGE / 'web/index.html').read_text()
        self.assertIn('src="app.js"', html)
        self.assertIn('href="app.css"', html)
        self.assertNotIn('http', html)
        js = (PACKAGE / 'web/app.js').read_text()
        self.assertIn("fetch('state'", js)
        self.assertIn("askWindow('max')", js)
        self.assertIn("askWindow('close')", js)
        self.assertIn("'X-Quiet': '1'", js)

    @unittest.skipUnless(shutil.which('node'), 'node checks the script syntax')
    def test_script_parses(self):
        subprocess.run(['node', '--check', str(PACKAGE / 'web/app.js')], check=True)


if __name__ == '__main__':
    unittest.main()
