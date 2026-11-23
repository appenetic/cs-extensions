"""Welcome-animation hooks in a fake root against a fake CoilShift daemon (Bash 3.2).

The fixtures copy the structure of the firmware files the package overlays,
not their text. No firmware, QtCar or vehicle is executed.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'packages/welcome-animation'
MARK = '# com.appenetic.welcome-animation'
LIGHTS = 'usr/tesla/UI/assets/AmbientLightsAnimation.json'

RUN = '''#!/bin/bash

LOG_TAG={name}

exec 2>&1

. /etc/tesla.env
. /etc/tvideo.env

if [ ! -f /usr/tesla/UI/assets/videos/vehicle-intro"${{FILE_SUFFIX}}"{display}.mp4 ]; then
    exit 0
fi
'''
TVIDEO = '''CENTER_DISPLAY_SCALE_FACTOR=1.0
VEHICLE_INTRO_CENTER_DISPLAY_SCALE_FACTOR=0.75
FILE_SUFFIX=""
if [[ "$(lv VAPI_vehicleBadging | tr -d '"')" =~ LaunchSeries$ ]]; then
\tFILE_SUFFIX="-launch"
    VEHICLE_INTRO_CENTER_DISPLAY_SCALE_FACTOR="$CENTER_DISPLAY_SCALE_FACTOR"
elif [[ "$(lv VAPI_performancePackage | tr -d '"')" = Performance ]]; then
    FILE_SUFFIX="-perf"
fi
'''


def animation(n, **flags):
    frames = [{'time': 100 * i, 'command': {'target': '.*', 'red': i, 'brightness': 100}} for i in range(n)]
    return dict(flags, stopTime=6000, frames=frames)


ANIMATIONS = {
    'sentry': animation(2, repeat=True),
    'preWelcome': animation(1, welcomeanimation=True),
    'welcomeLS': animation(15, welcomeanimation=True),
    'welcomePerf': animation(22, welcomeanimation=True),
    'welcome': animation(4, welcomeanimation=True),
}

# Routes of the daemon the hooks use, with the overlay ledger kept in files.
FAKE_CURL = '''#!{python} -I
import json, os, shutil, sys
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
daemon, root, state = Path(os.environ['FAKE_CSDK']), os.environ['CSDK_FAKE_ROOT'], Path(os.environ['CSDK_STATE'])
path = url[len('http://csdk'):]
with open(daemon / 'calls', 'a') as f:
    f.write(method + ' ' + path + ' ' + body + '\\n')
def reply(code):
    sys.exit(0 if code < 400 else 22)
if (method, path) == ('PUT', '/v1/status'):
    (daemon / 'status').write_text(body)
    reply(200)
if (method, path) == ('POST', '/v1/restarts'):
    with open(daemon / 'restarts', 'a') as f:
        f.write(body + '\\n')
    reply(200)
if path.startswith('/v1/overlays/'):
    name = path.rsplit('/', 1)[1]
    mounted, original = daemon / 'mounted' / name, daemon / 'original' / name
    if method == 'PUT':
        if name in os.environ.get('FAKE_CSDK_REFUSE', '').split():
            reply(403)
        request = json.loads(body)
        target = Path(root + request['target'])
        if not mounted.exists():
            for copy in (original, state / 'overlays' / name / 'pristine'):
                copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(target, copy)
            mounted.write_text(request['target'])
        shutil.copyfile(request['source'], target)
        reply(200)
    if method == 'DELETE':
        if not mounted.exists():
            reply(404)
        shutil.copyfile(original, Path(root + mounted.read_text()))
        mounted.unlink()
        reply(200)
reply(404)
'''


@unittest.skipUnless(shutil.which('jq'), 'jq is needed, as on the car')
class WelcomeAnimation(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root, self.bin, self.daemon = self.tmp / 'root', self.tmp / 'bin', self.tmp / 'daemon'
        self.run_dir, self.state, self.settings = self.tmp / 'run', self.tmp / 'state', self.tmp / 'settings'
        for d in [self.bin, self.daemon / 'mounted', self.run_dir, self.state, self.settings]:
            d.mkdir(parents=True)
        self.write('etc/tvideo.env', TVIDEO)
        self.write('etc/sv/vehicle-intro/run', RUN.format(name='vehicle-intro', display=''), 0o700)
        self.write('etc/sv/vehicle-intro-1/run', RUN.format(name='vehicle-intro-1', display='-1'), 0o700)
        self.write('etc/sv/camp-mode/run', '#!/bin/bash\n. /etc/tvideo.env\n', 0o700)
        for video in ['', '-1', '-perf', '-perf-1', '-launch']:
            self.write(f'usr/tesla/UI/assets/videos/vehicle-intro{video}.mp4', '')
        self.write(LIGHTS, json.dumps(ANIMATIONS, indent=4))
        self.originals = self.snapshot()
        self.stub('curl', FAKE_CURL.format(python=sys.executable))
        self.stub('pidof', '#!/bin/sh\n[ -n "${FAKE_QTCAR:-}" ] || exit 1\necho 4242\n')
        self.stub('lv', '#!/bin/sh\necho \'"Base"\'\n')
        self.qtcar = True

    def write(self, name, text, mode=0o644):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(mode)

    def stub(self, name, text):
        (self.bin / name).write_text(text)
        (self.bin / name).chmod(0o755)

    def snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def hook(self, name='apply.sh', refuse='', **settings):
        for key, value in settings.items():
            (self.settings / key).write_text(value + '\n')
        env = dict(os.environ, CSDK_PACKAGE_DIR=str(PACKAGE), CSDK_FAKE_ROOT=str(self.root),
                   CSDK_RUN=str(self.run_dir), CSDK_STATE=str(self.state), CSDK_SETTINGS=str(self.settings),
                   CSDK_API_SOCKET=str(self.tmp / 'api.sock'), CSDK_TOKEN='test-token',
                   FAKE_CSDK=str(self.daemon), FAKE_CSDK_REFUSE=refuse, FAKE_QTCAR='1' if self.qtcar else '',
                   PATH=f'{self.bin}:{os.environ["PATH"]}')
        return subprocess.run(['/bin/bash', str(PACKAGE / 'hooks' / name)], env=env, capture_output=True, text=True)

    def apply(self, code=0, **settings):
        result = self.hook(**settings)
        self.assertEqual(result.returncode, code, result.stderr)
        return json.loads((self.daemon / 'status').read_text())

    def restarts(self):
        path = self.daemon / 'restarts'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def calls(self):
        return (self.daemon / 'calls').read_text().splitlines()

    def lights(self):
        return json.loads((self.root / LIGHTS).read_text())

    def selection(self, name='vehicle-intro'):
        # What tvideo.env picks when the (overlaid) run script sources it.
        text = (self.root / 'etc/sv' / name / 'run').read_text()
        keep = [line for line in text.splitlines()
                if line.startswith((MARK, 'lv() {')) or line in ('. /etc/tvideo.env', 'unset -f lv')]
        script = '\n'.join(keep).replace('/etc/tvideo.env', str(self.root / 'etc/tvideo.env'))
        script += '\necho "$FILE_SUFFIX|$VEHICLE_INTRO_CENTER_DISPLAY_SCALE_FACTOR|$(type -t lv)"\n'
        out = subprocess.run(['/bin/bash', '-c', script], env=dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}'),
                             capture_output=True, text=True, check=True).stdout
        return tuple(out.strip().split('|'))

    def assert_stock(self):
        self.assertEqual(self.snapshot(), self.originals)
        self.assertEqual(list((self.daemon / 'mounted').iterdir()), [])

    def test_default_changes_nothing(self):
        status = self.apply()
        self.assertEqual(status['state'], 'ok')
        self.assertIn('Ab Werk', status['reason'])
        self.assert_stock()
        self.assertEqual(self.restarts(), [])
        self.assertEqual(self.selection(), ('', '0.75', 'file'))

    def test_performance_video_and_light(self):
        status = self.apply(animation='performance')
        self.assertEqual(status['state'], 'ok')
        self.assertIn('Performance mit Ambientelicht', status['reason'])
        self.assertIn('Neustart des Touchscreens', status['reason'])
        for name in ['vehicle-intro', 'vehicle-intro-1']:
            self.assertEqual(self.selection(name), ('-perf', '0.75', 'file'))
            text = (self.root / 'etc/sv' / name / 'run').read_text()
            self.assertEqual(text.count(MARK), 1)
            original = self.originals[f'etc/sv/{name}/run'].decode().splitlines()
            self.assertEqual([line for line in text.splitlines() if not line.startswith((MARK, 'lv() {')) and line != 'unset -f lv'],
                             original)
            self.assertEqual((self.run_dir / 'overlays' / f'{name}.run').stat().st_mode & 0o777, 0o700)
        lights = self.lights()
        for key in ['welcome', 'welcomePerf', 'welcomeLS']:
            self.assertEqual(lights[key], ANIMATIONS['welcomePerf'])
        self.assertEqual({k: lights[k] for k in ['sentry', 'preWelcome']},
                         {k: ANIMATIONS[k] for k in ['sentry', 'preWelcome']})
        self.assertEqual(list(lights), list(ANIMATIONS))
        self.assertEqual((self.run_dir / 'overlays/ambient-lights.json').stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.restarts(), [{'target': 'ui', 'parked': True}])
        self.assertEqual(self.snapshot()['etc/sv/camp-mode/run'], self.originals['etc/sv/camp-mode/run'])
        self.assertEqual(self.snapshot()['etc/tvideo.env'], self.originals['etc/tvideo.env'])

    def test_rerun_and_switch_render_from_the_stock_files(self):
        self.apply(animation='performance')
        status = self.apply(animation='performance')
        self.assertNotIn('Neustart', status['reason'])
        self.assertEqual(len(self.restarts()), 1)
        self.apply(animation='launch')
        self.assertFalse([c for c in self.calls() if c.startswith('DELETE')],
                         'with the daemons pristine copies a switch keeps the overlays on')
        self.assertEqual(self.selection(), ('-launch', '1.0', 'file'))
        self.assertEqual(self.selection('vehicle-intro-1'), ('-launch', '1.0', 'file'))
        self.assertEqual((self.root / 'etc/sv/vehicle-intro/run').read_text().count(MARK), 1)
        self.assertEqual(self.lights()['welcome'], ANIMATIONS['welcomeLS'])
        self.apply(animation='standard')
        self.assertEqual(self.selection(), ('', '0.75', 'file'))
        self.assertEqual(self.lights()['welcomePerf'], ANIMATIONS['welcome'])
        self.assertEqual(len(self.restarts()), 3)

    def test_back_to_stock_restores_every_file(self):
        self.apply(animation='performance')
        status = self.apply(animation='stock')
        self.assertIn('Ab Werk', status['reason'])
        self.assert_stock()
        self.assertEqual(len(self.restarts()), 2, 'QtCar still holds the performance light')

    def test_lights_off_keeps_the_stock_light(self):
        status = self.apply(animation='performance', lights='false')
        self.assertIn('Ambientelicht wie ab Werk', status['reason'])
        self.assertEqual(self.selection(), ('-perf', '0.75', 'file'))
        self.assertEqual(self.snapshot()[LIGHTS], self.originals[LIGHTS])
        self.assertEqual(self.restarts(), [])
        self.apply(animation='performance', lights='true')
        self.assertEqual(self.lights()['welcome'], ANIMATIONS['welcomePerf'])
        self.assertEqual(len(self.restarts()), 1)

    def test_no_restart_while_qtcar_is_not_running(self):
        self.qtcar = False
        status = self.apply(animation='performance')
        self.assertEqual(self.lights()['welcome'], ANIMATIONS['welcomePerf'])
        self.assertEqual(self.restarts(), [])
        self.assertNotIn('Neustart', status['reason'])

    def test_other_firmware_logic_changes_nothing(self):
        self.apply(animation='performance')
        self.write('etc/tvideo.env', 'FILE_SUFFIX=""\n')
        self.originals['etc/tvideo.env'] = self.snapshot()['etc/tvideo.env']
        status = self.apply(10, animation='launch')
        self.assertEqual(status['state'], 'unsupported')
        self.assert_stock()
        self.assertEqual(len(self.restarts()), 2, 'QtCar still holds the performance light')

    def test_missing_video_changes_nothing(self):
        (self.root / 'usr/tesla/UI/assets/videos/vehicle-intro-launch.mp4').unlink()
        del self.originals['usr/tesla/UI/assets/videos/vehicle-intro-launch.mp4']
        status = self.apply(10, animation='launch')
        self.assertEqual(status['state'], 'unsupported')
        self.assert_stock()

    def test_firmware_without_the_light_animation_keeps_the_video(self):
        stock = dict(ANIMATIONS)
        del stock['welcomePerf']
        self.write(LIGHTS, json.dumps(stock))
        self.originals[LIGHTS] = self.snapshot()[LIGHTS]
        status = self.apply(animation='performance')
        self.assertEqual(status['state'], 'ok')
        self.assertIn('kein passendes Ambientelicht', status['reason'])
        self.assertEqual(self.selection(), ('-perf', '0.75', 'file'))
        self.assertEqual(self.snapshot()[LIGHTS], self.originals[LIGHTS])

    def test_refused_overlay_leaves_the_factory_state(self):
        result = self.hook(refuse='vehicle-intro-1', animation='performance')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads((self.daemon / 'status').read_text())['state'], 'failed')
        self.assert_stock()

    def test_two_tvideo_lines_are_refused(self):
        path = self.root / 'etc/sv/vehicle-intro/run'
        self.write('etc/sv/vehicle-intro/run', path.read_text() + '. /etc/tvideo.env\n', 0o700)
        self.originals['etc/sv/vehicle-intro/run'] = path.read_bytes()
        result = self.hook(animation='performance')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assert_stock()

    def test_switch_without_the_daemons_pristine_copy(self):
        self.apply(animation='performance')
        shutil.rmtree(self.state / 'overlays')
        self.apply(animation='launch')
        self.assertEqual(self.selection(), ('-launch', '1.0', 'file'))
        self.assertEqual((self.root / 'etc/sv/vehicle-intro/run').read_text().count(MARK), 1)
        self.assertEqual(self.lights()['welcome'], ANIMATIONS['welcomeLS'])
        self.apply(animation='stock')
        self.assert_stock()

    def test_remove_takes_everything_back(self):
        self.apply(animation='launch')
        result = self.hook('remove.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_stock()
        self.assertEqual(len(self.restarts()), 2)

    def test_remove_without_light_needs_no_restart(self):
        self.apply(animation='launch', lights='false')
        self.assertEqual(self.hook('remove.sh').returncode, 0)
        self.assert_stock()
        self.assertEqual(self.restarts(), [])


if __name__ == '__main__':
    unittest.main()
