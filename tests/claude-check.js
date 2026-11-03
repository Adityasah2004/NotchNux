// Self-check for src/helpers/claude.js. Run: gjs -m tests/claude-check.js
// Exits non-zero on the first failure.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    parseSession, procStat, isLive, alertFor, parseUsage, sortSessions, pillDots,
    fmtAge, wrapCommand, unwrapCommand, isConnected, connectStatusLine, disconnectStatusLine,
} from '../src/helpers/claude.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// ---- parseSession: status mapping ----
const sess = extra => JSON.stringify({ pid: 42, procStart: '367027', cwd: '/home/u/Projetos/NotchNux',
    name: 'notchnux-bf', kind: 'interactive', statusUpdatedAt: 1000, startedAt: 10, ...extra });
eq(parseSession(sess({ status: 'busy' })).state, 'working', 'busy');
eq(parseSession(sess({ status: 'shell' })).state, 'working', 'shell');
eq(parseSession(sess({ status: 'idle' })).state, 'done', 'idle');
for (let w of ['permission prompt', 'sandbox request', 'worker request'])
    eq(parseSession(sess({ status: 'waiting', waitingFor: w })).state, 'approval', w);
for (let w of ['input needed', 'goal proposal', 'dialog open', undefined])
    eq(parseSession(sess({ status: 'waiting', waitingFor: w })).state, 'question', `waiting ${w}`);
let s = parseSession(sess({ status: 'idle' }));
eq([s.pid, s.procStart, s.name, s.folder, s.since], [42, '367027', 'notchnux-bf', 'NotchNux', 1000], 'fields');
eq(parseSession(sess({ name: '', status: 'idle' })).name, 'NotchNux', 'name falls back to folder');
eq(parseSession(sess({ procStart: 367027 })).procStart, '367027', 'numeric procStart');
ok(parseSession(sess({ kind: 'daemon' })) === null, 'daemon skipped');
ok(parseSession(sess({ kind: 'daemon-worker' })) === null, 'daemon-worker skipped');
ok(parseSession('{"pid": 4') === null, 'half-written file');
ok(parseSession('') === null, 'empty file');

// ---- /proc stat + liveness ----
const stat = '72238 (claude code) S 10701 72238 10701 34817 72238 4194304 790550 9708272 1018 1246 11301 985 4650 8596 20 0 36 0 367027 5895725056';
eq(procStat(stat), { ppid: 10701, start: '367027' }, 'procStat with a space in comm');
ok(isLive(s, stat), 'live when start matches');
ok(!isLive({ ...s, procStart: '1' }, stat), 'dead when pid reused');
ok(!isLive(s, null), 'dead when /proc entry missing');

// ---- alertFor ----
const st = state => ({ name: 'x', state });
ok(alertFor(undefined, st('approval')) === null, 'no alert on first sight');
eq(alertFor(st('working'), st('approval')), { state: 'approval', title: 'x', value: 'needs approval' }, 'working→approval');
eq(alertFor(st('working'), st('question')).value, 'has a question', 'working→question');
eq(alertFor(st('working'), st('done')).value, 'finished', 'working→done');
eq(alertFor(st('done'), st('approval')).value, 'needs approval', 'done→approval (missed working step)');
ok(alertFor(st('done'), st('done')) === null, 'done→done');
ok(alertFor(st('question'), st('done')) === null, 'question→done is not "finished"');
ok(alertFor(st('approval'), st('working')) === null, 'approved → no alert');

// ---- parseUsage ----
const now = 1_800_000_000_000;
const usage = JSON.stringify({ rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: now / 1000 + 3600 },
    seven_day: { used_percentage: 41.2, resets_at: now / 1000 - 1 } } });
eq(parseUsage(usage, now), { fiveHour: { pct: 23.5, resetsAt: now + 3600000 }, weekly: { pct: 0, resetsAt: null } }, 'usage + past reset');
eq(parseUsage(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } }), now),
    { fiveHour: { pct: 5, resetsAt: null }, weekly: null }, 'missing window');
ok(parseUsage('{"cwd":"/x"}', now) === null, 'no rate_limits');
ok(parseUsage('', now) === null, 'no file');

// ---- ordering + dots ----
const mk = (pid, state, since, startedAt = pid) => ({ pid, state, since, startedAt });
eq(sortSessions([mk(1, 'done', 5), mk(2, 'working', 1), mk(3, 'question', 2), mk(4, 'approval', 3)]).map(x => x.pid),
    [4, 3, 2, 1], 'needs-you first, then working, then done, newest first');
let unseen = new Set([3]);
eq(pillDots([mk(2, 'approval', 0), mk(1, 'working', 0), mk(3, 'done', 0), mk(4, 'done', 0)], unseen),
    [{ kind: 'working', count: 0 }, { kind: 'waiting', count: 0 }, { kind: 'fresh', count: 0 }, { kind: 'done', count: 0 }],
    '4 sessions: one dot each, in start order');
eq(pillDots([mk(1, 'working', 0), mk(2, 'working', 0), mk(3, 'approval', 0), mk(4, 'done', 0), mk(5, 'done', 0)], unseen),
    [{ kind: 'waiting', count: 1 }, { kind: 'working', count: 2 }, { kind: 'done', count: 2 }], '5 sessions collapse to counts');
eq([fmtAge(10000), fmtAge(4 * 60000), fmtAge(125 * 60000)], ['now', '4m', '2h 5m'], 'fmtAge');

// ---- status-line connect / disconnect ----
const ponytail = 'bash "/home/u/.claude/plugins/cache/ponytail/ponytail/4.8.4/hooks/ponytail-statusline.sh"';
const original = { env: { A: '1' }, statusLine: { type: 'command', command: ponytail, padding: 0 }, model: 'opus' };
const text = o => JSON.stringify(o, null, 2) + '\n';
let connected = connectStatusLine(original);
ok(isConnected(connected) && !isConnected(original), 'isConnected');
eq(unwrapCommand(connected.statusLine.command), ponytail, 'original survives quoting');
eq(Object.keys(connected), Object.keys(original), 'key order kept');
eq(connected.statusLine.padding, 0, 'other statusLine keys kept');
eq(connectStatusLine(connected), connected, 'connect is idempotent');
eq(text(disconnectStatusLine(JSON.parse(text(connected)))), text(original), 'round trip restores the file exactly');
let bare = { model: 'opus' };
eq(text(disconnectStatusLine(connectStatusLine(bare))), text(bare), 'no statusLine before → none after');
eq(disconnectStatusLine(original), original, 'disconnect of a foreign command is a no-op');
let tricky = `echo "it's \\"quoted\\"" | cat; printf '%s' $HOME`;
eq(unwrapCommand(wrapCommand(tricky)), tricky, 'quotes, pipes and $ survive');

// ---- run the wrapped command for real, in a scratch HOME ----
let home = GLib.dir_make_tmp('nn-claude-XXXXXX');
let cacheFile = `${home}/.cache/notchnux/claude-usage.json`;
function runWrapped(original, input) {
    let launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE });
    launcher.setenv('HOME', home, true);
    let proc = launcher.spawnv(['sh', '-c', wrapCommand(original)]);
    let [, out] = proc.communicate_utf8(input, null);
    return [out, proc.get_exit_status()];
}
let [out, code] = runWrapped('', '{"cwd":"/x"}');
eq([out, code], ['', 0], 'no original: prints nothing, exit 0');
ok(!GLib.file_test(cacheFile, GLib.FileTest.EXISTS), 'no rate_limits → nothing saved');
[out] = runWrapped('cat; echo " <- seen"', usage);
eq(out, `${usage} <- seen\n`, 'original gets the same input and its output passes through');
eq(new TextDecoder().decode(GLib.file_get_contents(cacheFile)[1]), usage, 'rate_limits input saved');
runWrapped('true', '{"cwd":"/y"}');
eq(new TextDecoder().decode(GLib.file_get_contents(cacheFile)[1]), usage, 'later input without rate_limits keeps the file');
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);

print(`claude-check: ${n} checks passed`);
