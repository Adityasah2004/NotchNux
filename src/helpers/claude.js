// Claude Code monitor — the pure logic behind the Claude tab and the pill's
// session dots. No actors here, so tests/claude-check.js can run it under
// plain `gjs -m`.
//
// Two sources, both local files:
//   - ~/.claude/sessions/<pid>.json — Claude Code keeps one per live session
//     and rewrites it the moment its status changes. The format isn't
//     documented; the documented equivalent is `claude agents --json` (same
//     status values), the fallback if this file ever changes shape.
//   - ~/.cache/notchnux/claude-usage.json — Claude Code's status-line input,
//     saved by the wrapper below. Its `rate_limits` carries the 5-hour and
//     weekly usage (Claude Code 2.1.80+, Pro/Max plans).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HOME = GLib.get_home_dir();
// gnome-shell never sees a shell-rc $CLAUDE_CONFIG_DIR, so the default it is.
export const CLAUDE_DIR = `${HOME}/.claude`;
export const SESSIONS_DIR = `${CLAUDE_DIR}/sessions`;
export const SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;
// Servers waiting for a login, kept by Claude Code itself (refreshed by
// `claude mcp list` and by sessions as they connect).
export const MCP_AUTH_PATH = `${CLAUDE_DIR}/mcp-needs-auth-cache.json`;
// Admin policy, read-only. ponytail: the managed-settings.d drop-ins aren't
// read; add them if a policy there is ever missed.
export const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json';
// Hard-coded rather than $XDG_CACHE_HOME: Claude Code (started from a
// terminal) and gnome-shell can see different environments.
export const USAGE_PATH = `${HOME}/.cache/notchnux/claude-usage.json`;

export const SESSION_FILE = /^\d+\.json$/;

// `waitingFor` values that mean "approve something"; any other wait is a
// question / dialog that needs an answer.
const APPROVAL = new Set(['permission prompt', 'sandbox request', 'worker request']);

// One session file → { pid, procStart, name, folder, state, since, startedAt },
// or null if it isn't valid JSON (caught mid-write) or isn't a user session.
// state: 'working' | 'approval' | 'question' | 'done'.
export function parseSession(text) {
    let s;
    try {
        s = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!s || !Number.isInteger(s.pid) || String(s.kind).startsWith('daemon'))
        return null;
    let state = 'working';   // busy, shell (background task running), or anything new
    if (s.status === 'idle')
        state = 'done';
    else if (s.status === 'waiting')
        state = APPROVAL.has(s.waitingFor) ? 'approval' : 'question';
    let folder = s.cwd ? GLib.path_get_basename(s.cwd) : '';
    return {
        pid: s.pid,
        sessionId: typeof s.sessionId === 'string' ? s.sessionId : '',
        procStart: s.procStart == null ? '' : String(s.procStart),
        name: s.name || folder || `Session ${s.pid}`,
        folder,
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        state,
        since: s.statusUpdatedAt ?? s.updatedAt ?? 0,
        startedAt: s.startedAt ?? 0,
    };
}

// /proc/<pid>/stat → { ppid, start }. The command name sits in parentheses
// and may contain spaces, so count fields from the last ')'.
export function procStat(text) {
    let f = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { ppid: parseInt(f[1]), start: f[19] };   // fields 4 and 22
}

// A session file whose pid died (crash, kill -9) stays behind; a reused pid
// has a different start time.
export function isLive(session, statText) {
    if (!statText)
        return false;
    return !session.procStart || procStat(statText).start === session.procStart;
}

const ALERT_VALUE = { approval: 'needs approval', question: 'has a question', done: 'finished' };

// What a status change deserves in the pill, or null. Never on first sight
// (no alerts for sessions found already waiting at login). A wait always
// alerts when it's new — even straight from 'done', in case the short
// 'working' step between them was missed — and 'finished' only after work.
export function alertFor(prev, next) {
    if (!prev || prev.state === next.state)
        return null;
    if (next.state === 'done' && prev.state !== 'working')
        return null;
    let value = ALERT_VALUE[next.state];
    return value ? { state: next.state, title: next.name, value } : null;
}

// Status-line JSON → { fiveHour, weekly }, each { pct, resetsAt (ms) } or
// null; null overall if there's no rate_limits. A window past its reset time
// reads 0% (the old number is stale; the next reset isn't known yet).
export function parseUsage(text, nowMs = Date.now()) {
    let rl;
    try {
        rl = JSON.parse(text)?.rate_limits;
    } catch (e) {
        return null;
    }
    if (!rl)
        return null;
    let win = w => {
        if (typeof w?.used_percentage !== 'number')
            return null;
        let resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : null;
        if (resetsAt !== null && resetsAt <= nowMs)
            return { pct: 0, resetsAt: null };
        return { pct: Math.max(0, Math.min(100, w.used_percentage)), resetsAt };
    };
    return { fiveHour: win(rl.five_hour), weekly: win(rl.seven_day) };
}

const RANK = { approval: 0, question: 0, working: 1, done: 2 };

// Tab order: whatever needs you first, then working, then done; newest first.
export function sortSessions(list) {
    return [...list].sort((a, b) => RANK[a.state] - RANK[b.state] || b.since - a.since);
}

// Pill dot colour class for a session. `unseen` holds pids that finished
// since the Claude tab was last opened.
export function dotKind(session, unseen) {
    if (session.state === 'working')
        return 'working';
    if (session.state === 'done')
        return unseen.has(session.pid) ? 'fresh' : 'done';
    return 'waiting';
}

export const MAX_PILL_DOTS = 4;

// What the pill draws: [{ kind, count }]. Up to MAX_PILL_DOTS sessions get a
// dot each (count 0), in start order so dots don't jump around; more than
// that collapse to one dot per kind with a count.
export function pillDots(list, unseen) {
    let kinds = [...list].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
        .map(s => dotKind(s, unseen));
    if (kinds.length <= MAX_PILL_DOTS)
        return kinds.map(kind => ({ kind, count: 0 }));
    return ['waiting', 'working', 'fresh', 'done']
        .map(kind => ({ kind, count: kinds.filter(k => k === kind).length }))
        .filter(d => d.count > 0);
}

// "now", "4m", "2h 5m".
export function fmtAge(ms) {
    let m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 1)
        return 'now';
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---- Status-line wiring (used by Preferences) ----
//
// Connecting puts this inline script in front of the user's own status line
// command. It saves the status-line JSON when it carries rate_limits (atomic
// write, safe with many sessions), then pipes the same input to the original
// command, so its output is unchanged. Inline rather than a shipped script so
// uninstalling NotchNux without disconnecting can't break the status line.
const MARKER = 'notchnux-claude';
export const WRAPPER = String.raw`in=$(cat); case $in in *'"rate_limits"'*) d=$HOME/.cache/notchnux; mkdir -p "$d" && printf %s "$in" >"$d/claude-usage.json.$$" && mv -f "$d/claude-usage.json.$$" "$d/claude-usage.json";; esac; if [ -n "$1" ]; then printf %s "$in" | sh -c "$1"; fi`;

export function wrapCommand(original) {
    return `sh -c ${GLib.shell_quote(WRAPPER)} ${MARKER} ${GLib.shell_quote(original ?? '')}`;
}

// The original command inside one of our wrapped commands, or null if
// `command` isn't ours.
export function unwrapCommand(command) {
    if (typeof command !== 'string')
        return null;
    try {
        let [, argv] = GLib.shell_parse_argv(command);
        if (argv.length === 5 && argv[0] === 'sh' && argv[1] === '-c' && argv[3] === MARKER)
            return argv[4];
    } catch (e) {
        // not a parsable command line: not ours
    }
    return null;
}

export function isConnected(settings) {
    return unwrapCommand(settings?.statusLine?.command) !== null;
}

// Return new settings with the wrapper in place. Keeps every other key (and
// the statusLine's own position, so Disconnect restores the file exactly).
export function connectStatusLine(settings) {
    if (isConnected(settings))
        return settings;
    let sl = settings.statusLine;
    let original = sl?.type === 'command' && typeof sl.command === 'string' ? sl.command : '';
    return { ...settings, statusLine: { ...(sl ?? {}), type: 'command', command: wrapCommand(original) } };
}

export function disconnectStatusLine(settings) {
    let original = unwrapCommand(settings?.statusLine?.command);
    if (original === null)
        return settings;
    let out = { ...settings };
    if (original)
        out.statusLine = { ...settings.statusLine, command: original };
    else
        delete out.statusLine;
    return out;
}

// ---- Approve from the notch ----
//
// Claude Code's PermissionRequest hook runs alongside the terminal's
// permission dialog: whichever answers first wins. Preferences adds a hook
// command that hands the request to a tiny server the shell runs on a socket
// in the user's runtime folder (tabs/claude.js), which holds it until a banner
// button is clicked. No answer (nothing listening, `{}`) leaves the terminal
// dialog in charge.
//
// A socket in $XDG_RUNTIME_DIR (0700) rather than a localhost port: only this
// user's own processes can reach it, so while NotchNux is off (screen lock,
// disabled) nothing else — another user, a container, a sandboxed app — can
// take its place and approve prompts.
export const APPROVE_PATH = '/claude/permission';
export const SOCKET_NAME = 'notchnux-claude.sock';
export const approveSocketPath = () => `${GLib.get_user_runtime_dir()}/${SOCKET_NAME}`;
// How long Claude Code waits for the hook (and curl for the shell).
export const HOOK_TIMEOUT_S = 600;

// curl reads the hook input on stdin and prints the decision. `|| true`: a
// failure (NotchNux off, curl missing, a 4xx) must exit 0 with no output —
// no decision — because exit code 2 from a hook means deny.
export function approveCommand(socketPath) {
    return `curl -sf --max-time ${HOOK_TIMEOUT_S} --unix-socket ${GLib.shell_quote(socketPath)} ` +
        `-H 'Content-Type: application/json' --data-binary @- http://notchnux${APPROVE_PATH} || true`;
}

// Answered at once with no decision, so only the terminal handles them:
// inside a subagent Claude Code waits for the hook *before* showing its
// dialog (holding it would hide the prompt); plan approval and questions
// need more than allow/deny.
const TERMINAL_ONLY = new Set(['ExitPlanMode', 'AskUserQuestion']);
export function passThrough(req) {
    let tool = String(req?.tool_name ?? '');
    return !!req?.agent_id || TERMINAL_ONLY.has(tool) || tool.startsWith('dialog');
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BODY_LINES = 4;
const BODY_CHARS = 240;

// Invisible or reordering characters (controls, bidi overrides) would make
// the banner read differently from what gets approved: shown as a marker.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

// → { body, exact }: exact when the banner shows the whole text as is.
function clip(text) {
    let masked = text.replace(HIDDEN, '\uFFFD');
    let out = masked.split('\n').slice(0, BODY_LINES).join('\n').slice(0, BODY_CHARS);
    return { body: out === masked ? out : `${out.trimEnd()}…`, exact: out === text };
}

const base = p => (typeof p === 'string' && p ? GLib.path_get_basename(p) : '');

// Per tool, the input keys the banner shows or that don't change what runs.
// Anything else (dangerouslyDisableSandbox, …) makes the request not exact.
const SHOWN_KEYS = {
    Bash: ['command', 'description', 'timeout', 'run_in_background'],
    Read: ['file_path', 'offset', 'limit'],
    WebFetch: ['url', 'prompt'],
};

// "Always allow" only when every suggestion is a plain allow rule for this
// tool, shown as text (e.g. "Bash(npm test:*)"); anything else (a mode
// switch, directories, another tool) isn't offered from the notch.
function alwaysRules(req, tool) {
    let sugg = req?.permission_suggestions;
    if (!Array.isArray(sugg) || !sugg.length)
        return null;
    let rules = [];
    for (let s of sugg) {
        if (s?.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules) || !s.rules.length)
            return null;
        for (let r of s.rules) {
            if (r?.toolName !== tool || (r.ruleContent != null && typeof r.ruleContent !== 'string'))
                return null;
            rules.push(r.ruleContent ? `${tool}(${r.ruleContent})` : tool);
        }
    }
    let text = rules.join(', ');
    return clip(text).exact ? text : null;
}

// Hook input → the banner's { title, body, exact, always }: "<session> wants
// to <action>" over the command / file / URL. `exact` is false when the
// banner can't show everything that would be allowed (cut or masked text,
// an edit's content, an unshown option) — then it offers no Allow.
// `always`: the rule "Always allow" adds, or null. Never logged.
export function describeRequest(req, name = '') {
    let tool = String(req?.tool_name ?? '');
    let input = req?.tool_input && typeof req.tool_input === 'object' ? req.tool_input : {};
    let action, body, m;
    if (tool === 'Bash') {
        [action, body] = ['run a command', input.command];
    } else if (EDIT_TOOLS.has(tool)) {
        body = input.file_path ?? input.notebook_path;
        action = `edit ${base(body)}`;
    } else if (tool === 'Read') {
        [action, body] = [`read ${base(input.file_path)}`, input.file_path];
    } else if (tool === 'WebFetch') {
        let host = '';
        try {
            host = GLib.Uri.parse(String(input.url), GLib.UriFlags.NONE).get_host() ?? '';
        } catch (e) {
            // not a URL: show it as is
        }
        [action, body] = [`fetch ${host || 'a page'}`, input.url];
    } else if ((m = /^mcp__(.+?)__(.+)$/.exec(tool))) {
        [action, body] = [`use ${m[1]} · ${m[2]}`, JSON.stringify(input)];
    } else {
        [action, body] = [`use ${tool || 'a tool'}`, JSON.stringify(input)];
    }
    let who = name || base(req?.cwd) || 'Claude Code';
    let shown = clip(typeof body === 'string' ? body : '');
    let keysShown = !(tool in SHOWN_KEYS) || Object.keys(input).every(k => SHOWN_KEYS[tool].includes(k));
    let exact = shown.exact && keysShown && !EDIT_TOOLS.has(tool);
    return { title: `${who} wants to ${action}`, body: shown.body, exact, always: exact ? alwaysRules(req, tool) : null };
}

// The hook's HTTP response body for 'allow' | 'always' | 'deny' | 'none'.
// "Always allow" sends Claude Code's own suggestions back unchanged, so the
// rule lands where the terminal's option 2 would put it.
export function decisionBody(kind, req) {
    if (kind === 'none')
        return '{}';
    let decision = kind === 'deny'
        ? { behavior: 'deny', message: 'Denied from NotchNux' }
        : { behavior: 'allow' };
    if (kind === 'always' && Array.isArray(req?.permission_suggestions) && req.permission_suggestions.length)
        decision.updatedPermissions = req.permission_suggestions;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

// ---- Hook wiring (used by Preferences), same contract as the status line:
// pure settings in → settings out, other hooks untouched, Disconnect
// restores the file exactly.
const isOurHook = h => h?.type === 'command' && typeof h.command === 'string' && h.command.includes(SOCKET_NAME);

export function isApproveConnected(settings) {
    let list = settings?.hooks?.PermissionRequest;
    return Array.isArray(list) && list.some(m => Array.isArray(m?.hooks) && m.hooks.some(isOurHook));
}

export function disconnectApproveHook(settings) {
    if (!isApproveConnected(settings))
        return settings;
    // Only groups holding our hook change; anything else stays as it was.
    let kept = [];
    for (let m of settings.hooks.PermissionRequest) {
        if (!Array.isArray(m?.hooks) || !m.hooks.some(isOurHook)) {
            kept.push(m);
            continue;
        }
        let rest = m.hooks.filter(h => !isOurHook(h));
        if (rest.length)
            kept.push({ ...m, hooks: rest });
    }
    // ponytail: a `hooks: {}` / `PermissionRequest: []` that was already
    // empty before Connect goes too — same meaning to Claude Code.
    let hooks = { ...settings.hooks };
    if (kept.length)
        hooks.PermissionRequest = kept;
    else
        delete hooks.PermissionRequest;
    let out = { ...settings };
    if (Object.keys(hooks).length)
        out.hooks = hooks;
    else
        delete out.hooks;
    return out;
}

// Connecting again replaces our entry (keeps the socket path current).
export function connectApproveHook(settings, socketPath = approveSocketPath()) {
    let s = disconnectApproveHook(settings);
    let hooks = s.hooks ?? {};
    let list = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
    let entry = { hooks: [{ type: 'command', command: approveCommand(socketPath), timeout: HOOK_TIMEOUT_S }] };
    return { ...s, hooks: { ...hooks, PermissionRequest: [...list, entry] } };
}

// How a settings file is laid out, so a rewrite changes only what we
// changed: the first indented line's indent ('' for one-line JSON), its
// line ending (CRLF stays CRLF), a trailing newline, a byte-order mark.
// No file yet → Claude Code's own layout.
export function settingsLayout(text) {
    if (typeof text !== 'string')
        return { indent: '  ', eol: '\n', nl: '\n', bom: '' };
    let nl = text.includes('\r\n') ? '\r\n' : '\n';
    let m = /\n([ \t]+)\S/.exec(text);
    return { indent: m ? m[1] : '', eol: text.endsWith('\n') ? nl : '', nl, bom: text.startsWith('\uFEFF') ? '\uFEFF' : '' };
}

export function formatSettings(settings, { indent, eol, nl = '\n', bom = '' }) {
    // JSON strings can't hold a raw newline, so this only touches layout.
    let json = JSON.stringify(settings, null, indent);
    return bom + (nl === '\n' ? json : json.replace(/\n/g, nl)) + eol;
}

// A settings file's text → its object. A BOM is skipped and an empty file
// means {}; anything that isn't a JSON object throws.
export function parseSettings(text) {
    let body = text.replace(/^\uFEFF/, '');
    let settings = body.trim() ? JSON.parse(body) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('not a JSON object');
    return settings;
}

// ---- MCP health ----

// The auth cache → Map(server name → when it was found needing a login,
// ms); empty when there's no file, null when it was caught mid-write (keep
// the last one, or every name would look new).
export function parseNeedsAuth(text) {
    let out = new Map();
    if (!text)
        return out;
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return null;
    }
    for (let [name, v] of Object.entries(data && typeof data === 'object' ? data : {}))
        out.set(name, typeof v?.timestamp === 'number' ? v.timestamp : 0);
    return out;
}

// Servers that started needing a login since the last read. Nothing on the
// first read, like session alerts.
export function newAuthNames(prev, next) {
    return prev ? [...next.keys()].filter(n => !prev.has(n)) : [];
}

const MCP_STATUS = { '✔': 'ok', '!': 'auth', '✘': 'failed', '⏸': 'pending', '-': 'off' };

// What a "Check now" run gives: { servers } to show, or { error }. A run
// that timed out printed only the servers it got to, so it's not a check;
// a non-zero exit with server lines still is (failing servers may cause it).
export function mcpCheckOutcome(out, err, timedOut) {
    if (timedOut)
        return { error: `${err}, so some servers weren\u2019t checked` };
    let servers = parseMcpList(out ?? '');
    if (servers.length || /No MCP servers/.test(out ?? ''))
        return { servers };
    return { error: err ?? 'claude mcp list printed nothing' };
}

// `claude mcp list` text (it has no --json) → [{ name, target, status,
// detail }]. "name: target - <glyph> text": names can hold ':'
// (plugin:x:y) but not ': '; the status is the glyph after the last " - ".
// Other lines (the header, shell noise) are skipped.
export function parseMcpList(text) {
    let out = [];
    for (let line of String(text).split('\n')) {
        let m = /^(.+?): (.*) - ([✔!✘⏸-]) (.*)$/.exec(line.trimEnd());
        if (!m)
            continue;
        let status = MCP_STATUS[m[3]];
        let detail = status === 'failed' ? m[4].replace(/^Failed to connect\s*(?:—\s*)?/, '') : '';
        out.push({ name: m[1], target: m[2], status, detail });
    }
    return out;
}

const PROBLEM_RANK = { failed: 0, auth: 1, pending: 2 };
const byName = (a, b) => a.name.localeCompare(b.name);

// What the MCP view shows: problems first (failed, needs /mcp, pending),
// then the connected servers, then how many aren't configured. The auth
// cache wins over a check older than its entry. Claude Code keeps servers
// that just failed in that cache too, so an entry means "needs /mcp", not
// always a login.
export function mcpSummary(auth, check) {
    let all = new Map((check?.servers ?? []).map(s => [s.name, s]));
    for (let [name, at] of auth) {
        let s = all.get(name);
        if (!s || (s.status !== 'auth' && at > (check?.at ?? 0)))
            all.set(name, { name, target: s?.target ?? '', status: 'auth', detail: '' });
    }
    let list = [...all.values()];
    return {
        problems: list.filter(s => s.status in PROBLEM_RANK)
            .sort((a, b) => PROBLEM_RANK[a.status] - PROBLEM_RANK[b.status] || byName(a, b)),
        ok: list.filter(s => s.status === 'ok').sort(byName),
        off: list.filter(s => s.status === 'off').length,
    };
}

// The claude binary, or null. gnome-shell's PATH may lack ~/.local/bin.
export function claudeBinary() {
    let local = `${HOME}/.local/bin/claude`;
    return GLib.find_program_in_path('claude') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// ---- Permission rules + default mode ----

const RULE_KINDS = ['deny', 'ask', 'allow'];   // the order Claude Code checks them

export function rulesOf(settings) {
    let p = settings?.permissions;
    let out = [];
    for (let kind of RULE_KINDS) {
        for (let rule of Array.isArray(p?.[kind]) ? p[kind] : []) {
            if (typeof rule === 'string')
                out.push({ kind, rule });
        }
    }
    return out;
}

// Removes that one rule; an emptied list stays (an empty list means the same).
export function removeRule(settings, kind, rule) {
    let list = settings?.permissions?.[kind];
    let i = Array.isArray(list) ? list.indexOf(rule) : -1;
    if (i < 0)
        return settings;
    return { ...settings, permissions: { ...settings.permissions, [kind]: list.filter((_, j) => j !== i) } };
}

// What the notch may switch new sessions to. Never bypassPermissions or
// dontAsk: one stray click shouldn't turn every prompt off.
export const SAFE_MODES = ['default', 'acceptEdits', 'plan', 'auto'];

export function setDefaultMode(settings, mode) {
    if (!SAFE_MODES.includes(mode))
        throw new Error(`not offered from the notch: ${mode}`);
    return { ...settings, permissions: { ...(settings.permissions ?? {}), defaultMode: mode } };
}

// ---- Remote Control for new sessions ----
// A running session can only start Remote Control itself (/rc); this key
// makes every new session start with it. Only the user's file (or policy)
// can turn it on: project and local files can only turn it off.

export const remoteAtStartup = settings => settings?.remoteControlAtStartup === true;

// On sets the key; off removes it, so on → off restores the file exactly.
// ponytail: an explicit `false` that was there before comes back as absent
// (same meaning).
export function setRemoteAtStartup(settings, on) {
    if (on)
        return { ...settings, remoteControlAtStartup: true };
    if (!('remoteControlAtStartup' in settings))
        return settings;
    let out = { ...settings };
    delete out.remoteControlAtStartup;
    return out;
}

// ---- Editors that can open Claude Code's files ----
// [label, desktop ids]: the first id that's installed wins.
export const EDITORS = [
    ['VS Code', ['com.microsoft.VSCode.desktop', 'code.desktop', 'code_code.desktop']],
    ['Cursor', ['cursor.desktop', 'cursor_cursor.desktop']],
    ['Antigravity', ['antigravity.desktop']],
];

// → [{ name, id, app }] for the editors on this computer. `lookup(id)` →
// a Gio.AppInfo or null: the shell asks its own app list (no file reads),
// Preferences GioUnix.DesktopAppInfo.
export function installedEditors(lookup) {
    let out = [];
    for (let [name, ids] of EDITORS) {
        for (let id of ids) {
            let app = lookup(id);
            if (app) {
                out.push({ name, id, app });
                break;
            }
        }
    }
    return out;
}

// The editor picked in Preferences, or the first one installed, or null.
export function editorApp(preferredId, lookup) {
    let all = installedEditors(lookup);
    return (all.find(e => e.id === preferredId) ?? all[0])?.app ?? null;
}

// The files the Rules and Skills views cover: the user's, plus project and
// local settings of every folder a live session runs in.
export function claudeSettingsFiles(cwds) {
    let files = [{ path: SETTINGS_PATH, scope: 'user', label: 'You · ~/.claude/settings.json' }];
    for (let cwd of new Set(cwds)) {
        if (!cwd)
            continue;
        let folder = GLib.path_get_basename(cwd);
        for (let [scope, name] of [['project', 'settings.json'], ['local', 'settings.local.json']]) {
            let path = `${cwd}/.claude/${name}`;
            if (!files.some(f => f.path === path))   // a session in ~ shares the user file
                files.push({ path, scope, label: `${folder} · .claude/${name}` });
        }
    }
    return files;
}

// ---- Settings IO for the shell (async; Preferences has its own sync pair) ----

// → { path, settings, layout } or { path, error }. A symlinked file is
// followed so writes land on the real file; a missing one reads as {}.
// Anything that isn't a JSON object is an error and is never written.
// All async: a session folder can sit on a network mount.
export function readSettingsAsync(path, cancellable = null) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('standard::is-symlink,standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable, (link, linkRes) => {
                try {
                    let info = link.query_info_finish(linkRes);
                    if (info.get_is_symlink())
                        path = GLib.canonicalize_filename(info.get_symlink_target(), GLib.path_get_dirname(path));
                } catch (e) {
                    // missing: the read below says so
                }
                loadSettings(path, cancellable, resolve);
            });
    });
}

function loadSettings(path, cancellable, resolve) {
    {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (f, res) => {
            try {
                let [, bytes] = f.load_contents_finish(res);
                let text = new TextDecoder().decode(bytes);
                resolve({ path, settings: parseSettings(text), layout: settingsLayout(text) });
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    resolve({ path, settings: {}, layout: settingsLayout(null) });
                else
                    resolve({ path, error: `Can’t read ${path} (${e.message})` });
            }
        });
    }
}

// In the file's own layout. `backup` keeps the old file as <name>~ — only
// for ~/.claude/settings.json: in a project it would sit untracked in the
// repo. Never creates folders (every file these views write sits in a
// folder that exists). ponytail: read-modify-write without a lock — Claude
// Code seldom writes these files; lock if a lost edit ever shows up.
export function writeSettingsAsync(path, settings, layout, { backup = false } = {}) {
    let bytes = new GLib.Bytes(new TextEncoder().encode(formatSettings(settings, layout)));
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, backup, Gio.FileCreateFlags.NONE, null,
            (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// ---- Plugins & skills ----

// `claude plugin list --json` → [{ id, name, marketplace, enabled, scope,
// version }] by name, or null if it isn't the expected list.
export function parsePluginList(text) {
    let list;
    try {
        list = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!Array.isArray(list))
        return null;
    return list.filter(p => typeof p?.id === 'string').map(p => {
        let [name, marketplace = ''] = p.id.split('@');
        return { id: p.id, name, marketplace, enabled: !!p.enabled, scope: p.scope || 'user', version: p.version || '' };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

const unquote = v => v.replace(/^(["'])(.*)\1$/, '$2');

// SKILL.md frontmatter → { name, description }. Only what the list shows:
// plain, quoted and folded (> |) values.
export function parseSkillMeta(text) {
    let out = { name: '', description: '' };
    let m = /^---\n([\s\S]*?)\n---/.exec(String(text).replace(/\r\n/g, '\n'));
    if (!m)
        return out;
    let lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
        let kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
        if (!kv)
            continue;
        let value = kv[2].trim();
        if (/^[>|][-+]?$/.test(value)) {
            let more = [];
            while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]))
                more.push(lines[++i].trim());
            value = more.join(' ');
        }
        out[kv[1]] = unquote(value);
    }
    return out;
}

export const skillOverride = (settings, name) => settings?.skillOverrides?.[name] ?? 'on';

// Which setting decides a skill in one folder, in Claude Code's order:
// admin policy, then the folder's settings.local.json, its settings.json,
// then the user's. → { state, scope } (scope null: nobody set it, so on).
const SKILL_ORDER = ['policy', 'local', 'project', 'user'];
export function effectiveSkill(name, files) {
    for (let scope of SKILL_ORDER) {
        let v = files[scope]?.skillOverrides?.[name];
        if (typeof v === 'string')
            return { state: v, scope };
    }
    return { state: 'on', scope: null };
}

// The edit that turns a skill on or off in one file, given what the files
// below it say (`lower`): off writes "off"; on removes the override (exact
// restore) unless something below has it off, then it writes "on".
export function skillEdit(name, on, lower = 'on') {
    if (!on || lower !== 'off')
        return s => setSkillOverride(s, name, on);
    return s => ({ ...s, skillOverrides: { ...(s.skillOverrides ?? {}), [name]: 'on' } });
}

// Off → `skillOverrides[name] = 'off'`; on → the override goes (and the
// whole key when it empties), so off → on restores the file exactly.
// ponytail: a "name-only" override turned off and on comes back as plain on.
export function setSkillOverride(settings, name, on) {
    let cur = settings.skillOverrides && typeof settings.skillOverrides === 'object' ? settings.skillOverrides : {};
    if (!on)
        return { ...settings, skillOverrides: { ...cur, [name]: 'off' } };
    if (!(name in cur))
        return settings;
    let rest = { ...cur };
    delete rest[name];
    let out = { ...settings, skillOverrides: rest };
    if (!Object.keys(rest).length)
        delete out.skillOverrides;
    return out;
}

// Where skills live: personal ones (they follow the user's settings), then
// each other live folder's own (its settings.local.json, not committed). A
// session in ~ adds nothing: its .claude/skills is the personal folder.
export function skillSources(cwds) {
    let out = [{ dir: `${CLAUDE_DIR}/skills`, settings: SETTINGS_PATH, where: '', cwd: '' }];
    for (let cwd of new Set(cwds)) {
        if (!cwd || cwd === HOME)
            continue;
        out.push({ dir: `${cwd}/.claude/skills`, settings: `${cwd}/.claude/settings.local.json`,
            where: GLib.path_get_basename(cwd), cwd });
    }
    return out;
}

// /proc/<pid>/environ → ['NAME=value', …]: a live session's environment, so
// `claude mcp list` sees the same PATH and variables as in its terminal.
export function parseEnviron(text) {
    return String(text).split('\0').filter(e => e.includes('='));
}
