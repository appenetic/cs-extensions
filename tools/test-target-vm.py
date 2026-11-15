#!/usr/bin/env python3
"""Run the package transport/state smoke test in an isolated firmware VM.
Requires the existing TeslaMCU initramfs with its optional `fuzz` test entry.
All guest writes are in RAM. The firmware and base initramfs remain read-only.
"""
import argparse
import gzip
import re
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def cpio_entry(name, data, mode, ino):
    name_bytes = name.encode() + b'\0'
    fields = [ino, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(name_bytes), 0]
    out = b'070701' + b''.join(('%08x' % x).encode() for x in fields) + name_bytes
    out += b'\0' * (-len(out) % 4)
    out += data + b'\0' * (-len(data) % 4)
    return out


def init_from_cpio(data):
    offset = 0
    while offset < len(data):
        if data[offset:offset + 6] != b'070701':
            raise ValueError('Expected newc initramfs')
        fields = [int(data[offset + 6 + i * 8:offset + 14 + i * 8], 16) for i in range(13)]
        size, namesize = fields[6], fields[11]
        name = data[offset + 110:offset + 110 + namesize - 1]
        start = (offset + 110 + namesize + 3) & ~3
        if name in (b'init', b'./init'):
            return data[start:start + size]
        offset = (start + size + 3) & ~3
    raise ValueError('Missing init')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--kernel', type=Path, required=True)
    p.add_argument('--initrd', type=Path, required=True)
    p.add_argument('--firmware', type=Path, required=True)
    p.add_argument('--ha-test-binary', type=Path, default=Path('/private/tmp/ha-tests-linux-amd64'))
    p.add_argument('--qemu', default='qemu-system-x86_64')
    p.add_argument('--log', type=Path)
    p.add_argument('--suite', choices=['smoke', 'service', 'firmware', 'home-assistant', 'telemetry-values'], default='smoke')
    args = p.parse_args()
    for path in [args.kernel, args.initrd, args.firmware]:
        if not path.is_file():
            p.error('Missing file: ' + str(path))
    runtime = (ROOT / 'packages/welcome-light/lib/runtime.sh').read_text()
    block = "cat > /tmp/runtime.sh <<'RUNTIME_END'\n" + runtime + 'RUNTIME_END'
    script = (ROOT / 'tests/target-transport.sh.in').read_text().replace('@@RUNTIME@@', block)
    if args.suite == 'service':
        blocks = []
        for rel in ['lib/runtime.sh', 'hooks/apply.sh', 'hooks/remove.sh', 'hooks/service.sh']:
            content = (ROOT / 'packages/welcome-light' / rel).read_text()
            blocks.append("cat > /tmp/pkg/" + rel + " <<'PACKAGE_FILE_END'\n" + content + 'PACKAGE_FILE_END')
        script = (ROOT / 'tests/target-service.sh.in').read_text().replace('@@PACKAGE@@', '\n'.join(blocks))
    if args.suite == 'firmware':
        script = (ROOT / 'tests/target-firmware.sh.in').read_text()
    if args.suite == 'telemetry-values':
        script = (ROOT / 'tests/target-telemetry-values.sh.in').read_text()
    if args.suite == 'home-assistant':
        blocks = []
        for rel in ['hooks/service.sh']:
            content = (ROOT / 'packages/home-assistant' / rel).read_text()
            blocks.append("cat > /tmp/pkg/" + rel + " <<'PACKAGE_FILE_END'\n" + content + 'PACKAGE_FILE_END')
        script = (ROOT / 'tests/target-home-assistant.sh.in').read_text().replace('@@PACKAGE@@', '\n'.join(blocks))
    extra = cpio_entry('fuzz.sh', script.encode(), 0o100755, 9001)
    if args.suite == 'home-assistant':
        for name, path in [('ha-bridge', ROOT / 'packages/home-assistant/bin/bridge-linux-amd64'),
                           ('ha-tests', args.ha_test_binary)]:
            extra += cpio_entry(name, path.read_bytes(), 0o100755, 9003 if name == 'ha-bridge' else 9004)
        init = init_from_cpio(gzip.decompress(args.initrd.read_bytes())).decode()
        needle = 'cp /fuzz.sh /mnt/root/fuzz.sh;'
        if needle not in init:
            raise ValueError('Unrecognized fuzz init entry')
        init = init.replace(needle, 'cp /ha-bridge /ha-tests /mnt/root/; ' + needle)
        extra += cpio_entry('init', init.encode(), 0o100755, 9005)
    extra += cpio_entry('TRAILER!!!', b'', 0, 9002)
    with tempfile.TemporaryDirectory(prefix='welcome-vm-') as work:
        initrd = Path(work) / 'test-initrd.gz'
        initrd.write_bytes(args.initrd.read_bytes() + gzip.compress(extra, mtime=0))
        result = subprocess.run([
            args.qemu, '-machine', 'q35', '-accel', 'tcg', '-cpu', 'max',
            '-m', '2048', '-smp', '2', '-kernel', str(args.kernel.resolve()),
            '-initrd', str(initrd), '-append', 'console=ttyS0 fuzz panic=1 loglevel=4',
            '-drive', 'if=virtio,format=raw,file=' + str(args.firmware.resolve()) + ',readonly=on',
            '-nic', 'none', '-display', 'none', '-serial', 'stdio', '-monitor', 'none',
            '-no-reboot'], capture_output=True, text=True, timeout=180)
    output = result.stdout + result.stderr
    if args.log:
        args.log.write_text(output)
    for line in output.splitlines():
        if 'WELCOME_' in line or args.suite == 'home-assistant' and 'HA_VM_' in line:
            print(line)
    expected = ['WELCOME_TARGET_TRANSPORT_PASS', 'WELCOME_TARGET_STATE_PASS', 'WELCOME_TARGET_DONE']
    if args.suite == 'service':
        expected = ['WELCOME_SERVICE_' + name + '_PASS' for name in
                    ['TIMEOUT', 'gear', 'occupancy', 'disabled', 'telemetry', 'TERM',
                     'HTTP_FAILURE', 'AUTH', 'HOOKS']] + ['WELCOME_SERVICE_DONE']
    if args.suite == 'firmware':
        expected = ['WELCOME_FIRMWARE_DONE', 'string "com.tesla.Debug"']
        write_result = output.split('WELCOME_FIRMWARE_WRITE_BEGIN')[-1].split('WELCOME_FIRMWARE_WRITE_END')[0]
        restore_result = output.split('WELCOME_FIRMWARE_RESTORE_BEGIN')[-1].split('WELCOME_FIRMWARE_RESTORE_END')[0]
        if 'string "ParkingLights"' not in write_result or 'string "<invalid>"' not in restore_result:
            print(output[-10000:])
            raise SystemExit('Native Debug write/restore was not verified')
        print(output[output.find('WELCOME_FIRMWARE_BUS_NAMES_BEGIN'):])
    if args.suite == 'home-assistant':
        expected = ['HA_VM_DONE', '--- PASS: TestProductionService']
        print(output[output.find('=== RUN   Test'):])
        if not any(marker in output for marker in ['HA_VM_SERVICE_TESTS_PASS']):
            raise SystemExit('Home Assistant runtime result missing')
    if args.suite == 'telemetry-values':
        expected = ['TELEMETRY_VALUES_DONE', 'string \"com.tesla.Debug\"']
        print(output[output.find('WELCOME_FIRMWARE_BUS_NAMES_BEGIN'):])
        for name in ['NAV_vehicleLatitude', 'NAV_vehicleLongitude', 'NAV_vehicleSpeedMph',
                     'VAPI_vehicleSpeed', 'VAPI_driverDoor', 'VAPI_driverDoorAlert',
                     'VAPI_doorState', 'DOOR_frontDriverDoor']:
            block = output.split('TELEMETRY_READ_BEGIN ' + name + '\n')[-1].split('TELEMETRY_READ_END')[0]
            if 'boolean true' not in block:
                raise SystemExit('Native DataValue missing: ' + name)
        for name, value in [('NAV_vehicleLatitude', '52.512345'), ('NAV_vehicleLongitude', '13.412345'),
                            ('NAV_vehicleSpeedMph', '10'), ('VAPI_driverDoor', 'true'),
                            ('VAPI_driverDoor', 'false')]:
            block = output.split('TELEMETRY_SYNTHETIC_BEGIN ' + name + ' ' + value + '\n')[-1].split('TELEMETRY_SYNTHETIC_END')[0]
            observed = re.findall(r'string "([^"\n]*)"', block)
            expected_value = value if value in ('true', 'false') else format(float(value), '.3f')
            if 'boolean true' not in block or observed != [expected_value]:
                raise SystemExit('Scalar readback mismatch: ' + name)
        unknown = output.split('TELEMETRY_READ_BEGIN AppeneticNonexistentProbeValue\n')[-1].split('TELEMETRY_READ_END')[0]
        if 'boolean false' not in unknown or 'string ""' not in unknown:
            raise SystemExit('Unknown-name negative control failed')
    if result.returncode or 'HA_VM_FAIL' in output or '_FAIL ' in output or 'WELCOME_TARGET_TRANSPORT_FAIL' in output or 'WELCOME_TARGET_STATE_FAIL' in output or any(x not in output for x in expected) or 'Kernel panic' in output:
        print(output[-6000:])
        raise SystemExit('Target VM smoke test failed')
    print('Target VM exited cleanly; backend behavior is limited to the selected suite.')


if __name__ == '__main__':
    main()
