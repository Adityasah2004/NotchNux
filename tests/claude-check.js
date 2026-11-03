// Self-check for src/helpers/claude.js. Run: gjs -m tests/claude-check.js
// Exits non-zero on the first failure.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import {
    parseSession, procStat, isLive, alertFor, parseUsage, sortSessions, pillDots,
    SETTINGS_PATH, fmtAge, wrapCommand, unwrapCommand, isConnected, connectStatusLine, disconnectStatusLine,
    SOCKET_NAME, approveSocketPath, approveCommand, passThrough, describeRequest, decisionBody,
    isApproveConnected, connectApproveHook, disconnectApproveHook,
    HOOK_TIMEOUT_S, settingsLayout, formatSettings,
    parseNeedsAuth, newAuthNames, parseMcpList, mcpSummary,
    SAFE_MODES, rulesOf, removeRule, setDefaultMode, claudeSettingsFiles, readSettingsAsync, writeSettingsAsync,
} from '../src/helpers/claude.js';
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

// ---- approve from the notch: request handling ----
eq(parseSession(sess({ sessionId: 'abc-1', status: 'idle' })).sessionId, 'abc-1', 'sessionId parsed');
eq(parseSession(sess({ status: 'idle' })).sessionId, '', 'no sessionId → empty');
const req = (tool_name, tool_input = {}, extra = {}) => ({ session_id: 'abc-1', cwd: '/home/u/Projetos/NotchNux', tool_name, tool_input, ...extra });
ok(passThrough(req('Bash', {}, { agent_id: 'a1' })), 'subagent prompt goes to the terminal');
for (let t of ['ExitPlanMode', 'AskUserQuestion', 'dialogFoo'])
    ok(passThrough(req(t)), `${t} goes to the terminal`);
ok(!passThrough(req('Bash', { command: 'ls' })), 'main-session Bash is held');
eq(describeRequest(req('Bash', { command: 'npm test' }), 'notchnux-bf'),
    { title: 'notchnux-bf wants to run a command', body: 'npm test', exact: true }, 'Bash');
eq(describeRequest(req('Edit', { file_path: '/x/src/a.js' }), 'nn'), { title: 'nn wants to edit a.js', body: '/x/src/a.js', exact: true }, 'Edit');
eq(describeRequest(req('NotebookEdit', { notebook_path: '/x/n.ipynb' }), 'nn').title, 'nn wants to edit n.ipynb', 'NotebookEdit');
eq(describeRequest(req('Read', { file_path: '/etc/hosts' }), 'nn').title, 'nn wants to read hosts', 'Read');
eq(describeRequest(req('WebFetch', { url: 'https://docs.example.com/a?b=1' }), 'nn'),
    { title: 'nn wants to fetch docs.example.com', body: 'https://docs.example.com/a?b=1', exact: true }, 'WebFetch');
eq(describeRequest(req('mcp__claude_ai_Canva__create-design', { q: 1 }), 'nn'),
    { title: 'nn wants to use claude_ai_Canva · create-design', body: '{"q":1}', exact: true }, 'MCP tool');
eq(describeRequest(req('Glob', { pattern: '*.js' }), 'nn'), { title: 'nn wants to use Glob', body: '{"pattern":"*.js"}', exact: true }, 'other tool');
eq(describeRequest(req('Bash', { command: 'ls' })).title, 'NotchNux wants to run a command', 'no session name → folder');
let long = describeRequest(req('Bash', { command: 'a\nb\nc\nd\ne\nf' }), 'nn').body;
eq(long, 'a\nb\nc\nd…', 'body capped at 4 lines');
ok(describeRequest(req('Bash', { command: 'x'.repeat(500) }), 'nn').body.length <= 241, 'body capped at 240 chars');
ok(describeRequest(req('Bash', {}), 'nn').body === '', 'missing command → empty body');
ok(describeRequest(req('Bash', { command: 'npm test' }), 'nn').exact, 'short command shown exactly');
ok(!describeRequest(req('Bash', { command: 'a\nb\nc\nd\ne' }), 'nn').exact, 'clipped command is not exact');
let bidi = describeRequest(req('Bash', { command: 'echo \u202Eabc' }), 'nn');
ok(!bidi.exact && bidi.body === 'echo \uFFFDabc', `bidi override shown as a marker, not exact: ${JSON.stringify(bidi)}`);
ok(!describeRequest(req('Bash', { command: 'echo a\u0007b' }), 'nn').exact, 'control character is not exact');
ok(describeRequest(req('Bash', { command: 'printf "a\tb"' }), 'nn').exact, 'a tab is fine');

const sugg = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
const decision = (kind, r) => JSON.parse(decisionBody(kind, r)).hookSpecificOutput;
eq(decision('allow', req('Bash')), { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }, 'allow');
eq(decision('always', req('Bash', {}, { permission_suggestions: sugg })).decision,
    { behavior: 'allow', updatedPermissions: sugg }, 'always allow carries the suggestions verbatim');
eq(decision('deny', req('Bash')).decision, { behavior: 'deny', message: 'Denied from NotchNux' }, 'deny');
eq(decisionBody('none', req('Bash')), '{}', 'no decision');

// ---- approve from the notch: hook connect / disconnect ----
const sock = '/run/user/1000/notchnux-claude.sock';
ok(approveSocketPath() === `${GLib.get_user_runtime_dir()}/${SOCKET_NAME}`, 'socket in the user runtime dir');
ok(approveCommand(sock).includes("--unix-socket '/run/user/1000/notchnux-claude.sock'") && approveCommand(sock).endsWith('|| true'),
    `hook command: ${approveCommand(sock)}`);
let hooked = connectApproveHook(original, sock);
ok(isApproveConnected(hooked) && !isApproveConnected(original), 'isApproveConnected');
eq(hooked.hooks.PermissionRequest, [{ hooks: [{ type: 'command', command: approveCommand(sock), timeout: 600 }] }], 'hook entry');
eq(text(disconnectApproveHook(JSON.parse(text(hooked)))), text(original), 'no hooks before → exact restore');
eq(connectApproveHook(hooked, sock), hooked, 'connect is idempotent');
let moved = connectApproveHook(hooked, '/run/user/1001/notchnux-claude.sock');
eq([moved.hooks.PermissionRequest.length, moved.hooks.PermissionRequest[0].hooks[0].command], [1, approveCommand('/run/user/1001/notchnux-claude.sock')],
    'reconnect replaces our entry');
const foreign = { model: 'opus', hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'y' }] }] }, env: { A: '1' } };
let both = connectApproveHook(foreign, sock);
eq(both.hooks.PermissionRequest.length, 2, 'foreign PermissionRequest hook kept');
eq(text(disconnectApproveHook(JSON.parse(text(both)))), text(foreign), 'foreign hooks → exact restore');
eq(disconnectApproveHook(foreign), foreign, 'disconnect without our hook is a no-op');
eq(text(disconnectApproveHook(connectApproveHook(connectStatusLine(original), sock))), text(connectStatusLine(original)),
    'status line wiring untouched');
ok(HOOK_TIMEOUT_S === 600 && approveCommand(sock).includes(`--max-time ${HOOK_TIMEOUT_S} `), 'curl gives up with the hook');
eq(hooked.hooks.PermissionRequest[0].hooks[0].timeout, HOOK_TIMEOUT_S, 'hook timeout');
const emptyGroup = { hooks: { PermissionRequest: [{ matcher: 'X', hooks: [] }] } };
eq(text(disconnectApproveHook(JSON.parse(text(connectApproveHook(emptyGroup, sock))))), text(emptyGroup),
    'a foreign group that was already empty survives');

// ---- settings.json layout survives Connect / Disconnect ----
for (let [what, raw] of [
    ['2 spaces', '{\n  "model": "opus",\n  "env": {\n    "A": "1"\n  }\n}\n'],
    ['4 spaces', '{\n    "model": "opus",\n    "env": {\n        "A": "1"\n    }\n}\n'],
    ['tabs', '{\n\t"model": "opus"\n}\n'],
    ['one line', '{"model":"opus","env":{"A":"1"}}'],
    ['no trailing newline', '{\n  "model": "opus"\n}'],
]) {
    let layout = settingsLayout(raw);
    eq(formatSettings(JSON.parse(raw), layout), raw, `${what}: rewritten as is`);
    let on = formatSettings(connectApproveHook(JSON.parse(raw), sock), layout);
    eq(formatSettings(disconnectApproveHook(JSON.parse(on)), settingsLayout(on)), raw, `${what}: connect → disconnect exact`);
}
eq(formatSettings({ a: 1 }, settingsLayout(null)), '{\n  "a": 1\n}\n', 'no file yet → Claude Code\'s 2-space layout');

// ---- MCP health ----
eq(parseSession(sess({ status: 'idle' })).cwd, '/home/u/Projetos/NotchNux', 'session cwd kept');
const authText = JSON.stringify({ 'claude.ai Figma': { timestamp: 100, id: 'x' }, 'plugin:bio-research:wiley': { timestamp: 300 } });
eq([...parseNeedsAuth(authText)], [['claude.ai Figma', 100], ['plugin:bio-research:wiley', 300]], 'auth cache names + times');
eq([...parseNeedsAuth('')], [], 'no auth cache');
eq([...parseNeedsAuth('{"a": 4')], [], 'half-written auth cache');
eq(newAuthNames(null, parseNeedsAuth(authText)), [], 'first read: no alert');
eq(newAuthNames(new Map([['claude.ai Figma', 100]]), parseNeedsAuth(authText)), ['plugin:bio-research:wiley'], 'newly needs login');
const mcpOut = [
    'Checking MCP server health…', '',
    'claude.ai Figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication',
    'plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected',
    'plugin:bio-research:benchling: https://x (HTTP) - - Not configured',
    'gestor: https://gestor.example/mcp (HTTP) - ✘ Failed to connect — Dynamic Client Registration rejected (HTTP 404): {',
    'odd: sh -c "a - b" - ✔ Connected',
    'waiting: https://y - ⏸ Pending approval',
    'bash: cannot set terminal process group (1): Inappropriate ioctl for device',
    'bash: no job control in this shell', '',
].join('\n');
eq(parseMcpList(mcpOut), [
    { name: 'claude.ai Figma', status: 'auth', detail: '' },
    { name: 'plugin:playwright:playwright', status: 'ok', detail: '' },
    { name: 'plugin:bio-research:benchling', status: 'off', detail: '' },
    { name: 'gestor', status: 'failed', detail: 'Dynamic Client Registration rejected (HTTP 404): {' },
    { name: 'odd', status: 'ok', detail: '' },
    { name: 'waiting', status: 'pending', detail: '' },
], 'claude mcp list parsed (plugin names with ":", " - " in a target, shell noise)');
eq(parseMcpList('Checking MCP server health…\n\nNo MCP servers configured.\n'), [], 'no servers');
let check = { at: 200, servers: parseMcpList(mcpOut) };
let sum = mcpSummary(parseNeedsAuth(authText), check);
eq(sum.problems.map(p => [p.name, p.status]), [['gestor', 'failed'], ['claude.ai Figma', 'auth'],
    ['plugin:bio-research:wiley', 'auth'], ['waiting', 'pending']], 'problems: failed, then login, then pending');
eq([sum.ok, sum.off], [2, 1], 'connected / not configured counts');
eq(mcpSummary(new Map([['odd', 100]]), check).problems.some(p => p.name === 'odd'), false, 'cache older than a passing check: ok');
eq(mcpSummary(new Map([['odd', 300]]), check).problems.find(p => p.name === 'odd')?.status, 'auth', 'cache newer than the check: needs login');
eq(mcpSummary(parseNeedsAuth(authText), null), { problems: [{ name: 'claude.ai Figma', status: 'auth', detail: '' },
    { name: 'plugin:bio-research:wiley', status: 'auth', detail: '' }], ok: 0, off: 0 }, 'no check yet: cache only');

// ---- permission rules + default mode ----
const perms = { model: 'opus', permissions: { allow: ['Bash(npm test:*)', 'WebFetch(domain:x.com)'], deny: ['Read(.env)'],
    defaultMode: 'auto' } };
eq(rulesOf(perms), [{ kind: 'deny', rule: 'Read(.env)' }, { kind: 'allow', rule: 'Bash(npm test:*)' },
    { kind: 'allow', rule: 'WebFetch(domain:x.com)' }], 'rules: deny, ask, allow order');
eq(rulesOf({}), [], 'no permissions');
eq(rulesOf({ permissions: { allow: 'x', ask: [3, 'Edit'] } }), [{ kind: 'ask', rule: 'Edit' }], 'junk skipped');
for (let raw of ['{\n  "permissions": {\n    "allow": [\n      "A",\n      "B"\n    ]\n  }\n}\n',
    '{\n    "permissions": {\n        "allow": [\n            "A",\n            "B"\n        ]\n    }\n}\n']) {
    let lay = settingsLayout(raw);
    eq(formatSettings(removeRule(JSON.parse(raw), 'allow', 'A'), lay), raw.replace(/\n +"A",/, ''), `remove a rule, layout kept (${lay.indent.length} spaces)`);
}
eq(removeRule(perms, 'allow', 'gone'), perms, 'removing a missing rule changes nothing');
eq(removeRule({ permissions: { deny: ['X'] } }, 'deny', 'X'), { permissions: { deny: [] } }, 'last rule: empty list kept');
eq(SAFE_MODES, ['default', 'acceptEdits', 'plan', 'auto'], 'safe modes');
eq(setDefaultMode(perms, 'plan').permissions, { ...perms.permissions, defaultMode: 'plan' }, 'set mode');
eq(setDefaultMode({ model: 'x' }, 'acceptEdits'), { model: 'x', permissions: { defaultMode: 'acceptEdits' } }, 'set mode without permissions');
for (let bad of ['bypassPermissions', 'dontAsk', 'manual', '', undefined]) {
    let threw = false;
    try { setDefaultMode(perms, bad); } catch (e) { threw = true; }
    ok(threw, `unsafe mode refused: ${bad}`);
}
eq(claudeSettingsFiles(['/p/a', '/p/b', '/p/a']).map(f => [f.path, f.scope, f.label]), [
    [SETTINGS_PATH, 'user', 'You · ~/.claude/settings.json'],
    ['/p/a/.claude/settings.json', 'project', 'a · .claude/settings.json'],
    ['/p/a/.claude/settings.local.json', 'local', 'a · .claude/settings.local.json'],
    ['/p/b/.claude/settings.json', 'project', 'b · .claude/settings.json'],
    ['/p/b/.claude/settings.local.json', 'local', 'b · .claude/settings.local.json'],
], 'settings files: user + each live folder once');

// ---- settings IO, async, on scratch files ----
function settle(promise) {
    let loop = new GLib.MainLoop(null, false), out, err;
    promise.then(v => { out = v; loop.quit(); }, e => { err = e; loop.quit(); });
    loop.run();
    if (err)
        throw err;
    return out;
}
let io = GLib.dir_make_tmp('nn-io-XXXXXX');
const ioRead = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
let missing = settle(readSettingsAsync(`${io}/none.json`));
eq([missing.settings, missing.layout, missing.error], [{}, { indent: '  ', eol: '\n' }, undefined], 'missing file → {}');
GLib.file_set_contents(`${io}/bad.json`, '{"a": ');
ok(!!settle(readSettingsAsync(`${io}/bad.json`)).error, 'unparsable → error');
GLib.file_set_contents(`${io}/arr.json`, '[1]');
ok(!!settle(readSettingsAsync(`${io}/arr.json`)).error, 'not an object → error');
const four = '{\n    "permissions": {\n        "allow": [\n            "A"\n        ]\n    }\n}\n';
GLib.file_set_contents(`${io}/real.json`, four);
GLib.spawn_command_line_sync(`ln -s real.json ${GLib.shell_quote(`${io}/link.json`)}`);
let r = settle(readSettingsAsync(`${io}/link.json`));
eq([r.path, r.settings.permissions.allow], [`${io}/real.json`, ['A']], 'symlink followed');
settle(writeSettingsAsync(r.path, removeRule(r.settings, 'allow', 'A'), r.layout));
eq(ioRead(`${io}/real.json`), four.replace('\n            "A"\n        ', ''), 'written in its own layout');
eq(ioRead(`${io}/real.json~`), four, 'previous file kept as backup');
ok(GLib.file_test(`${io}/link.json`, GLib.FileTest.IS_SYMLINK), 'symlink still a symlink');
settle(writeSettingsAsync(`${io}/new/.claude/settings.json`, { a: 1 }, missing.layout));
eq(ioRead(`${io}/new/.claude/settings.json`), '{\n  "a": 1\n}\n', 'creates the folder for a new file');
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(io)}`);

// ---- config: approvals on/off (read-only checks; never saves) ----
const cfg = obj => new ConfigStore({ contents: new TextEncoder().encode(JSON.stringify(obj)) });
eq(cfg({}).claudeApprove, false, 'approvals off by default');
eq(cfg({ claudeApprove: true }).claudeApprove, true, 'approvals on');

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

// ---- run the approve hook command for real, against a scratch socket ----
const sockPath = `${home}/nn.sock`;
function runHook(input) {
    let proc = Gio.Subprocess.new(['sh', '-c', approveCommand(sockPath)], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    let loop = new GLib.MainLoop(null, false), result;
    proc.communicate_utf8_async(input, null, (p, res) => {
        result = [p.communicate_utf8_finish(res)[1], p.get_exit_status()];
        loop.quit();
    });
    loop.run();
    return result;
}
eq(runHook('{"x":1}'), ['', 0], 'nothing listening → no output, exit 0 (no decision, never a block)');
let seen = null;
const server = new Soup.Server();
server.add_handler('/claude/permission', (srv, msg) => {
    seen = [msg.get_method(), new TextDecoder().decode(msg.get_request_body().flatten().get_data())];
    msg.set_status(200, null);
    msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(decisionBody('allow')));
});
server.listen(Gio.UnixSocketAddress.new(sockPath), 0);
let hookIn = JSON.stringify(req('Bash', { command: "echo 'it''s' \"$HOME\"" }));
eq(runHook(hookIn), [decisionBody('allow'), 0], 'hook prints the server decision');
eq(seen, ['POST', hookIn], 'server got the hook input verbatim');
server.disconnect();
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);

print(`claude-check: ${n} checks passed`);
