// Claude tab + the pill's Claude Code dots.
//
//   pill:  ( ♫ Song…     Tue 3 · 2:32 PM     ● ◉ ○ 42%   🔋 87% )
//            one dot per session (working · waiting for you · finished),
//            then the 5-hour usage
//   tab:   Sessions · MCP views. Sessions: 5-hour / weekly usage bars, the
//          Remote Control for new sessions switch, then one row per live
//          session (with /rc and /rename shortcuts). MCP: servers that need
//          /mcp (from Claude Code's own cache) or failed the last "Check
//          now", then the connected ones. The header opens ~/.claude in the
//          editor picked in Preferences. Rules:
//          the default mode for new sessions, and allow / ask / deny rules
//          from the user's settings and every live session's folder.
//          Plugins: plugin on/off (the claude CLI) and skill on/off
//          (skillOverrides), personal and per live folder.
//
// Data comes from files Claude Code already writes (see helpers/claude.js).
// The sessions folder is watched, so a session asking for approval shows up
// at once; a 30 s sweep catches crashed sessions, refreshes the usage figure
// and the tab's "time in state". Nothing runs unless the `claudeMonitor`
// feature is on or the Claude tab is open.
//
// Approve from the notch: while connected, a server on a socket in the
// user's runtime folder receives Claude Code's PermissionRequest hook (see
// helpers/claude.js) and holds each
// request until a button on a sticky banner answers it, or the terminal
// answers first (seen as the session leaving its waiting state).
//
// Methods mixed into the NotchNux actor, like tabs/tray.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    SESSIONS_DIR, USAGE_PATH, SESSION_FILE, parseSession, procStat, isLive, alertFor,
    parseUsage, sortSessions, pillDots, fmtAge,
    APPROVE_PATH, HOOK_TIMEOUT_S, approveSocketPath, passThrough, asksAtOnce, describeRequest, decisionBody,
    MCP_AUTH_PATH, parseNeedsAuth, newAuthNames, parseMcpList, mcpSummary, claudeBinary,
    SAFE_MODES, rulesOf, removeRule, setDefaultMode, claudeSettingsFiles, readSettingsAsync, writeSettingsAsync,
    SETTINGS_PATH, parsePluginList, parseSkillMeta, setSkillOverride, skillSources, parseEnviron,
    mcpCheckOutcome, MANAGED_SETTINGS_PATH, effectiveSkill, skillEdit,
    CLAUDE_DIR, remoteAtStartup, setRemoteAtStartup, editorApp,
} from '../helpers/claude.js';
import { readTextAsync } from '../helpers/productivity.js';
import { fmt } from '../helpers/format.js';
import { addPressFeedback } from '../helpers/motion.js';
import { accentHex } from '../helpers/widgets.js';
import { logError } from '../helpers/log.js';
import { SYS, statColor, iconBtn } from './ledge.js';

const SWEEP_S = 30;
const DEBOUNCE_MS = 150;
const ALERT_MS = 4000;
const DONE_GREY = 'rgba(255, 255, 255, 0.35)';
const STATE_TEXT = { working: 'Working', approval: 'Needs approval', question: 'Has a question', done: 'Done' };
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
// Gone before the hook times out (a click after that would do nothing), even
// when the cut-off falls just after a sweep. Monotonic, like Claude Code's
// timer: a suspend doesn't age a request.
const REQUEST_MAX_AGE_US = (HOOK_TIMEOUT_S - SWEEP_S - 5) * 1e6;
// A click this soon after a banner (re)appears is the tail of a double-click
// meant for the one before it.
const CLICK_GUARD_US = 500 * 1000;
const CLAUDE_VIEWS = [['sessions', 'Sessions'], ['mcp', 'MCP'], ['rules', 'Rules'], ['plugins', 'Plugins']];
const OVERRIDE_TEXT = { 'name-only': 'name only', 'user-invocable-only': 'only when you ask' };
const OVERRIDE_COLOR = { on: SYS.green, off: SYS.red };
const SCOPE_TEXT = { local: 'local', project: 'project' };
const MODE_LABELS = [['default', 'Default'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan'], ['auto', 'Auto']];
const KIND_COLOR = { allow: SYS.green, ask: SYS.orange, deny: SYS.red };
const CONFIRM_MS = 3000;
// `claude mcp list` starts every server: ~20 s for 22 of them.
const MCP_CHECK_TIMEOUT_S = 90;
// Claude Code's login cache also holds servers that just failed, so "auth"
// reads as "needs /mcp" (log in or reconnect there).
const MCP_TEXT = {
    failed: ['Failed', SYS.red, ''],
    auth: ['Needs /mcp', SYS.orange, 'Log in or reconnect it with /mcp in a Claude session'],
    pending: ['Pending approval', SYS.orange, 'Approve it in a Claude session'],
    ok: ['Connected', SYS.green, ''],
};
// What the header's editor button opens next to ~/.claude, per view.
const HOME_DIR = GLib.get_home_dir();
const VIEW_FILE = { sessions: SETTINGS_PATH, rules: SETTINGS_PATH, mcp: `${HOME_DIR}/.claude.json`, plugins: null };
const lookupApp = id => Shell.AppSystem.get_default().lookup_app(id)?.get_app_info() ?? null;
const ALERT_ICON = { approval: 'dialog-warning-symbolic', question: 'dialog-question-symbolic', done: 'object-select-symbolic' };

function dotColor(kind) {
    return { working: accentHex(), waiting: SYS.orange, fresh: SYS.green, done: DONE_GREY }[kind];
}

function stateColor(state) {
    return state === 'working' ? accentHex() : state === 'done' ? DONE_GREY : SYS.orange;
}

function text(t, cls, props = {}) {
    let l = new St.Label({ text: t, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function dot(color) {
    return new St.Widget({ style_class: 'nn-claude-dot', style: `background-color: ${color};`,
        y_align: Clutter.ActorAlign.CENTER });
}

const read = (path, cancellable) => new Promise(resolve => readTextAsync(path, cancellable, resolve));

function scrolled(child) {
    let scroll = new St.ScrollView({ style_class: 'nn-claude-scroll', x_expand: true });
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    scroll.set_overlay_scrollbars(true);
    scroll.set_child(child);
    return scroll;
}

// "16:30" today, "Thu 09:00" later on.
function fmtReset(ms) {
    if (!ms)
        return 'reset';
    let d = new Date(ms);
    let time = fmt(d, { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
        ? `resets ${time}` : `resets ${fmt(d, { weekday: 'short' })} ${time}`;
}

const ClaudeFeatures = {
    // ================================================================ lifecycle

    _initClaude() {
        this._claude = {
            sessions: new Map(),   // pid → session (helpers/claude.js parseSession)
            unseen: new Set(),     // pids that finished since the tab was last opened
            usage: null,
            tabOpen: false,
            monitor: null, monitorId: 0, debounceId: 0, sweepId: 0,
            cancellable: null, seq: 0, pillSig: '',
            mcp: { auth: null, check: null, running: false, error: '' },
            // seq: newest load wins; key: the live folders a load covered.
            rules: { files: [], loaded: false, loading: false, seq: 0, key: null, error: '', armed: null },
            extras: { plugins: null, skills: [], overrides: [], loaded: false, loading: false, seq: 0, pseq: 0, key: null,
                error: '', actionError: '', note: '', busy: new Set() },
            edits: Promise.resolve(),   // settings edits run one after another
            procs: new Map(),      // running `claude` commands → { id: timeout source, timedOut }
            requests: [],          // held approvals, FIFO; the head is the one on screen
            server: null, socketPath: '', closing: null, listenLogged: false, starting: false, startSeq: 0,
        };
        this._buildPillClaude();
        this._syncClaudeMonitor();
    },

    _destroyClaude() {
        this._stopClaudeApprove();
        // No timer may outlive disable(): close now. Held replies can be cut
        // off then (Claude Code reads that as no decision too).
        this._closeClaudeServer();
        for (let [proc, entry] of this._claude.procs) {
            if (entry.id)
                GLib.Source.remove(entry.id);
            proc.force_exit();
        }
        this._claude.procs.clear();
        this._disarmClaudeRule();
        this._stopClaudeMonitor();
    },

    _onClaudeFeatureToggled() {
        this._syncClaudeMonitor();
        this._updateTuck();
    },

    _syncClaudeMonitor() {
        // Approvals need the monitor too: it's how a terminal answer is seen.
        let approve = this._config.claudeApprove;
        if (this._config.isFeatureEnabled('claudeMonitor') || this._claude.tabOpen || approve)
            this._startClaudeMonitor();
        else
            this._stopClaudeMonitor();
        if (approve)
            this._startClaudeApprove();
        else
            this._stopClaudeApprove();
        this._syncPillClaude();
    },

    _startClaudeMonitor() {
        let c = this._claude;
        if (c.cancellable)
            return;
        c.cancellable = new Gio.Cancellable();
        try {
            // Works before ~/.claude/sessions exists too; the sweep covers
            // any monitor failure.
            c.monitor = Gio.File.new_for_path(SESSIONS_DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
            c.monitorId = c.monitor.connect('changed', () => this._queueClaudeRead());
        } catch (e) {
            logError('Claude sessions monitor', e);
        }
        c.sweepId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SWEEP_S, () => {
            this._readClaude();
            return GLib.SOURCE_CONTINUE;
        });
        this._readClaude();
    },

    _stopClaudeMonitor() {
        let c = this._claude;
        if (!c?.cancellable)
            return;
        c.cancellable.cancel();
        c.cancellable = null;
        c.seq++;
        if (c.monitor) {
            c.monitor.disconnect(c.monitorId);
            c.monitor.cancel();
            c.monitor = null;
        }
        for (let id of [c.debounceId, c.sweepId]) {
            if (id)
                GLib.Source.remove(id);
        }
        c.debounceId = c.sweepId = 0;
        // Forget everything: comparing against hour-old state on the next
        // start would raise stale "finished" alerts.
        c.sessions = new Map();
        c.unseen.clear();
        c.usage = null;
        c.mcp.auth = null;
    },

    // A session file changed: re-read once the burst of writes settles.
    _queueClaudeRead() {
        let c = this._claude;
        if (c.debounceId)
            GLib.Source.remove(c.debounceId);
        c.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            c.debounceId = 0;
            this._readClaude();
            return GLib.SOURCE_REMOVE;
        });
    },

    _readClaude() {
        let c = this._claude;
        let cancellable = c.cancellable;
        if (!cancellable)
            return;
        let seq = ++c.seq;
        Gio.File.new_for_path(SESSIONS_DIR).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, async (dir, res) => {
                let names = [];
                try {
                    let en = dir.enumerate_children_finish(res);
                    let info;
                    while ((info = en.next_file(null)) !== null) {
                        if (SESSION_FILE.test(info.get_name()))
                            names.push(info.get_name());
                    }
                    en.close(null);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // No sessions folder (Claude Code not used yet): no sessions.
                }
                let found = await Promise.all(names.map(async name => {
                    let s = parseSession(await read(`${SESSIONS_DIR}/${name}`, cancellable) ?? '');
                    // Caught mid-write: keep what we knew about that pid.
                    s ??= c.sessions.get(parseInt(name)) ?? null;
                    if (!s)
                        return null;
                    return isLive(s, await read(`/proc/${s.pid}/stat`, cancellable)) ? s : null;
                }));
                let usage = parseUsage(await read(USAGE_PATH, cancellable) ?? '');
                let auth = parseNeedsAuth(await read(MCP_AUTH_PATH, cancellable) ?? '');
                if (this._destroyed || seq !== c.seq)
                    return;
                this._applyClaude(found.filter(Boolean), usage, auth);
            });
    },

    _applyClaude(list, usage, auth = null) {
        let c = this._claude;
        let alerts = this._config.isFeatureEnabled('claudeMonitor');
        let next = new Map();
        for (let s of list) {
            let prev = c.sessions.get(s.pid);
            next.set(s.pid, s);
            let a = alertFor(prev, s);
            // A held request already has its banner.
            let held = a?.state === 'approval' && c.requests.some(r => r.sessionId && r.sessionId === s.sessionId);
            if (a && alerts && !held)
                this._pushClaudeAlert(s, a);
            if (s.state !== 'done')
                c.unseen.delete(s.pid);
            else if (prev && prev.state !== 'done')
                c.unseen.add(s.pid);
        }
        for (let pid of c.unseen) {
            if (!next.has(pid))
                c.unseen.delete(pid);
        }
        if (c.tabOpen)
            c.unseen.clear();
        c.sessions = next;
        c.usage = usage;
        let fresh = [];
        if (auth !== null) {   // null: caught mid-write, keep the last one
            fresh = newAuthNames(c.mcp.auth, auth);
            c.mcp.auth = auth;
        }
        if (fresh.length && alerts)
            this._pushAlert({ kind: 'claude-mcp', icon: 'dialog-password-symbolic', color: SYS.orange,
                title: fresh.length === 1 ? fresh[0] : `${fresh.length} MCP servers`,
                value: fresh.length === 1 ? 'needs /mcp' : 'need /mcp', valueColor: SYS.orange, ms: ALERT_MS,
                onClick: () => this._openClaudeView('mcp') });
        // A socket that couldn't be opened is retried with every read.
        if (this._config.claudeApprove)
            this._startClaudeApprove();
        this._sweepClaudeRequests();
        this._syncPillClaude();
        if (this._invalidateTab('claude'))
            this._updateClaudeTab();
        this._updateTuck();
    },

    _pushClaudeAlert(s, a) {
        let color = a.state === 'done' ? SYS.green : SYS.orange;
        // Kind per session: two sessions needing you queue up instead of one
        // replacing the other (helpers/alerts.js).
        this._pushAlert({ kind: `claude:${s.pid}`, icon: ALERT_ICON[a.state], color,
            title: a.title, value: a.value, valueColor: color, ms: ALERT_MS,
            onClick: () => this._raiseClaudeTerminal(s.pid) });
    },

    // Keeps the hide-when-idle notch out while a session waits for you.
    _claudeNeedsYou() {
        if (!this._config.isFeatureEnabled('claudeMonitor'))
            return false;
        for (let s of this._claude.sessions.values()) {
            if (s.state === 'approval' || s.state === 'question')
                return true;
        }
        return false;
    },

    // Bring the session's terminal forward: walk up its parent processes to
    // the first one that owns a window. Warp (like gnome-terminal) runs every
    // tab in one process, so that's its most recently used window — the tab
    // itself can't be picked from outside.
    async _raiseClaudeTerminal(pid) {
        let owners = new Map();
        for (let w of global.display.get_tab_list(Meta.TabList.NORMAL, null)) {
            let p = w.get_pid();
            if (p > 0 && !owners.has(p))
                owners.set(p, w);   // MRU order: the first is the most recent
        }
        for (let p = pid, hops = 0; p > 1 && hops < 16; hops++) {
            let win = owners.get(p);
            if (win) {
                if (this.isExpanded)
                    this._collapseImmediately();
                Main.activateWindow(win);
                return;
            }
            let stat = await read(`/proc/${p}/stat`, null);
            if (!stat || this._destroyed)
                return;
            p = procStat(stat).ppid;
        }
    },

    // ================================================================ approvals

    // Asks first whether something already answers on the socket (another
    // NotchNux of this user, e.g. a second login): if so it's left alone and
    // retried with the next sessions read. A dead socket file is replaced.
    _startClaudeApprove() {
        let c = this._claude;
        if (c.server || c.starting)
            return;
        this._closeClaudeServer();   // a stop just before: let it go now
        let path = approveSocketPath();
        let seq = ++c.startSeq;
        c.starting = true;
        new Gio.SocketClient().connect_async(Gio.UnixSocketAddress.new(path), null, (client, res) => {
            let live = false;
            try {
                client.connect_finish(res).close(null);
                live = true;
            } catch (e) {
                // nothing listening: stale or missing
            }
            c.starting = false;
            if (this._destroyed || seq !== c.startSeq || !this._config.claudeApprove)
                return;
            if (live) {
                if (!c.listenLogged)
                    logError(`Claude approvals: ${path} is already in use, leaving it alone`);
                c.listenLogged = true;
                return;
            }
            this._listenClaudeApprove(path);
        });
    },

    _listenClaudeApprove(path) {
        let c = this._claude;
        let server = new Soup.Server();
        server.add_handler(APPROVE_PATH, (srv, msg) => this._onClaudeRequest(msg));
        try {
            GLib.unlink(path);   // left behind by a crash; Soup won't reuse it
            server.listen(Gio.UnixSocketAddress.new(path), 0);
        } catch (e) {
            // Approvals stay in the terminal; retried on the next sync.
            if (!c.listenLogged)
                logError(`Claude approvals: can't listen on ${path}`, e);
            c.listenLogged = true;
            server.disconnect();
            return;
        }
        c.server = server;
        c.socketPath = path;
    },

    // Every held request gets "no decision", so the terminal dialogs carry on.
    _stopClaudeApprove() {
        let c = this._claude;
        if (!c)
            return;
        c.startSeq++;   // a start still asking about the socket gives up
        if (!c.server)
            return;
        let pending = c.requests;
        c.requests = [];
        c.shown = null;
        for (let r of pending)
            this._replyClaude(r.msg, 200, decisionBody('none'));
        // Closing the sockets at once would cut those replies off: stop taking
        // requests (gone socket / 404 = no decision too), close a moment later.
        GLib.unlink(c.socketPath);
        c.server.remove_handler(APPROVE_PATH);
        let server = c.server;
        c.server = null;
        c.closing = {
            server,
            id: GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                c.closing.id = 0;
                this._closeClaudeServer();
                return GLib.SOURCE_REMOVE;
            }),
        };
        if (this._peekSticky && !this._destroyed)
            this._hideNotificationPeek();
    },

    _closeClaudeServer() {
        let c = this._claude;
        if (!c.closing)
            return;
        if (c.closing.id)
            GLib.Source.remove(c.closing.id);
        c.closing.server.disconnect();
        c.closing = null;
    },

    _replyClaude(msg, status, body = '') {
        try {
            msg.set_status(status, null);
            if (body)
                msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(body));
            msg.unpause();
        } catch (e) {
            logError('Claude approval reply failed', e);
        }
    },

    _onClaudeRequest(msg) {
        if (msg.get_method() !== 'POST')
            return this._replyClaude(msg, 405);
        // ponytail: only this user's processes can reach the socket, so the
        // size check after Soup buffered the body is enough; an early handler
        // would be needed if it ever listens anywhere wider.
        let bytes = msg.get_request_body().flatten().get_data() ?? new Uint8Array();
        if (bytes.length > MAX_REQUEST_BYTES)
            return this._replyClaude(msg, 413);
        let req = null;
        try {
            req = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            // answered below
        }
        if (!req || typeof req !== 'object')
            return this._replyClaude(msg, 400);
        if (passThrough(req))
            return this._replyClaude(msg, 200, decisionBody('none'));

        let c = this._claude;
        msg.pause();
        let r = { req, msg, sessionId: String(req.session_id ?? ''), at: GLib.get_monotonic_time(), wallAt: Date.now(),
            seenWaiting: false, ready: asksAtOnce(req) };
        c.requests.push(r);
        // A session shows one dialog at a time: a new request means its
        // older ones were answered in the terminal. "No decision" is safe
        // even if that's wrong — it never approves anything.
        for (let old of c.requests.filter(o => o !== r && o.sessionId && o.sessionId === r.sessionId))
            this._answerClaudeRequest(old, 'none');
        // Read the sessions now: if the last read already saw this wait, a
        // terminal answer would never look like one (seenWaiting stays false).
        this._queueClaudeRead();
        this._presentClaudeRequest();
    },

    _answerClaudeRequest(r, kind) {
        let c = this._claude;
        let i = c.requests.indexOf(r);
        if (i < 0)
            return;
        c.requests.splice(i, 1);
        this._replyClaude(r.msg, 200, decisionBody(kind, r.req));
        // The one on screen: move on to the next, or spring back to the pill.
        if (r === c.shown) {
            c.shown = null;
            if (this._peekSticky && !this._presentClaudeRequest(true))
                this._hideNotificationPeek();
        }
    },

    // After each sessions read. A request is over when its session moved on:
    // seen asking and not any more (answered in the terminal), or its status
    // changed after the request came in without asking (auto mode settled
    // it, the turn ended). Claude Code leaves the hook running either way.
    // One older than the hook's timeout can't be answered any more.
    _sweepClaudeRequests() {
        let c = this._claude;
        if (!c.requests.length)
            return;
        let now = GLib.get_monotonic_time();
        for (let r of [...c.requests]) {
            let s = [...c.sessions.values()].find(x => x.sessionId && x.sessionId === r.sessionId);
            let waiting = s?.state === 'approval' || s?.state === 'question';
            if (waiting)
                r.seenWaiting = r.ready = true;
            let movedOn = !waiting && (r.seenWaiting || (s?.since ?? 0) > r.wallAt);
            if (now - r.at > REQUEST_MAX_AGE_US || movedOn)
                this._answerClaudeRequest(r, 'none');
        }
        this._presentClaudeRequest();   // one that just became ready
    },

    // Show the oldest ready request on the sticky banner. `replace` swaps the
    // banner already up. Returns whether a Claude banner is showing.
    _presentClaudeRequest(replace = false) {
        let c = this._claude;
        let r = c?.requests.find(x => x.ready);
        if (!r || this.isExpanded || this._isExpanding || (this._peekSticky && !replace))
            return false;
        let s = [...c.sessions.values()].find(x => x.sessionId && x.sessionId === r.sessionId);
        let { title, body, exact, always } = describeRequest(r.req, s?.name);
        // Clicking the banner or Open terminal hands the prompt back to the
        // terminal (no decision) and brings it forward: the banner goes away.
        let toTerminal = () => {
            if (s)
                this._raiseClaudeTerminal(s.pid);
            this._answerClaudeRequest(r, 'none');
        };
        r.shownAt = GLib.get_monotonic_time();
        c.shown = r;
        let act = (label, fn) => ({ label, manualHide: true, callback: () => {
            if (GLib.get_monotonic_time() - r.shownAt >= CLICK_GUARD_US)
                fn();
        } });
        let answer = (label, kind) => act(label, () => this._answerClaudeRequest(r, kind));
        // Allow only what the banner shows in full; the rest is approved in
        // the terminal.
        let actions = exact ? [answer('Allow', 'allow')] : [act('Open terminal', toTerminal)];
        // Only a plain allow rule for this tool, and the banner says which.
        if (always) {
            actions.push(answer('Always allow', 'always'));
            body = `${body}\nAlways allow adds ${always}`;
        }
        actions.push(answer('Deny', 'deny'));
        this._showNotificationPeek(title, body, new Gio.ThemedIcon({ name: 'dialog-warning-symbolic' }), null, actions,
            { sticky: true, onMainClick: toTerminal });
        return !!this._peekSticky;
    },

    // ================================================================ pill

    _buildPillClaude() {
        let box = new St.BoxLayout({ style_class: 'nn-pill-claude', y_align: Clutter.ActorAlign.CENTER, visible: false });
        this._pillClaudeDots = new St.BoxLayout({ style_class: 'nn-pill-claude-dots', y_align: Clutter.ActorAlign.CENTER });
        this._pillClaudePct = new St.Label({ style_class: 'nn-pill-claude-pct', y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this._pillClaudeDots);
        box.add_child(this._pillClaudePct);
        // Beside the battery, in the right zone (index inserts are taken by
        // the live-activity zones on the left).
        this._pill.insert_child_below(box, this._pillBatteryBox);
        this._pillClaudeBox = box;
    },

    _syncPillClaude() {
        let box = this._pillClaudeBox;
        if (!box)
            return;
        let c = this._claude;
        let show = this._config.isFeatureEnabled('claudeMonitor') && c.sessions.size > 0;
        let dots = show ? pillDots(c.sessions.values(), c.unseen) : [];
        let pct = show && c.usage?.fiveHour ? Math.round(c.usage.fiveHour.pct) : null;
        let sig = JSON.stringify([dots, pct, accentHex()]);
        if (sig === c.pillSig && show === box.visible)
            return;
        let newWait = dots.some(d => d.kind === 'waiting') && !c.pillSig.includes('waiting');
        c.pillSig = sig;
        this._pillClaudeDots.destroy_all_children();
        for (let d of dots) {
            let w = dot(dotColor(d.kind));
            if (d.count) {
                let pair = new St.BoxLayout({ style_class: 'nn-pill-claude-count', y_align: Clutter.ActorAlign.CENTER });
                pair.add_child(w);
                pair.add_child(new St.Label({ text: String(d.count), y_align: Clutter.ActorAlign.CENTER }));
                this._pillClaudeDots.add_child(pair);
            } else {
                this._pillClaudeDots.add_child(w);
            }
            // ponytail: a few pulses when a wait starts, then solid — an
            // endless pulse would repaint the stage every frame for as long
            // as a session sits waiting.
            if (d.kind === 'waiting' && newWait && St.Settings.get().enable_animations)
                w.ease({ opacity: 70, duration: 600, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    repeatCount: 5, autoReverse: true, onComplete: () => { w.opacity = 255; } });
        }
        this._pillClaudePct.visible = pct !== null;
        if (pct !== null) {
            this._pillClaudePct.set_text(`${pct}%`);
            this._pillClaudePct.set_style(`color: ${statColor(pct)};`);
        }
        box.visible = show;
        if (!this.isExpanded && !this._alertShowing)
            this._applyPillWidth();
    },

    // ================================================================ tab

    _renderClaudeTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-claude', vertical: true, x_expand: true });

        let seg = new St.BoxLayout({ style_class: 'nook-segmented', x_align: Clutter.ActorAlign.START });
        let segBtns = {};
        for (let [id, label] of CLAUDE_VIEWS) {
            let b = new St.Button({ style_class: 'nook-segment', label, can_focus: true });
            b.connect('clicked', () => this._openClaudeView(id));
            seg.add_child(b);
            segBtns[id] = b;
        }
        let top = new St.BoxLayout({ x_expand: true });
        top.add_child(seg);
        top.add_child(new St.Widget({ x_expand: true }));
        // Opens ~/.claude plus the view's file in the editor from Preferences.
        let editBtn = new St.Button({ style_class: 'nook-mini-btn', can_focus: true, visible: false,
            y_align: Clutter.ActorAlign.CENTER });
        editBtn.set_child(new St.Icon({ icon_size: 16 }));
        editBtn.connect('clicked', () => this._openInEditor([CLAUDE_DIR, VIEW_FILE[this._claudeView]]));
        addPressFeedback(editBtn);
        top.add_child(editBtn);
        panel.add_child(top);

        // ---- Sessions ----
        let sessionsView = new St.BoxLayout({ vertical: true, x_expand: true });
        let usageCard = new St.BoxLayout({ style_class: 'nn-cc-card nn-cc-list', vertical: true, x_expand: true });
        usageCard.add_child(text('USAGE', 'nook-card-eyebrow'));
        let five = this._ccMeter(usageCard, '5-hour');
        let week = this._ccMeter(usageCard, 'Weekly');
        let resets = text('', 'nook-card-meta nn-claude-resets');
        usageCard.add_child(resets);
        sessionsView.add_child(usageCard);
        let rcBox = new St.BoxLayout({ style_class: 'nn-cc-list', vertical: true, x_expand: true });
        let rc = this._ccRow(rcBox, 'Remote Control for new sessions', () => this._toggleClaudeRemote());
        sessionsView.add_child(rcBox);
        let list = new St.BoxLayout({ style_class: 'nn-claude-list', vertical: true, x_expand: true });
        sessionsView.add_child(scrolled(list));
        panel.add_child(sessionsView);

        // ---- MCP ----
        let mcpView = new St.BoxLayout({ vertical: true, x_expand: true });
        let head = new St.BoxLayout({ style_class: 'nn-claude-head', x_expand: true });
        let meta = text('', 'nook-card-meta', { x_expand: true });
        head.add_child(meta);
        let checkBtn = new St.Button({ style_class: 'nook-clear-btn', label: 'Check now', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER });
        checkBtn.connect('clicked', () => this._checkClaudeMcp());
        head.add_child(checkBtn);
        mcpView.add_child(head);
        let mcpList = new St.BoxLayout({ style_class: 'nn-claude-list', vertical: true, x_expand: true });
        mcpView.add_child(scrolled(mcpList));
        panel.add_child(mcpView);

        // ---- Rules ----
        let rulesView = new St.BoxLayout({ vertical: true, x_expand: true });
        let modeRow = new St.BoxLayout({ style_class: 'nn-claude-head', x_expand: true });
        modeRow.add_child(text('Default mode', 'nn-claude-name', { x_expand: true }));
        let modeSeg = new St.BoxLayout({ style_class: 'nook-segmented', y_align: Clutter.ActorAlign.CENTER });
        let modeBtns = {};
        for (let [id, label] of MODE_LABELS) {
            let b = new St.Button({ style_class: 'nook-segment', label, can_focus: true });
            b.connect('clicked', () => this._setClaudeMode(id));
            modeSeg.add_child(b);
            modeBtns[id] = b;
        }
        modeRow.add_child(modeSeg);
        rulesView.add_child(modeRow);
        let modeNote = text('', 'nook-card-meta nn-claude-note');
        rulesView.add_child(modeNote);
        let rulesList = new St.BoxLayout({ style_class: 'nn-claude-list', vertical: true, x_expand: true });
        rulesView.add_child(scrolled(rulesList));
        panel.add_child(rulesView);

        // ---- Plugins & skills ----
        let pluginsView = new St.BoxLayout({ vertical: true, x_expand: true });
        let extrasNote = text('', 'nook-card-meta nn-claude-note');
        pluginsView.add_child(extrasNote);
        let extrasList = new St.BoxLayout({ style_class: 'nn-claude-list nn-cc-list', vertical: true, x_expand: true });
        pluginsView.add_child(scrolled(extrasList));
        panel.add_child(pluginsView);

        this._mount(panel);
        this._claudeUi = { segBtns, views: { sessions: sessionsView, mcp: mcpView, rules: rulesView, plugins: pluginsView },
            editBtn, rc, five, week, resets, list, sig: null, ages: [],
            mcp: { meta, btn: checkBtn, list: mcpList, sig: null },
            rules: { modeBtns, note: modeNote, list: rulesList, sig: null },
            extras: { note: extrasNote, list: extrasList, sig: null } };
        this._claudeTabShown();
    },

    // Rendered, or shown again from the kept actors.
    _claudeTabShown() {
        let c = this._claude;
        c.tabOpen = true;
        c.rules.loaded = false;   // re-read settings each time the tab shows
        c.extras.loaded = false;
        c.unseen.clear();
        this._syncClaudeMonitor();
        this._updateClaudeTab(false);
    },

    _leaveClaudeTab() {
        this._claude.tabOpen = false;
        this._syncClaudeMonitor();
    },

    // Switch views (and open the Claude tab if it isn't up).
    _openClaudeView(id) {
        this._claudeView = id;
        if (id === 'rules')
            this._claude.rules.loaded = false;
        if (id === 'plugins')
            this._claude.extras.loaded = false;
        if (this._activeTab !== 'claude' || !this.isExpanded) {
            this._openTab('claude');
            return;
        }
        this._updateClaudeTab(false);
        this._resizeClaudeTab();
    },

    _resizeClaudeTab() {
        if (this.isExpanded && this._activeTab === 'claude' && !this._presenting)
            this._resizeToContent();
    },

    _updateClaudeTab(animate = true) {
        let ui = this._claudeUi;
        if (!ui || this._destroyed)
            return;
        let c = this._claude;

        let view = this._claudeView ??= 'sessions';
        for (let [id, b] of Object.entries(ui.segBtns)) {
            if (id === view)
                b.add_style_class_name('nook-segment-active');
            else
                b.remove_style_class_name('nook-segment-active');
            ui.views[id].visible = id === view;
        }
        let editor = editorApp(this._config.claudeEditor, lookupApp);
        ui.editBtn.visible = !!editor;
        if (editor) {
            ui.editBtn.child.gicon = editor.get_icon();
            // Claude Code rewrites ~/.claude.json while sessions run.
            ui.editBtn.accessible_name = view === 'mcp'
                ? `Open ~/.claude.json in ${editor.get_name()} (close Claude sessions before editing MCP servers by hand)`
                : `Open ~/.claude in ${editor.get_name()}`;
        }

        // ---- Remote Control for new sessions (the user's settings.json) ----
        let r = c.rules;
        let user = r.files.find(f => f.scope === 'user');
        let rcOn = remoteAtStartup(user?.settings);
        ui.rc.update(rcOn, r.error || user?.error || (!r.loaded ? 'Reading settings…'
            : `${rcOn ? 'On' : 'Off'} · a running session’s phone button copies /rc`), 'phone-symbolic');
        ui.rc.setEnabled(r.loaded && !user?.error);

        // ---- usage ----
        let u = c.usage;
        for (let [m, w] of [[ui.five, u?.fiveHour], [ui.week, u?.weekly]]) {
            m.fill.get_parent().get_parent().visible = !!w;
            if (w)
                this._setMeter(m, w.pct, animate);
        }
        if (!u)
            ui.resets.set_text('Connect Claude Code in NotchNux Preferences to see usage.');
        else
            ui.resets.set_text([u.fiveHour && `5-hour ${fmtReset(u.fiveHour.resetsAt)}`,
                u.weekly && `weekly ${fmtReset(u.weekly.resetsAt)}`].filter(Boolean).join(' · '));

        // ---- sessions: rebuild only when the set or a state changes ----
        let sessions = sortSessions(c.sessions.values());
        let sig = JSON.stringify(sessions.map(s => [s.pid, s.state, s.name, s.folder]));
        if (sig !== ui.sig) {
            ui.sig = sig;
            ui.list.destroy_all_children();
            ui.ages = [];
            if (sessions.length === 0) {
                let empty = new St.BoxLayout({ style_class: 'nook-empty', vertical: true, x_expand: true });
                empty.add_child(new St.Icon({ icon_name: 'utilities-terminal-symbolic', icon_size: 22,
                    style_class: 'nook-dim', x_align: Clutter.ActorAlign.CENTER }));
                empty.add_child(new St.Label({ text: 'No Claude Code sessions running',
                    style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
                ui.list.add_child(empty);
            }
            for (let s of sessions)
                ui.list.add_child(this._buildClaudeRow(s, ui));
            this._resizeClaudeTab();
        }
        let now = Date.now();
        for (let { label, since } of ui.ages)
            label.set_text(fmtAge(now - since));

        this._updateClaudeMcp(ui.mcp);
        // Load on open, and again when the live folders change (sessions
        // usually arrive after the view opens). Sessions reads the user's
        // settings too, for the Remote Control switch.
        let key = this._claudeFoldersKey();
        let stale = st => st.key !== key || (!st.loaded && !st.loading);
        if ((view === 'rules' || view === 'sessions') && stale(c.rules))
            this._loadClaudeRules();
        this._updateClaudeRules(ui.rules);
        if (view === 'plugins' && stale(c.extras))
            this._loadClaudeExtras();
        this._updateClaudeExtras(ui.extras);
    },

    _claudeFoldersKey() {
        return [...new Set([...this._claude.sessions.values()].map(s => s.cwd).filter(Boolean))].sort().join('\n');
    },

    // ---- Rules view ----
    async _loadClaudeRules() {
        let r = this._claude.rules;
        let seq = ++r.seq;
        r.key = this._claudeFoldersKey();
        r.loading = true;
        try {
            let files = claudeSettingsFiles(r.key ? r.key.split('\n') : []);
            let read = await Promise.all(files.map(f => readSettingsAsync(f.path).then(x => ({ ...f, ...x, file: f.path }))));
            if (this._destroyed || seq !== r.seq)
                return;
            r.files = read;
        } catch (e) {
            r.error = `Couldn’t read settings (${e.message})`;
        } finally {
            if (seq === r.seq) {
                r.loading = false;
                r.loaded = true;   // even after an error: no reload loop
            }
        }
        if (!this._destroyed && seq === r.seq)
            this._updateClaudeTab(false);
    },

    _updateClaudeRules(ui) {
        let r = this._claude.rules;
        let user = r.files.find(f => f.scope === 'user');
        let mode = user?.settings?.permissions?.defaultMode ?? 'default';
        for (let [id, b] of Object.entries(ui.modeBtns)) {
            if (id === mode)
                b.add_style_class_name('nook-segment-active');
            else
                b.remove_style_class_name('nook-segment-active');
        }
        ui.note.set_text(r.error || (SAFE_MODES.includes(mode) ? 'New sessions start in this mode'
            : `New sessions start in ${mode}, set outside the notch`));

        let canEdit = !!editorApp(this._config.claudeEditor, lookupApp);
        let sig = JSON.stringify([r.loaded, canEdit, r.files.map(f => [f.file, f.error, rulesOf(f.settings)])]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        this._disarmClaudeRule();
        ui.list.destroy_all_children();
        let any = false;
        for (let f of r.files) {
            let rules = f.error ? [] : rulesOf(f.settings);
            if (!rules.length && !f.error)
                continue;
            any = true;
            let head = new St.BoxLayout({ x_expand: true });
            head.add_child(text(f.label, 'nook-card-meta nn-claude-group', { x_expand: true }));
            if (canEdit) {
                // The file's own folder (~/.claude, or the session's folder).
                let folder = f.scope === 'user' ? CLAUDE_DIR : GLib.path_get_dirname(GLib.path_get_dirname(f.file));
                head.add_child(iconBtn('document-edit-symbolic', 'nook-mini-btn', () => this._openInEditor([folder, f.file]),
                    `Open ${f.label} in the editor`));
            }
            ui.list.add_child(head);
            if (f.error)
                ui.list.add_child(text(f.error, 'nook-card-meta'));
            for (let rule of rules)
                ui.list.add_child(this._buildRuleRow(f, rule));
        }
        if (!any) {
            let empty = new St.BoxLayout({ style_class: 'nook-empty', vertical: true, x_expand: true });
            empty.add_child(new St.Icon({ icon_name: 'security-high-symbolic', icon_size: 22,
                style_class: 'nook-dim', x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: r.loaded ? 'No permission rules' : 'Reading settings…',
                style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
            ui.list.add_child(empty);
        }
        this._resizeClaudeTab();
    },

    _buildRuleRow(f, { kind, rule }) {
        let row = new St.BoxLayout({ style_class: 'nn-claude-row nn-claude-rule', x_expand: true });
        row.add_child(text(kind, 'nn-claude-badge', { style: `color: ${KIND_COLOR[kind]};` }));
        row.add_child(text(rule, 'nn-claude-rule-text', { x_expand: true }));
        let del = iconBtn('window-close-symbolic', 'nook-mini-btn',
            () => this._armOrRun(del, () => this._editRules(f.path, s => removeRule(s, kind, rule), f.scope === 'user')),
            `Remove ${kind} rule ${rule}`);
        row.add_child(del);
        return row;
    },

    // × once arms it ("Remove?" for 3 s), a second click runs `action`.
    _armOrRun(btn, action) {
        let r = this._claude.rules;
        if (r.armed?.btn === btn) {
            this._disarmClaudeRule();
            action();
            return;
        }
        this._disarmClaudeRule();
        btn.set_child(new St.Label({ text: 'Remove?', y_align: Clutter.ActorAlign.CENTER }));
        btn.add_style_class_name('nook-danger');
        let armed = { btn, id: 0, sig: 0 };
        armed.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_MS, () => {
            armed.id = 0;
            this._disarmClaudeRule();
            return GLib.SOURCE_REMOVE;
        });
        // A rebuilt list destroys the button: forget it without touching it.
        armed.sig = btn.connect('destroy', () => {
            if (armed.id)
                GLib.Source.remove(armed.id);
            if (r.armed === armed)
                r.armed = null;
        });
        r.armed = armed;
    },

    _disarmClaudeRule() {
        let r = this._claude?.rules;
        let a = r?.armed;
        if (!a)
            return;
        r.armed = null;
        if (a.id)
            GLib.Source.remove(a.id);
        a.btn.disconnect(a.sig);
        a.btn.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }));
        a.btn.remove_style_class_name('nook-danger');
    },

    _setClaudeMode(mode) {
        let user = this._claude.rules.files.find(f => f.scope === 'user');
        if ((user?.settings?.permissions?.defaultMode ?? 'default') === mode)
            return;
        this._editRules(user?.path ?? SETTINGS_PATH, s => setDefaultMode(s, mode), true);
    },

    async _editRules(path, edit, backup) {
        let r = this._claude.rules;
        r.error = await this._editClaudeSettings(path, edit, backup);
        if (!this._destroyed)
            this._loadClaudeRules();
    },

    // Re-read right before writing (Claude Code may have changed the file),
    // apply `edit`, write in the file's own layout. → '' or what went wrong.
    // Edits queue up, so two quick clicks can't both start from the same
    // copy and undo each other. `backup` only for the user's own file.
    _editClaudeSettings(path, edit, backup = false) {
        let c = this._claude;
        let run = c.edits.then(() => this._editClaudeSettingsNow(path, edit, backup));
        c.edits = run.catch(() => {});
        return run;
    },

    async _editClaudeSettingsNow(path, edit, backup) {
        let cur = await readSettingsAsync(path);
        if (cur.error)
            return cur.error;
        let next = edit(cur.settings);
        if (next === cur.settings)
            return '';
        try {
            await writeSettingsAsync(cur.path, next, cur.layout, { backup });
            return '';
        } catch (e) {
            return `Couldn’t write ${cur.path} (${e.message})`;
        }
    },

    // ---- Plugins view: plugins (claude CLI) and skills (skillOverrides) ----

    // Personal skills follow the user's settings; a folder's own skills its
    // settings.local.json (not committed). Plugin skills follow their plugin.
    // `plugins: false` re-reads only the skills (a skill toggle doesn't change
    // the plugin list, and listing plugins spawns claude). Plugins and skills
    // each keep their own newest-wins counter.
    async _loadClaudeExtras({ plugins = true } = {}) {
        let x = this._claude.extras;
        let seq = ++x.seq;
        let pseq = plugins ? ++x.pseq : 0;
        x.key = this._claudeFoldersKey();
        x.loading = true;
        try {
            let cwds = x.key ? x.key.split('\n') : [];
            let [listed, ctx] = await Promise.all([
                plugins ? new Promise(resolve => this._runClaude(['plugin', 'list', '--json'], { timeoutS: 30 },
                    (out, err) => resolve({ list: parsePluginList(out ?? ''), err }))) : null,
                this._readSkillSettings(cwds),
            ]);
            let skills = (await Promise.all(skillSources(cwds).map(src => this._readSkills(src, ctx)))).flat();
            if (this._destroyed)
                return;
            if (listed && pseq === x.pseq) {
                x.plugins = listed.list;
                x.error = listed.list ? '' : (listed.err ?? 'claude plugin list printed nothing');
            }
            if (seq !== x.seq)
                return;
            x.skills = skills;
            x.overrides = ctx.overrides;
        } catch (e) {
            x.error = `Couldn’t read plugins and skills (${e.message})`;
        } finally {
            if (seq === x.seq) {
                x.loading = false;
                x.loaded = true;
            }
        }
        if (!this._destroyed && seq === x.seq)
            this._updateClaudeTab(false);
    },

    // Every file that can decide a skill: admin policy, the user's settings,
    // and each live folder's settings.json + settings.local.json, plus the
    // overrides those folders hold (listed so they can be removed).
    async _readSkillSettings(cwds) {
        let get = async path => (await readSettingsAsync(path)).settings ?? {};
        let [policy, user] = await Promise.all([get(MANAGED_SETTINGS_PATH), get(SETTINGS_PATH)]);
        let folders = await Promise.all(cwds.map(async cwd => {
            let projectPath = `${cwd}/.claude/settings.json`;
            let localPath = `${cwd}/.claude/settings.local.json`;
            // A session in ~: its project file is the user's own.
            let [project, local] = await Promise.all([projectPath === SETTINGS_PATH ? null : get(projectPath), get(localPath)]);
            return { cwd, name: GLib.path_get_basename(cwd), project, local, projectPath, localPath };
        }));
        let overrides = [];
        for (let f of folders) {
            for (let [scope, path, settings] of [['local', f.localPath, f.local], ['project', f.projectPath, f.project]]) {
                for (let [name, value] of Object.entries(settings?.skillOverrides ?? {})) {
                    if (typeof value === 'string')
                        overrides.push({ name, value, path, scope, folder: f.name });
                }
            }
        }
        overrides.sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder));
        return { policy, user, folders, overrides };
    },

    // One skills folder → [{ name, description, state, scope, lower, settings,
    // where, notes }]. Personal skills: the toggle sets the user-level default
    // (the one setting every project sees); `notes` say where a live folder
    // decides otherwise. A folder's own skills: its local file, as /skills does.
    async _readSkills(src, ctx) {
        // All async: a session folder can sit on a network mount.
        let names = await new Promise(resolve => {
            Gio.File.new_for_path(src.dir).enumerate_children_async('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (dir, res) => {
                    let en;
                    try {
                        en = dir.enumerate_children_finish(res);
                    } catch (e) {
                        resolve([]);   // no skills folder: no skills
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
                        for (let info of infos) {
                            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                                out.push(info.get_name());
                        }
                        if (infos.length) {
                            more();
                            return;
                        }
                        en.close_async(GLib.PRIORITY_LOW, null, (e2, r2) => {
                            try {
                                e2.close_finish(r2);
                            } catch (err) {
                                // closing can't lose anything here
                            }
                        });
                        resolve(out);
                    });
                    more();
                });
        });
        let home = ctx.folders.find(f => f.cwd === src.cwd);
        let skills = await Promise.all(names.map(async dirName => {
            let text = await read(`${src.dir}/${dirName}/SKILL.md`, null);
            if (text === null)
                return null;
            let meta = parseSkillMeta(text);
            let name = meta.name || dirName;
            let eff, lower, notes = [];
            if (!home) {
                eff = effectiveSkill(name, { policy: ctx.policy, user: ctx.user });
                lower = 'on';
                for (let f of ctx.folders) {
                    let there = effectiveSkill(name, { policy: ctx.policy, local: f.local, project: f.project, user: ctx.user });
                    if (there.scope in SCOPE_TEXT && there.state !== eff.state)
                        notes.push(`${OVERRIDE_TEXT[there.state] ?? there.state} in ${f.name}`);
                }
            } else {
                eff = effectiveSkill(name, { policy: ctx.policy, local: home.local, project: home.project, user: ctx.user });
                lower = effectiveSkill(name, { project: home.project, user: ctx.user }).state;
            }
            return { name, description: meta.description, state: eff.state, scope: eff.scope, lower, notes,
                settings: src.settings, where: src.where };
        }));
        return skills.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    },

    _updateClaudeExtras(ui) {
        let x = this._claude.extras;
        ui.note.set_text(x.actionError || x.error || x.note || (x.loaded ? 'Plugin changes reach open sessions after /reload-plugins'
            : 'Reading plugins and skills…'));
        let sig = JSON.stringify([x.loaded, x.plugins, x.skills, x.overrides, [...x.busy]]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        this._disarmClaudeRule();
        ui.list.destroy_all_children();
        if (x.plugins?.length) {
            ui.list.add_child(text('Plugins', 'nook-card-meta nn-claude-group'));
            for (let p of x.plugins) {
                let item = this._ccRow(ui.list, p.name, () => this._toggleClaudePlugin(p));
                item.update(p.enabled, [p.marketplace, p.version, p.scope !== 'user' && p.scope].filter(Boolean).join(' · '),
                    'application-x-addon-symbolic');
                // ponytail: user-scope only — a project plugin's folder isn't
                // in the list output, so toggling from ~ could hit the wrong one.
                item.setEnabled(p.scope === 'user' && !x.busy.has(p.id));
            }
        }
        if (x.skills.length) {
            ui.list.add_child(text('Skills', 'nook-card-meta nn-claude-group'));
            for (let sk of x.skills) {
                let on = sk.state !== 'off';
                let item = this._ccRow(ui.list, sk.name, () => this._toggleClaudeSkill(sk));
                let sub = [sk.where, OVERRIDE_TEXT[sk.state], sk.scope === 'policy' && 'set by policy', ...sk.notes,
                    sk.description].filter(Boolean).join(' · ');
                item.update(on, sub, 'accessories-text-editor-symbolic');
                item.setEnabled(sk.scope !== 'policy' && !x.busy.has(`skill:${sk.settings}:${sk.name}`));
            }
        }
        if (x.overrides.length) {
            ui.list.add_child(text('Overrides in live folders', 'nook-card-meta nn-claude-group'));
            for (let o of x.overrides) {
                let row = new St.BoxLayout({ style_class: 'nn-claude-row nn-claude-rule', x_expand: true });
                row.add_child(text(OVERRIDE_TEXT[o.value] ?? o.value, 'nn-claude-badge',
                    { style: `color: ${OVERRIDE_COLOR[o.value] ?? SYS.orange};` }));
                row.add_child(text(`${o.name} · ${o.folder} (${SCOPE_TEXT[o.scope]})`, 'nn-claude-rule-text', { x_expand: true }));
                let del = iconBtn('window-close-symbolic', 'nook-mini-btn', () => this._armOrRun(del, () => this._removeSkillOverride(o)),
                    `Remove the ${o.name} override in ${o.folder}`);
                row.add_child(del);
                ui.list.add_child(row);
            }
        }
        this._resizeClaudeTab();
    },

    _toggleClaudePlugin(p) {
        let x = this._claude.extras;
        if (x.busy.has(p.id) || p.scope !== 'user')
            return;
        x.busy.add(p.id);
        this._updateClaudeTab(false);
        this._runClaude(['plugin', p.enabled ? 'disable' : 'enable', p.id, '--scope', p.scope], { timeoutS: 60 }, (out, err) => {
            x.busy.delete(p.id);
            x.actionError = err ?? '';
            x.note = err ? '' : `${p.name} ${p.enabled ? 'off' : 'on'}: open sessions pick it up after /reload-plugins`;
            this._loadClaudeExtras();
        });
    },

    async _toggleClaudeSkill(sk) {
        let x = this._claude.extras;
        let key = `skill:${sk.settings}:${sk.name}`;
        if (x.busy.has(key))
            return;
        x.busy.add(key);
        this._updateClaudeTab(false);
        let off = sk.state !== 'off';
        let err = await this._editClaudeSettings(sk.settings, skillEdit(sk.name, !off, sk.lower),
            sk.settings === SETTINGS_PATH);
        if (this._destroyed)
            return;
        x.busy.delete(key);
        x.actionError = err;
        x.note = err ? '' : `${sk.name} ${off ? 'off' : 'on'} for new sessions`;
        this._loadClaudeExtras({ plugins: false });
    },

    // Drop one folder's override, so the skill follows the next setting down.
    async _removeSkillOverride(o) {
        let x = this._claude.extras;
        let err = await this._editClaudeSettings(o.path, s => setSkillOverride(s, o.name, true));
        if (this._destroyed)
            return;
        x.actionError = err;
        x.note = err ? '' : `${o.name}: ${o.folder}'s override removed`;
        this._loadClaudeExtras({ plugins: false });
    },

    // ---- MCP view: problems first, then counts ----
    _updateClaudeMcp(ui) {
        let m = this._claude.mcp;
        let sum = mcpSummary(m.auth ?? new Map(), m.check);
        // No session, no check: the desktop's PATH would fail servers that
        // need the terminal's (nvm & co.), and Claude Code caches those
        // failures for every session for a while.
        let hasSession = [...this._claude.sessions.values()].some(s => s.cwd);
        ui.btn.label = m.running ? 'Checking…' : 'Check now';
        ui.btn.reactive = !m.running && hasSession;
        ui.btn.opacity = ui.btn.reactive || m.running ? 255 : 110;
        let age = m.check && fmtAge(Date.now() - m.check.at);
        ui.meta.set_text(m.running ? 'Starting each server, this takes a few seconds'
            : m.error || (m.check ? `Checked ${age === 'now' ? 'just now' : `${age} ago`} in ${m.check.folder}`
                : hasSession ? 'Check now tests every server'
                    : 'Open a Claude Code session to check: it uses that session’s PATH'));

        let sig = JSON.stringify([sum, !!m.check]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        ui.list.destroy_all_children();
        for (let p of sum.problems)
            ui.list.add_child(this._buildMcpRow(p));
        if (sum.ok.length) {
            ui.list.add_child(text('Connected', 'nook-card-meta nn-claude-group'));
            for (let p of sum.ok)
                ui.list.add_child(this._buildMcpRow({ ...p, detail: p.target }));
        }
        if (sum.off)
            ui.list.add_child(text(`${sum.off} not configured`, 'nook-card-meta nn-claude-mcp-sum'));
        if (!sum.problems.length && !sum.ok.length && !sum.off) {
            let empty = new St.BoxLayout({ style_class: 'nook-empty', vertical: true, x_expand: true });
            empty.add_child(new St.Icon({ icon_name: 'network-server-symbolic', icon_size: 22,
                style_class: 'nook-dim', x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: m.check ? 'No MCP servers' : 'No MCP problems known',
                style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
            ui.list.add_child(empty);
        }
        this._resizeClaudeTab();
    },

    // Clicking brings the newest session's terminal forward, to run /mcp.
    _buildMcpRow(p) {
        let [state, color, hint] = MCP_TEXT[p.status];
        let btn = new St.Button({ style_class: 'nn-claude-row', x_expand: true, can_focus: true,
            accessible_name: `${p.name}: ${state}` });
        let row = new St.BoxLayout({ x_expand: true });
        row.add_child(dot(color));
        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'nn-claude-col' });
        col.add_child(text(p.name, 'nn-claude-name'));
        if (p.detail || hint)
            col.add_child(text(p.detail || hint, 'nook-card-meta'));
        row.add_child(col);
        row.add_child(text(state, 'nn-claude-state', { style: `color: ${color};` }));
        btn.set_child(row);
        btn.connect('clicked', () => {
            let newest = sortSessions(this._claude.sessions.values()).sort((a, b) => b.startedAt - a.startedAt)[0];
            if (newest)
                this._raiseClaudeTerminal(newest.pid);
        });
        addPressFeedback(btn);
        return btn;
    },

    // `claude mcp list` in the newest session's folder (results depend on
    // it) and with that session's own environment from /proc, so servers
    // started with npx & co. see the terminal's PATH and variables without
    // running the user's shell rc. No session: no check (see _updateClaudeMcp).
    // ponytail: one folder per check; other live folders' .mcp.json servers
    // aren't tested.
    async _checkClaudeMcp() {
        let c = this._claude;
        let m = c.mcp;
        if (m.running)
            return;
        let newest = [...c.sessions.values()].filter(s => s.cwd).sort((a, b) => b.startedAt - a.startedAt)[0];
        if (!newest)
            return;
        m.running = true;
        m.error = '';
        this._updateClaudeTab(false);
        let env = parseEnviron(await read(`/proc/${newest.pid}/environ`, null) ?? '');
        if (this._destroyed)
            return;
        // The session ended meanwhile (environ unreadable): the desktop's
        // environment would be wrong, so no check.
        if (!env.length) {
            m.running = false;
            m.error = `${newest.name} ended before the check started`;
            this._updateClaudeTab(false);
            return;
        }
        let folder = newest.folder || '~';
        this._runClaude(['mcp', 'list'], { cwd: newest.cwd, env, timeoutS: MCP_CHECK_TIMEOUT_S }, (out, err, timedOut) => {
            m.running = false;
            let result = mcpCheckOutcome(out, err, timedOut);
            if (result.servers)
                m.check = { at: Date.now(), folder, servers: result.servers };
            else
                m.error = result.error;
            this._updateClaudeTab(false);
        });
    },

    // Run `claude <args>`; done(stdout | null, error | null, timedOut). `env` (a list
    // of NAME=value) replaces the environment when given. After timeoutS
    // it gets SIGTERM (claude stops the servers it started), SIGKILL 5 s
    // later; disable() kills at once.
    _runClaude(args, { cwd = null, env = null, timeoutS = 30 } = {}, done) {
        let bin = claudeBinary();
        if (!bin) {
            done(null, 'Claude Code (claude) isn\u2019t on this computer\u2019s PATH');
            return;
        }
        let launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
        launcher.set_cwd(cwd || GLib.get_home_dir());
        if (env?.length)
            launcher.set_environ(env);
        let proc;
        try {
            proc = launcher.spawnv([bin, ...args]);
        } catch (e) {
            done(null, `Couldn\u2019t run claude (${e.message})`);
            return;
        }
        let procs = this._claude.procs;
        let entry = { id: 0, timedOut: false };
        procs.set(proc, entry);
        entry.id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutS, () => {
            entry.timedOut = true;
            proc.send_signal(15);
            entry.id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                entry.id = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (p, res) => {
            if (entry.id)
                GLib.Source.remove(entry.id);
            entry.id = 0;
            procs.delete(p);
            let out = null;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                // killed or failed: out stays null
            }
            if (this._destroyed)
                return;
            done(out, entry.timedOut ? `claude ${args.join(' ')} took too long`
                : (p.get_successful() ? null : `claude ${args.join(' ')} failed`), entry.timedOut);
        });
    },

    _buildClaudeRow(s, ui) {
        let line = new St.BoxLayout({ style_class: 'nn-claude-session', x_expand: true });
        let btn = new St.Button({ style_class: 'nn-claude-row', x_expand: true, can_focus: true,
            accessible_name: `${s.name}: ${STATE_TEXT[s.state]}` });
        let row = new St.BoxLayout({ x_expand: true });
        row.add_child(dot(stateColor(s.state)));
        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'nn-claude-col' });
        col.add_child(text(s.name, 'nn-claude-name'));
        if (s.folder && s.folder !== s.name)
            col.add_child(text(s.folder, 'nook-card-meta'));
        row.add_child(col);
        row.add_child(text(STATE_TEXT[s.state], 'nn-claude-state', { style: `color: ${stateColor(s.state)};` }));
        let age = text('', 'nn-claude-age');
        row.add_child(age);
        ui.ages.push({ label: age, since: s.since });
        btn.set_child(row);
        btn.connect('clicked', () => this._raiseClaudeTerminal(s.pid));
        addPressFeedback(btn);
        line.add_child(btn);
        for (let [icon, cmd, what] of [['phone-symbolic', '/rc', 'start Remote Control'],
            ['document-edit-symbolic', '/rename ', 'rename it']]) {
            line.add_child(iconBtn(icon, 'nook-mini-btn', () => this._pasteToClaude(s, cmd),
                `Copy ${cmd.trim()} and open ${s.name}’s terminal to ${what}`));
        }
        return line;
    },

    // A running session only takes /rc and /rename at its own prompt: put
    // the command on the clipboard and bring its terminal forward. The new
    // name shows here by itself (the row reads Claude Code's own name).
    _pasteToClaude(s, cmd) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, cmd);
        this._raiseClaudeTerminal(s.pid);
        this._pushAlert({ kind: 'claude-paste', icon: 'edit-paste-symbolic', color: accentHex(),
            title: s.name, value: `paste ${cmd.trim()}`, valueColor: accentHex(), ms: ALERT_MS });
    },

    // Remote Control for new sessions: remoteControlAtStartup in the user's
    // settings.json (project and local files can't turn it on).
    _toggleClaudeRemote() {
        let r = this._claude.rules;
        let user = r.files.find(f => f.scope === 'user');
        if (!r.loaded || user?.error)
            return;
        let on = !remoteAtStartup(user?.settings);
        this._editRules(user?.path ?? SETTINGS_PATH, st => setRemoteAtStartup(st, on), true);
    },

    // Open `paths` (a folder, then files) in the editor from Preferences.
    _openInEditor(paths) {
        let app = editorApp(this._config.claudeEditor, lookupApp);
        if (!app)
            return;
        if (this.isExpanded)
            this._collapseImmediately();
        try {
            app.launch(paths.filter(Boolean).map(p => Gio.File.new_for_path(p)), global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(`Couldn’t open ${app.get_name()}`, e);
        }
    },
};

export function installClaude(proto) {
    for (let [name, fn] of Object.entries(ClaudeFeatures))
        proto[name] = fn;
}
