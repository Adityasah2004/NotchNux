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

import GLib from 'gi://GLib';

const HOME = GLib.get_home_dir();
// gnome-shell never sees a shell-rc $CLAUDE_CONFIG_DIR, so the default it is.
export const CLAUDE_DIR = `${HOME}/.claude`;
export const SESSIONS_DIR = `${CLAUDE_DIR}/sessions`;
export const SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;
// Servers waiting for a login, kept by Claude Code itself (refreshed by
// `claude mcp list` and by sessions as they connect).
export const MCP_AUTH_PATH = `${CLAUDE_DIR}/mcp-needs-auth-cache.json`;
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
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// → { body, exact }: exact when the banner shows the whole text as is.
function clip(text) {
    let masked = text.replace(HIDDEN, '\uFFFD');
    let out = masked.split('\n').slice(0, BODY_LINES).join('\n').slice(0, BODY_CHARS);
    return { body: out === masked ? out : `${out.trimEnd()}…`, exact: out === text };
}

const base = p => (typeof p === 'string' && p ? GLib.path_get_basename(p) : '');

// Hook input → the banner's { title, body, exact }: "<session> wants to
// <action>" over the command / file / URL. `exact` is false when the body is
// cut or masked — then the banner offers no Allow. Never logged.
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
    return { title: `${who} wants to ${action}`, ...clip(typeof body === 'string' ? body : '') };
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
// changed: the first indented line's indent ('' for one-line JSON) and
// whether it ends with a newline. No file yet → Claude Code's own layout.
export function settingsLayout(text) {
    if (typeof text !== 'string')
        return { indent: '  ', eol: '\n' };
    let m = /\n([ \t]+)\S/.exec(text);
    return { indent: m ? m[1] : '', eol: text.endsWith('\n') ? '\n' : '' };
}

export function formatSettings(settings, { indent, eol }) {
    return JSON.stringify(settings, null, indent) + eol;
}

// ---- MCP health ----

// The auth cache → Map(server name → when it was found needing a login, ms).
export function parseNeedsAuth(text) {
    let out = new Map();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return out;   // missing or caught mid-write
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

// `claude mcp list` text (it has no --json) → [{ name, status, detail }].
// "name: target - <glyph> text": names can hold ':' (plugin:x:y) but not
// ': '; the status is the glyph after the last " - ". Other lines (the
// header, shell noise) are skipped.
export function parseMcpList(text) {
    let out = [];
    for (let line of String(text).split('\n')) {
        let m = /^(.+?): (.*) - ([✔!✘⏸-]) (.*)$/.exec(line.trimEnd());
        if (!m)
            continue;
        let status = MCP_STATUS[m[3]];
        let detail = status === 'failed' ? m[4].replace(/^Failed to connect\s*(?:—\s*)?/, '') : '';
        out.push({ name: m[1], status, detail });
    }
    return out;
}

const PROBLEM_RANK = { failed: 0, auth: 1, pending: 2 };

// What the MCP view shows: problems first (failed, needs login, pending),
// then counts. The auth cache wins over a check older than its entry.
export function mcpSummary(auth, check) {
    let byName = new Map((check?.servers ?? []).map(s => [s.name, s]));
    for (let [name, at] of auth) {
        let s = byName.get(name);
        if (!s || (s.status !== 'auth' && at > (check?.at ?? 0)))
            byName.set(name, { name, status: 'auth', detail: '' });
    }
    let all = [...byName.values()];
    return {
        problems: all.filter(s => s.status in PROBLEM_RANK)
            .sort((a, b) => PROBLEM_RANK[a.status] - PROBLEM_RANK[b.status] || a.name.localeCompare(b.name)),
        ok: all.filter(s => s.status === 'ok').length,
        off: all.filter(s => s.status === 'off').length,
    };
}

// The claude binary, or null. gnome-shell's PATH may lack ~/.local/bin.
export function claudeBinary() {
    let local = `${HOME}/.local/bin/claude`;
    return GLib.find_program_in_path('claude') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}
