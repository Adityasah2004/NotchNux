// Self-check for src/helpers/sensors.js. Run: gjs -m tests/sensors-check.js
// Exits non-zero on the first failure. Builds a fake /sys/class/hwmon tree
// shaped like a ThinkPad (coretemp, nvme, thinkpad with a fan, acpitz).

import GLib from 'gi://GLib';
import {
    discoverHwmon, pickSensors, parseMilliC, tempLevel, pickFan, fanLevelOf, fanWrites, FAN_LEVELS,
    writeSysfs, canWrite, fmtRpm, readTemp,
} from '../src/helpers/sensors.js';
import { ConfigStore } from '../src/helpers/config.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const loop = new GLib.MainLoop(null, false);
let failed = null;

async function main() {
    // ---- a fake hwmon tree ----
    let root = GLib.dir_make_tmp('nn-hwmon-XXXXXX');
    let put = (rel, text) => {
        let path = `${root}/${rel}`;
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, text);
        return path;
    };
    put('hwmon2/name', 'acpitz\n');
    put('hwmon2/temp1_input', '57000\n');
    put('hwmon4/name', 'nvme\n');
    put('hwmon4/temp1_input', '40850\n');
    put('hwmon4/temp1_label', 'Composite\n');
    put('hwmon4/temp2_input', '47850\n');
    put('hwmon4/temp2_label', 'Sensor 1\n');
    put('hwmon7/name', 'thinkpad\n');
    put('hwmon7/temp1_input', '57000\n');
    put('hwmon7/temp1_label', 'CPU\n');
    put('hwmon7/temp2_input', '');          // the dGPU sleeps (ENXIO reads as nothing)
    put('hwmon7/temp2_label', 'GPU\n');
    put('hwmon7/fan1_input', '2900\n');
    put('hwmon7/fan2_input', '0\n');
    put('hwmon7/pwm1', '0\n');
    put('hwmon7/pwm1_enable', '2\n');
    put('hwmon8/name', 'coretemp\n');
    put('hwmon8/temp2_input', '59000\n');
    put('hwmon8/temp2_label', 'Core 0\n');
    put('hwmon8/temp1_input', '64000\n');
    put('hwmon8/temp1_label', 'Package id 0\n');
    put('hwmon10/name', 'iwlwifi_1_9\n');
    put('hwmon10/temp1_input', '45000\n');
    put('hwmon10/pwm2', '0\n');             // no pwm2_enable: not controllable

    let chips = await discoverHwmon(root);
    eq(chips.map(c => c.name), ['acpitz', 'nvme', 'thinkpad', 'coretemp', 'iwlwifi_1_9'], 'chips in hwmon number order (10 after 8)');
    let coretemp = chips.find(c => c.name === 'coretemp');
    eq(coretemp.temps.map(t => t.label), ['Package id 0', 'Core 0'], 'temps in index order, with labels');
    eq(chips.find(c => c.name === 'thinkpad').pwms, ['pwm1'], 'pwm with its _enable');
    eq(chips.find(c => c.name === 'iwlwifi_1_9').pwms, [], 'pwm without _enable is skipped');
    eq(chips.find(c => c.name === 'thinkpad').fans.map(f => GLib.path_get_basename(f)), ['fan1_input', 'fan2_input'], 'fans');

    // ---- picking sensors ----
    let picked = pickSensors(chips);
    eq([picked.cpu.label, picked.ssd.label, picked.gpu.label], ['Package id 0', 'Composite', 'GPU'], 'cpu / ssd / gpu picked');
    eq(await readTemp(picked.cpu.path), 64, 'cpu package reads 64 °C');
    eq(await readTemp(picked.gpu.path), null, 'sleeping gpu reads nothing');
    eq(pickSensors(chips.filter(c => c.name !== 'coretemp')).cpu.label, 'CPU', 'no coretemp: thinkpad CPU');
    eq(pickSensors(chips.filter(c => c.name === 'acpitz')).cpu.label, 'acpitz', 'only acpitz: its first sensor, named by chip');
    let suffixed = [{ name: 'acpitz_0', dir: '/z', temps: [{ input: '/z/temp1_input', label: '' }], pwms: [], fans: [] }];
    eq(pickSensors(suffixed).cpu, { path: '/z/temp1_input', label: 'acpitz' }, 'chip name with an instance suffix (acpitz_0)');
    eq(pickSensors([{ ...suffixed[0], name: 'acpitzx' }]).cpu, null, 'but not a different chip that starts the same');
    let amd = [{ name: 'k10temp', dir: '/x', temps: [{ input: '/x/temp1_input', label: 'Tctl' }], pwms: [], fans: [] },
        { name: 'amdgpu', dir: '/y', temps: [{ input: '/y/temp1_input', label: 'edge' }], pwms: [], fans: [] }];
    eq([pickSensors(amd).cpu.label, pickSensors(amd).gpu.label, pickSensors(amd).ssd], ['Tctl', 'edge', null], 'AMD: Tctl, edge, no ssd');
    eq(pickSensors([]), { cpu: null, ssd: null, gpu: null }, 'no chips: nothing');

    // ---- readings ----
    eq([parseMilliC('64000\n'), parseMilliC('40850'), parseMilliC(''), parseMilliC(null), parseMilliC('0'),
        parseMilliC('-128000'), parseMilliC('200000'), parseMilliC('abc')], [64, 40.85, null, null, null, null, null, null],
    'millidegrees → °C; empty, 0, negative, absurd and junk → null');
    eq([tempLevel('cpu', 69), tempLevel('cpu', 70), tempLevel('cpu', 85), tempLevel('ssd', 54), tempLevel('ssd', 55), tempLevel('ssd', 70)],
        [0, 1, 2, 0, 1, 2], 'temperature levels: cpu 70/85, ssd 55/70');
    eq(tempLevel('other', 86), 2, 'unknown kind uses the cpu limits');
    eq([fmtRpm(2900), fmtRpm(0)], ['2900 rpm', 'stopped'], 'rpm text');

    // ---- fan ----
    let fan = pickFan(chips);
    eq(fan.name, 'thinkpad', 'the controllable fan');
    ok(fan.pwm.endsWith('hwmon7/pwm1') && fan.enable.endsWith('hwmon7/pwm1_enable'), 'its pwm files');
    eq(pickFan(chips.filter(c => c.name !== 'thinkpad')), null, 'no pwm with _enable: no fan control');
    eq(FAN_LEVELS.map(l => l[0]), ['auto', 'low', 'med', 'high', 'max', 'off'], 'levels in the order shown');
    eq([fanLevelOf('2', '0'), fanLevelOf('5', '0'), fanLevelOf('0', '0'), fanLevelOf('1', '0'), fanLevelOf('1', '255')],
        ['auto', 'auto', 'max', 'off', 'max'], 'mode → level');
    // A ThinkPad reads back level × 255 / 7: 64 → 72, 128 → 145, 191 → 182.
    eq([fanLevelOf('1', '72'), fanLevelOf('1', '145'), fanLevelOf('1', '182'), fanLevelOf('1', '36')],
        ['low', 'med', 'high', 'low'], 'firmware-rounded pwm → nearest level');
    eq([fanLevelOf('', '0'), fanLevelOf(null, null), fanLevelOf('1', '')], [null, null, null], 'unreadable → null');
    eq(fanWrites('auto', fan), [[fan.enable, '2']], 'auto: mode only');
    eq(fanWrites('auto', fan, '5'), [[fan.enable, '5']], 'auto restores the firmware’s own mode');
    eq(fanWrites('low', fan), [[fan.enable, '1'], [fan.pwm, '64']], 'manual: mode first, then speed');
    eq(fanWrites('off', fan), [[fan.enable, '1'], [fan.pwm, '0']], 'off is manual 0');
    let threw = false;
    try {
        fanWrites('turbo', fan);
    } catch (e) {
        threw = true;
    }
    ok(threw, 'unknown level refused');

    // ---- writing ----
    let target = put('w/pwm1', '');
    await writeSysfs(target, '128');
    eq(new TextDecoder().decode(GLib.file_get_contents(target)[1]), '128', 'written in place');
    ok(await canWrite(target), 'writable file');
    GLib.chmod(target, 0o444);
    ok(!(await canWrite(target)), 'read-only file');
    let refused = false;
    try {
        await writeSysfs(`${root}/missing/pwm1`, '1');
    } catch (e) {
        refused = true;
    }
    ok(refused, 'a failed write rejects');
    ok(!(await canWrite(`${root}/missing`)), 'missing file is not writable');

    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(root)}`);
}

// ---- config keys (read-only: never saves) ----
const cfg = obj => new ConfigStore({ contents: new TextEncoder().encode(JSON.stringify(obj)) });
eq([cfg({}).pillTemp, cfg({ pillTemp: 'ssd' }).pillTemp, cfg({ pillTemp: 'bogus' }).pillTemp], ['off', 'ssd', 'off'], 'pill temperature');
eq([cfg({}).trayTemps, cfg({ trayTemps: 1 }).trayTemps, cfg({}).fanControl, cfg({ fanControl: true }).fanControl],
    [false, true, false, true], 'tray temperatures and fan control are opt-in');

main().catch(e => {
    failed = e;
}).finally(() => loop.quit());
loop.run();
if (failed) {
    printerr(`FAIL: ${failed}\n${failed.stack}`);
    imports.system.exit(1);
}
print(`sensors-check: ${n} checks passed`);
