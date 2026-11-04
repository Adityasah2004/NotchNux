// Temperatures and fan control, from the kernel's hwmon interface. No actors
// here, so tests/sensors-check.js can run it under plain `gjs -m`.
//
// /sys/class/hwmon/hwmonN holds one chip each: `name`, tempN_input
// (millidegrees, with an optional tempN_label), fanN_input (RPM), and pwmN
// (0–255) with pwmN_enable (0 full speed, 1 manual, 2+ automatic). Reading
// is open to everyone; writing pwm needs the one-time tools/fan-setup.sh.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const HWMON_DIR = '/sys/class/hwmon';

// → the file's text, or null (missing, or a sensor that's asleep: ENXIO).
export function readText(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (f, res) => {
            try {
                resolve(new TextDecoder().decode(f.load_contents_finish(res)[1]));
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function listNames(dir) {
    return new Promise(resolve => {
        Gio.File.new_for_path(dir).enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (d, res) => {
                let en;
                try {
                    en = d.enumerate_children_finish(res);
                } catch (e) {
                    resolve([]);
                    return;
                }
                let out = [];
                let more = () => en.next_files_async(64, GLib.PRIORITY_LOW, null, (e, r) => {
                    let infos = [];
                    try {
                        infos = e.next_files_finish(r);
                    } catch (err) {
                        // stop at a read error
                    }
                    out.push(...infos.map(i => i.get_name()));
                    if (infos.length)
                        more();
                    else
                        en.close_async(GLib.PRIORITY_LOW, null, () => resolve(out));
                });
                more();
            });
    });
}

const num = s => parseInt(/\d+/.exec(s)?.[0] ?? '0');
const byNum = (a, b) => num(a) - num(b);

// Every chip → [{ name, dir, temps: [{ input, label }], pwms: ['pwm1'…],
// fans: [path…] }]. A pwm only counts with its _enable (no way back to auto
// without one).
export async function discoverHwmon(root = HWMON_DIR) {
    let entries = (await listNames(root)).sort(byNum);
    return Promise.all(entries.map(async entry => {
        let dir = `${root}/${entry}`;
        let [name, files] = await Promise.all([readText(`${dir}/name`), listNames(dir)]);
        let temps = await Promise.all(files.filter(f => /^temp\d+_input$/.test(f)).sort(byNum).map(async f => ({
            input: `${dir}/${f}`,
            label: (await readText(`${dir}/${f.replace('_input', '_label')}`))?.trim() ?? '',
        })));
        return {
            name: name?.trim() ?? '', dir, temps,
            pwms: files.filter(f => /^pwm\d+$/.test(f) && files.includes(`${f}_enable`)).sort(byNum),
            fans: files.filter(f => /^fan\d+_input$/.test(f)).sort(byNum).map(f => `${dir}/${f}`),
        };
    }));
}

// ---- Temperatures ----

export const SENSOR_KINDS = [['cpu', 'CPU'], ['ssd', 'SSD'], ['gpu', 'GPU']];

// Per kind, [chip name, label pattern (null: its first sensor)], best first.
// ponytail: no nvidia-smi for NVIDIA cards: polling it wakes a sleeping dGPU
// (battery); a GPU that doesn't report through hwmon just isn't shown.
const PICKS = {
    cpu: [['coretemp', /^(Package|Physical) id 0$/], ['k10temp', /^(Tctl|Tdie)$/], ['zenpower', /^(Tdie|Tctl)$/],
        ['thinkpad', /^CPU$/], ['cpu_thermal', null], ['acpitz', null]],
    ssd: [['nvme', /^Composite$/], ['drivetemp', null]],
    gpu: [['amdgpu', /^edge$/], ['nouveau', null], ['radeon', null], ['thinkpad', /^GPU$/]],
};

// Newer kernels add an instance suffix to some chip names (acpitz_0).
const chipIs = (chip, name) => chip.name === name || chip.name.startsWith(`${name}_`);

// Chips → { cpu, ssd, gpu }, each { path, label } or null.
export function pickSensors(chips) {
    let out = {};
    for (let [kind] of SENSOR_KINDS) {
        out[kind] = null;
        for (let [name, re] of PICKS[kind]) {
            let t = chips.filter(c => chipIs(c, name)).map(c => re ? c.temps.find(x => re.test(x.label)) : c.temps[0])
                .find(Boolean);
            if (t) {
                out[kind] = { path: t.input, label: t.label || name };
                break;
            }
        }
    }
    return out;
}

// tempN_input text → °C, or null. 0 and below or 150+ are unused slots and
// "not available" markers, not readings.
export function parseMilliC(text) {
    if (typeof text !== 'string' || !/^\s*-?\d+\s*$/.test(text))
        return null;
    let c = parseInt(text) / 1000;
    return c > 0 && c < 150 ? c : null;
}

export const readTemp = async path => parseMilliC(await readText(path));

// [warm, hot] °C per kind: SSDs throttle far lower than CPUs.
const TEMP_LIMITS = { cpu: [70, 85], gpu: [70, 85], ssd: [55, 70] };

// 0 fine · 1 warm · 2 hot.
export function tempLevel(kind, c) {
    let [warm, hot] = TEMP_LIMITS[kind] ?? TEMP_LIMITS.cpu;
    return c >= hot ? 2 : c >= warm ? 1 : 0;
}

// ---- Fan control (beta) ----

// [id, label, pwm]: Auto hands the fan back to the firmware.
export const FAN_LEVELS = [['auto', 'Auto'], ['low', 'Low', 64], ['med', 'Med', 128], ['high', 'High', 191],
    ['max', 'Max', 255], ['off', 'Off', 0]];
// Manual level → back to Auto at this CPU temperature.
export const FAN_GUARD_C = 85;

// The first pwm channel that can go back to auto, or null.
// ponytail: one channel (one pwm drives both fans on ThinkPads); a desktop
// board with several gets per-channel rows when someone needs them.
export function pickFan(chips) {
    let c = chips.find(x => x.pwms.length);
    return c ? { name: c.name, pwm: `${c.dir}/${c.pwms[0]}`, enable: `${c.dir}/${c.pwms[0]}_enable`, fans: c.fans } : null;
}

// What the fan is doing now → a FAN_LEVELS id, or null if unreadable. A
// manual pwm reads back rounded to the firmware's steps (a ThinkPad has 8),
// so it's the nearest level; full speed (0) shows as Max.
export function fanLevelOf(enableText, pwmText) {
    let e = parseInt(enableText);
    if (!Number.isFinite(e))
        return null;
    if (e === 0)
        return 'max';
    if (e !== 1)
        return 'auto';
    let p = parseInt(pwmText);
    if (!Number.isFinite(p))
        return null;
    let manual = FAN_LEVELS.filter(l => l.length === 3);
    return manual.reduce((a, b) => Math.abs(b[2] - p) < Math.abs(a[2] - p) ? b : a)[0];
}

// The writes for a level, in order: mode first, then the speed. Auto
// writes back the mode the firmware had (`autoEnable`), since boards differ
// in which automatic mode they use.
export function fanWrites(level, fan, autoEnable = '2') {
    if (level === 'auto')
        return [[fan.enable, autoEnable]];
    let l = FAN_LEVELS.find(x => x[0] === level && x.length === 3);
    if (!l)
        throw new Error(`no fan level ${level}`);
    return [[fan.enable, '1'], [fan.pwm, String(l[2])]];
}

// Write in place: a sysfs attribute can't take the temp-file-and-rename that
// replace_contents does. ponytail: append mode on purpose (sysfs ignores the
// offset); don't use this for regular files.
export function writeSysfs(path, text) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).append_to_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null, (f, res) => {
            let stream;
            try {
                stream = f.append_to_finish(res);
            } catch (e) {
                reject(e);
                return;
            }
            stream.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(text)), GLib.PRIORITY_DEFAULT, null, (s, r) => {
                let err = null;
                try {
                    s.write_bytes_finish(r);
                } catch (e) {
                    err = e;
                }
                s.close_async(GLib.PRIORITY_DEFAULT, null, (s2, r2) => {
                    try {
                        s2.close_finish(r2);
                    } catch (e) {
                        err ??= e;
                    }
                    if (err)
                        reject(err);
                    else
                        resolve();
                });
            });
        });
    });
}

// Whether this user may write `path` (the setup's udev rule ran).
export function canWrite(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('access::can-write', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    resolve(f.query_info_finish(res).get_attribute_boolean('access::can-write'));
                } catch (e) {
                    resolve(false);
                }
            });
    });
}

export const fanUsable = async fan => !!fan && (await canWrite(fan.pwm)) && (await canWrite(fan.enable));

export const fmtRpm = rpm => rpm > 0 ? `${rpm} rpm` : 'stopped';
