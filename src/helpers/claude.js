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
        procStart: s.procStart == null ? '' : String(s.procStart),
        name: s.name || folder || `Session ${s.pid}`,
        folder,
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
