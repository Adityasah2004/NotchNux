// Claude tab + the pill's Claude Code dots.
//
//   pill:  ( ♫ Song…     Tue 3 · 2:32 PM     ● ◉ ○ 42%   🔋 87% )
//            one dot per session (working · waiting for you · finished),
//            then the 5-hour usage
//   tab:   5-hour / weekly usage bars, then one row per live session
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
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    SESSIONS_DIR, USAGE_PATH, SESSION_FILE, parseSession, procStat, isLive, alertFor,
    parseUsage, sortSessions, pillDots, fmtAge,
    APPROVE_PATH, HOOK_TIMEOUT_S, approveSocketPath, passThrough, describeRequest, decisionBody,
} from '../helpers/claude.js';
import { readTextAsync } from '../helpers/productivity.js';
import { fmt } from '../helpers/format.js';
import { addPressFeedback } from '../helpers/motion.js';
import { accentHex } from '../helpers/widgets.js';
import { logError } from '../helpers/log.js';
import { SYS, statColor } from './ledge.js';

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
            requests: [],          // held approvals, FIFO; the head is the one on screen
            server: null, socketPath: '', closing: null, listenLogged: false,
        };
        this._buildPillClaude();
        this._syncClaudeMonitor();
    },

    _destroyClaude() {
        this._stopClaudeApprove();
        // No timer may outlive disable(): close now. Held replies can be cut
        // off then (Claude Code reads that as no decision too).
        this._closeClaudeServer();
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
                if (this._destroyed || seq !== c.seq)
                    return;
                this._applyClaude(found.filter(Boolean), usage);
            });
    },

    _applyClaude(list, usage) {
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

    _startClaudeApprove() {
        let c = this._claude;
        if (c.server)
            return;
        this._closeClaudeServer();   // a stop just before: let it go now
        let path = approveSocketPath();
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
        if (!c?.server)
            return;
        let pending = c.requests;
        c.requests = [];
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
        let r = { req, msg, sessionId: String(req.session_id ?? ''), at: GLib.get_monotonic_time(), seenWaiting: false };
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
        // The head is the one on screen: move on to the next, or spring back
        // to the pill.
        if (i === 0 && this._peekSticky && !this._presentClaudeRequest(true))
            this._hideNotificationPeek();
    },

    // After each sessions read: a request whose session was seen waiting and
    // has moved on was answered in the terminal; one older than the hook's
    // timeout can't be answered any more.
    _sweepClaudeRequests() {
        let c = this._claude;
        if (!c.requests.length)
            return;
        let now = GLib.get_monotonic_time();
        for (let r of [...c.requests]) {
            let s = [...c.sessions.values()].find(x => x.sessionId && x.sessionId === r.sessionId);
            let waiting = s?.state === 'approval' || s?.state === 'question';
            if (waiting)
                r.seenWaiting = true;
            if (now - r.at > REQUEST_MAX_AGE_US || (r.seenWaiting && !waiting))
                this._answerClaudeRequest(r, 'none');
        }
    },

    // Show the head of the queue on the sticky banner. `replace` swaps the
    // banner already up. Returns whether a Claude banner is showing.
    _presentClaudeRequest(replace = false) {
        let c = this._claude;
        let r = c?.requests[0];
        if (!r || this.isExpanded || this._isExpanding || (this._peekSticky && !replace))
            return false;
        let s = [...c.sessions.values()].find(x => x.sessionId && x.sessionId === r.sessionId);
        let { title, body, exact } = describeRequest(r.req, s?.name);
        let raise = () => s && this._raiseClaudeTerminal(s.pid);
        r.shownAt = GLib.get_monotonic_time();
        let act = (label, fn) => ({ label, manualHide: true, callback: () => {
            if (GLib.get_monotonic_time() - r.shownAt >= CLICK_GUARD_US)
                fn();
        } });
        let answer = (label, kind) => act(label, () => this._answerClaudeRequest(r, kind));
        // Allow only what the banner shows in full; the rest is approved in
        // the terminal.
        let actions = exact ? [answer('Allow', 'allow')] : [act('Open terminal', raise)];
        // Only when the terminal would offer it too.
        if (exact && Array.isArray(r.req.permission_suggestions) && r.req.permission_suggestions.length)
            actions.push(answer('Always allow', 'always'));
        actions.push(answer('Deny', 'deny'));
        this._showNotificationPeek(title, body, new Gio.ThemedIcon({ name: 'dialog-warning-symbolic' }), null, actions,
            { sticky: true, onMainClick: raise });
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

        let usageCard = new St.BoxLayout({ style_class: 'nn-cc-card nn-cc-list', vertical: true, x_expand: true });
        usageCard.add_child(text('USAGE', 'nook-card-eyebrow'));
        let five = this._ccMeter(usageCard, '5-hour');
        let week = this._ccMeter(usageCard, 'Weekly');
        let resets = text('', 'nook-card-meta nn-claude-resets');
        usageCard.add_child(resets);
        panel.add_child(usageCard);

        let list = new St.BoxLayout({ style_class: 'nn-claude-list', vertical: true, x_expand: true });
        panel.add_child(list);

        this._mount(panel);
        this._claudeUi = { five, week, resets, list, sig: null, ages: [] };
        this._claudeTabShown();
    },

    // Rendered, or shown again from the kept actors.
    _claudeTabShown() {
        let c = this._claude;
        c.tabOpen = true;
        c.unseen.clear();
        this._syncClaudeMonitor();
        this._updateClaudeTab(false);
    },

    _leaveClaudeTab() {
        this._claude.tabOpen = false;
        this._syncClaudeMonitor();
    },

    _updateClaudeTab(animate = true) {
        let ui = this._claudeUi;
        if (!ui || this._destroyed)
            return;
        let c = this._claude;

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
            if (this.isExpanded && this._activeTab === 'claude' && !this._presenting)
                this._resizeToContent();
        }
        let now = Date.now();
        for (let { label, since } of ui.ages)
            label.set_text(fmtAge(now - since));
    },

    _buildClaudeRow(s, ui) {
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
        return btn;
    },
};

export function installClaude(proto) {
    for (let [name, fn] of Object.entries(ClaudeFeatures))
        proto[name] = fn;
}
