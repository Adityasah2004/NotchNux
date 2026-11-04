// The "ledge" layer: the island-style behaviour around the dashboard.
//
//   - Alerts: short, one-at-a-time system moments that grow out of the pill
//     (volume / brightness, charging, low battery, headphones, a calendar
//     heads-up) — see helpers/alerts.js for the queue rules.
//   - Hide when idle: the island tucks into the top edge while nothing is
//     live and slides back out for activity or a resting pointer.
//   - Live activities in the pill: stopwatch, and memory/CPU stats.
//   - The grid launcher (every tab and toggle) and header shortcuts.
//   - Clipboard and Lyrics tabs, Keep Awake, swipe gestures and the
//     right-click quick menu.
//
// Like tabs/productivity.js these are methods mixed into the NotchNux actor.
// Everything is event-driven; the only timers run while something they serve
// is on screen (alert expiry, the lyrics line follower, stats while enabled).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { AlertQueue, powerAlertFor } from '../helpers/alerts.js';
import { ClipboardHistory } from '../helpers/clipboard.js';
import { LyricsService, lineAt } from '../helpers/lyrics.js';
import { springTo, addPressFeedback } from '../helpers/motion.js';
import { PILL_HEIGHT } from '../helpers/island.js';
import { fmtCountdown } from '../helpers/productivity.js';
import { accentHex, accentRgbStr } from '../helpers/widgets.js';
import { logError, logDebug } from '../helpers/log.js';

// Dark-mode system colours: the surface is always black.
export const SYS = {
    orange: '#ff9f0a',
    green: '#30d158',
    red: '#ff453a',
    yellow: '#ffd60a',
    blue: '#0a84ff',
};

const ALERT_MIN_WIDTH = 360;
const ALERT_MAX_WIDTH = 520;
const ALERT_EXTRA_HEIGHT = 6;
// Tucked away: a strip along the top edge that still catches the pointer.
const TUCK_WIDTH = 200;
const TUCK_HEIGHT = 5;
const REVEAL_DWELL_MS = 350;
// How long the pill lingers after the last interaction (pointer leaving it,
// the dashboard closing, an alert ending) before it tucks away. "Idle" means
// idle — tucking the instant the pointer left made it vanish while you were
// still reaching for it.
const IDLE_TUCK_MS = 4000;
const STATS_INTERVAL_S = 2;
const EVENT_HEADS_UP_MIN = 5;
const LAUNCHER_COLS = 5;
const LONG_PRESS_MS = 480;
const CLIP_ROWS = 7;
const LYRIC_CONTEXT = 2;   // lines shown above and below the current one

// Extra launcher tiles that toggle something instead of opening a tab.
const TOGGLE_TILES = [
    { id: 'keepAwake', label: 'Keep Awake', icon: 'preferences-desktop-screensaver-symbolic' },
    { id: 'pillStats', label: 'Stats', icon: 'power-profile-performance-symbolic' },
    { id: 'autoHide', label: 'Hide Idle', icon: 'view-conceal-symbolic' },
];

function lbl(text, styleClass, props = {}) {
    let l = new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconBtn(iconName, styleClass, onClick, name = '') {
    let b = new St.Button({ style_class: styleClass, can_focus: true, reactive: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: name });
    b.set_child(new St.Icon({ icon_name: iconName, icon_size: 14 }));
    b.connect('clicked', onClick);
    addPressFeedback(b);
    return b;
}

// "2m", "3h", "Yesterday"-ish relative age for clipboard rows.
function ago(ms) {
    let s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function statColor(pct) {
    return pct < 70 ? SYS.green : pct < 90 ? SYS.yellow : SYS.red;
}

// Swap two stacked actors the island way: the old one shrinks a touch and
// fades out fast, the new one grows in from the top edge.
export function swapContent(outActor, inActor) {
    let animate = St.Settings.get().enable_animations;
    if (outActor && outActor !== inActor && outActor.visible) {
        outActor.remove_all_transitions();
        if (animate) {
            outActor.set_pivot_point(0.5, 0);
            outActor.ease({
                opacity: 0, scale_x: 0.97, scale_y: 0.97, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    outActor.visible = false;
                    outActor.opacity = 255;
                    outActor.scale_x = outActor.scale_y = 1;
                },
            });
        } else {
            outActor.visible = false;
        }
    }
    if (!inActor)
        return;
    inActor.remove_all_transitions();
    inActor.visible = true;
    if (!animate) {
        inActor.opacity = 255;
        inActor.scale_x = inActor.scale_y = 1;
        return;
    }
    inActor.set_pivot_point(0.5, 0);
    inActor.opacity = 0;
    inActor.scale_x = inActor.scale_y = 0.92;
    inActor.ease({
        opacity: 255, scale_x: 1, scale_y: 1, delay: 60, duration: 340,
        mode: Clutter.AnimationMode.EASE_OUT_QUINT,
    });
}

export const LedgeFeatures = {
    // ================================================================ lifecycle

    _initLedge() {
        this._alerts = new AlertQueue();
        this._alertShowing = false;
        this._alertTimerId = 0;
        this._tucked = false;
        this._hoverRevealed = false;
        this._revealId = 0;
        this._tuckId = 0;
        this._headsUpSeen = new Set();
        this._launcherEdit = false;
        this._focusMode = 'timer';
        this._lastTab = 'home';

        this._buildAlertBar();
        this._buildPillStopwatch();
        this._buildPillStats();
        this._buildPillAwake();
        this._installOsdHook();

        // Headphones: the system helper reports output changes after start-up.
        this._system.onOutputChanged = info => this._onOutputChanged(info);

        this._clipboard = new ClipboardHistory();
        this._clipboard.onChanged = () => this._onClipboardChanged();
        this._syncClipboardWatch();

        this._lyricsSvc = null;
        this._keepAwakeCookie = 0;
        this._keepAwakeOn = false;
        if (this._config.keepAwake)
            this._setKeepAwake(true, { persist: false });

        this._swipe = { dx: 0, dy: 0, at: 0, fired: false };
        this._scrollId = this.connect('scroll-event', (a, e) => this._onIslandScroll(e));

        this._syncPillStopwatch();
        this._syncPillStats();
        this._updateTuck({ instant: true });
    },

    _destroyLedge() {
        this._clearAlertTimer();
        this._clearTuckTimers();
        this._stopStatsTimer();
        this._stopLyricsTick();
        this._removeOsdHook();
        if (this._scrollId) {
            this.disconnect(this._scrollId);
            this._scrollId = 0;
        }
        this._pillMenu?.destroy();
        this._pillMenu = null;
        this._clipboard?.destroy();
        this._clipboard = null;
        this._lyricsSvc?.destroy();
        this._lyricsSvc = null;
        if (this._keepAwakeCookie)
            this._uninhibit(this._keepAwakeCookie);
        this._keepAwakeCookie = 0;
        if (this._system)
            this._system.onOutputChanged = null;
    },

    // Shell-side config writes also fire the file monitor; refresh the
    // snapshot so _onConfigFileChanged doesn't apply them a second time.
    _writeConfig(fn) {
        fn(this._config);
        this._configState = this._configSnapshot();
    },

    _setFeature(id, on) {
        this._writeConfig(c => c.setFeatureEnabled(id, on));
        this._onFeatureToggled(id, on);
    },

    _onLedgeFeatureToggled(id, on) {
        switch (id) {
        case 'autoHide':
            this._updateTuck();
            break;
        case 'pillStats':
            this._syncPillStats();
            this._updateTuck();
            break;
        case 'notchHud':
            if (!on && this._alerts.current?.kind === 'level')
                this._dismissAlert();
            break;
        }
        this._invalidateTab('launcher');
    },

    // ================================================================ alerts

    _buildAlertBar() {
        let bar = new St.BoxLayout({
            style_class: 'nn-alert', x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER, reactive: true, visible: false });
        this._alertIconBin = new St.Bin({ style_class: 'nn-alert-iconbin', y_align: Clutter.ActorAlign.CENTER });
        this._alertIcon = new St.Icon({ icon_size: 15 });
        this._alertIconBin.set_child(this._alertIcon);
        this._alertTitle = lbl('', 'nn-alert-title');
        let spacer = new St.Widget({ x_expand: true });
        this._alertTrack = new St.Widget({ style_class: 'nn-alert-track', y_align: Clutter.ActorAlign.CENTER });
        this._alertFill = new St.Widget({ style_class: 'nn-alert-fill' });
        this._alertTrack.add_child(this._alertFill);
        this._alertValue = lbl('', 'nn-alert-value');
        this._alertValue.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        for (let a of [this._alertIconBin, this._alertTitle, spacer, this._alertTrack, this._alertValue])
            bar.add_child(a);
        bar.connect('button-release-event', (a, e) => {
            if (e.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            let cur = this._alerts.current;
            this._dismissAlert();
            cur?.onClick?.();
            return Clutter.EVENT_STOP;
        });
        this._alertBar = bar;
        this._compactStack.add_child(bar);
    },

    // Queue an alert. Fields: kind, icon (name) | gicon, title, value (text),
    // level (0..1, shows a bar), color, ms, instant, onClick.
    _pushAlert(alert) {
        if (this._destroyed || !this._alertBar)
            return;
        if (!this._canShowAlert()) {
            // Feedback for a key press is pointless later; the rest wait.
            if (!alert.instant)
                this._alerts.defer(alert);
            return;
        }
        let r = this._alerts.enqueue(alert);
        if (r === 'replace') {
            this._paintAlert(alert);
            this._armAlertTimer();
            this._springToRest({ duration: 380, damping: 0.86 });
        } else if (r === 'show') {
            this._presentAlert();
        }
    },

    _canShowAlert() {
        return !this.isExpanded && !this._isExpanding && !this._peekActive &&
            !!this.get_stage() && !!Main.layoutManager.primaryMonitor;
    },

    _paintAlert(a) {
        let color = a.color ?? '#ffffff';
        if (a.gicon) {
            try {
                this._alertIcon.set_gicon(a.gicon);
            } catch (e) {
                this._alertIcon.icon_name = 'dialog-information-symbolic';
            }
        } else {
            this._alertIcon.icon_name = a.icon ?? 'dialog-information-symbolic';
        }
        this._alertIcon.set_style(`color: ${color};`);
        this._alertIconBin.set_style(`background-color: ${color}29;`);
        this._alertTitle.set_text(a.title ?? '');
        let hasLevel = typeof a.level === 'number';
        this._alertTrack.visible = hasLevel;
        if (hasLevel) {
            let w = 108;
            let f = Math.max(0, Math.min(1, a.level));
            this._alertFill.set_style(`background-color: ${color};`);
            this._alertFill.set_size(Math.round(w * f), 5);
        }
        this._alertValue.set_text(a.value ?? '');
        this._alertValue.visible = !!a.value;
        this._alertValue.set_style(a.valueColor ? `color: ${a.valueColor};` : null);
    },

    _presentAlert() {
        let a = this._alerts.current;
        if (!a)
            return;
        this._paintAlert(a);
        let wasShowing = this._alertShowing;
        this._alertShowing = true;
        this._clearTuckTimers();
        if (this._tucked) {
            this._tucked = false;
            this._fadeIsland(255, 160);
        }
        this._stopPillMarquee();
        this._pillEq?.stop();
        if (!wasShowing)
            swapContent(this._pill, this._alertBar);
        this._surface.add_style_class_name('nn-island-alert');
        this._springToRest({ duration: 480, damping: 0.74 });
        this._armAlertTimer();
    },

    _armAlertTimer() {
        this._clearAlertTimer();
        let a = this._alerts.current;
        if (!a)
            return;
        this._alertTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AlertQueue.durationOf(a), () => {
            this._alertTimerId = 0;
            // Let a hovered alert be read; check again shortly.
            if (this._pointerIsOverWidget() && !a.instant) {
                this._alertTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._alertTimerId = 0;
                    this._dismissAlert();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }
            this._dismissAlert();
            return GLib.SOURCE_REMOVE;
        });
    },

    _clearAlertTimer() {
        if (this._alertTimerId) {
            GLib.Source.remove(this._alertTimerId);
            this._alertTimerId = 0;
        }
    },

    // Current alert is done: show the next one, or go back to the pill.
    _dismissAlert() {
        this._clearAlertTimer();
        this._alerts.dismiss();
        if (!this._alertShowing)
            return;
        let next = this._canShowAlert() ? this._alerts.promote() : null;
        if (next) {
            this._paintAlert(next);
            swapContent(null, this._alertBar);
            this._springToRest({ duration: 420, damping: 0.8 });
            this._armAlertTimer();
            return;
        }
        this._alertShowing = false;
        this._surface.remove_style_class_name('nn-island-alert');
        swapContent(this._alertBar, this._pill);
        this._refreshLive();
        this._springToRest({ duration: 420, damping: 0.92 });
        this._updateTuck();
    },

    // The dashboard or a notification peek takes over the surface: drop the
    // showing alert (it has been seen) without animating back to the pill.
    _suspendAlert() {
        this._clearAlertTimer();
        this._alerts.dropInstant();
        this._alerts.dismiss();
        if (!this._alertShowing)
            return;
        this._alertShowing = false;
        this._surface.remove_style_class_name('nn-island-alert');
        this._alertBar.remove_all_transitions();
        this._alertBar.visible = false;
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;
        this._pill.scale_x = this._pill.scale_y = 1;
    },

    // Something that blocked alerts went away (collapse, peek hidden).
    _promoteAlert() {
        if (this._alertShowing || !this._canShowAlert() || !this._alerts.hasPending)
            return;
        if (this._alerts.promote())
            this._presentAlert();
    },

    _alertWidth() {
        let nat = 0;
        if (this._alertBar.get_stage())
            nat = this._alertBar.get_preferred_width(-1)[1] + 36;
        return Math.round(Math.min(ALERT_MAX_WIDTH, Math.max(ALERT_MIN_WIDTH, this._pillWidth(), nat)));
    },

    // ---- where the collapsed island rests right now

    _restGeometry() {
        let m = Main.layoutManager.primaryMonitor;
        let w, h;
        if (this._alertShowing) {
            w = this._alertWidth();
            h = PILL_HEIGHT + ALERT_EXTRA_HEIGHT;
        } else if (this._tucked) {
            w = TUCK_WIDTH;
            h = TUCK_HEIGHT;
        } else {
            w = this._pillWidth();
            h = PILL_HEIGHT;
        }
        return { x: m.x + Math.floor((m.width - w) / 2), y: m.y, width: w, height: h };
    },

    _springToRest(opts = {}) {
        if (this._destroyed || this.isExpanded || !this.get_stage() || !Main.layoutManager.primaryMonitor)
            return;
        springTo(this, this._restGeometry(), { duration: 420, damping: 1, ...opts });
    },

    // ---- sources

    // GNOME's centre OSD (volume, brightness, mic mute, caps lock…) shows in
    // the notch instead. OsdWindowManager.show() fans out to
    // _showOsdWindow(monitorIndex, …) on every shell version we support.
    _installOsdHook() {
        let mgr = Main.osdWindowManager;
        if (!mgr || typeof mgr._showOsdWindow !== 'function' || this._origShowOsd)
            return;
        let self = this;
        this._origShowOsd = mgr._showOsdWindow;
        mgr._showOsdWindow = function (monitorIndex, icon, label, level, maxLevel) {
            try {
                if (self._osdToNotch(monitorIndex, icon, label, level, maxLevel))
                    return undefined;
            } catch (e) {
                logError('OSD redirect failed', e);
            }
            return self._origShowOsd.call(this, monitorIndex, icon, label, level, maxLevel);
        };
    },

    _removeOsdHook() {
        if (this._origShowOsd && Main.osdWindowManager) {
            Main.osdWindowManager._showOsdWindow = this._origShowOsd;
        }
        this._origShowOsd = null;
    },

    _osdToNotch(monitorIndex, icon, label, level, maxLevel) {
        if (this._destroyed || !this._config.isFeatureEnabled('notchHud'))
            return false;
        // Another monitor (e.g. its own brightness) keeps GNOME's pop-up; the
        // open dashboard covers the notch, so it does too.
        if (monitorIndex !== Main.layoutManager.primaryIndex || !this._canShowAlert())
            return false;
        let names = [];
        try {
            names = icon?.get_names?.() ?? [];
        } catch (e) {}
        let iconName = names[0] ?? '';
        let title = label || 'Level';
        let color = '#ffffff';
        if (/audio-volume|audio-speakers|audio-headphones/.test(iconName)) {
            title = 'Volume';
        } else if (/keyboard-brightness/.test(iconName)) {
            title = 'Keyboard';
        } else if (/brightness/.test(iconName)) {
            title = 'Brightness';
            color = SYS.yellow;
        } else if (/microphone/.test(iconName)) {
            title = 'Microphone';
            color = /disabled|muted/.test(iconName) ? SYS.red : SYS.orange;
        }
        let hasLevel = typeof level === 'number' && level >= 0;
        let max = typeof maxLevel === 'number' && maxLevel > 0 ? maxLevel : 1;
        let muted = /muted/.test(iconName);
        let value = '';
        if (hasLevel)
            value = muted ? 'Muted' : `${Math.round(level * 100)}%`;
        else if (label && label !== title)
            value = label;
        this._pushAlert({
            kind: 'level', instant: true, gicon: icon, title, color,
            level: hasLevel ? (muted ? 0 : level / max) : undefined,
            value,
        });
        return true;
    },

    // UPower display device changed. Called from _hookBatteryDevice.
    _onPowerSample() {
        let dev = this._batteryDevice;
        if (!dev)
            return;
        let snap;
        try {
            // 1 charging · 4 fully charged · 5 pending charge => on AC.
            snap = {
                hasBattery: !!dev.is_present,
                level: Math.round(dev.percentage),
                onAC: [1, 4, 5].includes(dev.state),
            };
        } catch (e) {
            return;
        }
        let prev = this._powerSnap ?? null;
        this._powerSnap = snap;
        if (!this._config.isFeatureEnabled('powerAlerts'))
            return;
        let ev = powerAlertFor(prev, snap);
        if (ev?.type === 'charging') {
            this._pushAlert({ kind: 'power', icon: 'battery-full-charging-symbolic', color: SYS.green,
                title: 'Charging', value: `${snap.level}%`, valueColor: SYS.green });
        } else if (ev?.type === 'low') {
            this._pushAlert({ kind: 'power', ms: 4000,
                icon: snap.level <= 10 ? 'battery-level-10-symbolic' : 'battery-level-20-symbolic',
                color: SYS.red, title: 'Low Battery', value: `${snap.level}%`, valueColor: SYS.red });
        }
    },

    _onOutputChanged(info) {
        if (this._destroyed || !this._config.isFeatureEnabled('headphoneAlerts') || !info?.headphones)
            return;
        this._pushAlert({ kind: 'headphones',
            icon: info.bluetooth ? 'bluetooth-active-symbolic' : 'audio-headphones-symbolic',
            color: SYS.blue, title: info.name || 'Headphones', value: 'Connected' });
    },

    // Every minute (from the clock): anything starting in ~5 minutes?
    _checkEventHeadsUp() {
        if (!this._config.isFeatureEnabled('eventHeadsUp') || !this._calendarServerEvents?.size)
            return;
        let now = Date.now();
        for (let ev of this._collectCalendarEvents(1)) {
            if (ev.allDay)
                continue;
            let mins = (ev.start.getTime() - now) / 60000;
            if (mins <= 0 || mins > EVENT_HEADS_UP_MIN)
                continue;
            let key = `${ev.title}|${ev.start.getTime()}`;
            if (this._headsUpSeen.has(key))
                continue;
            this._headsUpSeen.add(key);
            let m = Math.max(1, Math.round(mins));
            this._pushAlert({ kind: 'calendar', icon: 'x-office-calendar-symbolic', color: SYS.red,
                title: ev.title || 'Event', value: `in ${m} min`,
                onClick: () => this._openTab('calendar') });
        }
        if (this._headsUpSeen.size > 200)
            this._headsUpSeen.clear();
    },

    // ================================================================ hide when idle

    _shouldTuck() {
        if (!this._config.isFeatureEnabled('autoHide'))
            return false;
        if (this.isExpanded || this._isExpanding || this._peekActive || this._alertShowing)
            return false;
        if (this._hoverRevealed || this._pointerInside || this._pillMenu?.isOpen)
            return false;
        if (this._prod?.focusActive || this._prod?.stopwatch.running)
            return false;
        if (this._musicPlaying)
            return false;
        if (this._pillMic?.visible || this._pillCam?.visible)
            return false;
        if (this._config.isFeatureEnabled('pillStats'))
            return false;
        return true;
    },

    // Bring the island back now when something needs it, or tuck it away once
    // it has sat idle for IDLE_TUCK_MS. `instant` (start-up) tucks at once.
    _updateTuck({ instant = false } = {}) {
        if (this._destroyed)
            return;
        if (this.isExpanded) {
            this._cancelIdleTuck();
            return;
        }
        let want = this._shouldTuck();
        if (!want) {
            this._cancelIdleTuck();
            if (this._tucked)
                this._setTucked(false);
            return;
        }
        if (this._tucked)
            return;
        if (instant) {
            this._setTucked(true, { instant: true });
            return;
        }
        // Restart the idle countdown on every call: each one marks activity.
        this._cancelIdleTuck();
        this._tuckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE_TUCK_MS, () => {
            this._tuckId = 0;
            if (this._destroyed || this.isExpanded || this._tucked)
                return GLib.SOURCE_REMOVE;
            // The pointer is still over the pill (a crossing can be missed
            // mid-spring): keep it and check again later.
            if (this._pointerIsOverWidget()) {
                this._updateTuck();
                return GLib.SOURCE_REMOVE;
            }
            if (this._shouldTuck())
                this._setTucked(true);
            return GLib.SOURCE_REMOVE;
        });
    },

    _cancelIdleTuck() {
        if (this._tuckId) {
            GLib.Source.remove(this._tuckId);
            this._tuckId = 0;
        }
    },

    _setTucked(want, { instant = false } = {}) {
        this._tucked = want;
        if (want) {
            this._stopPillMarquee();
            this._fadeIsland(0, instant ? 0 : 220);
            if (instant) {
                let g = Main.layoutManager.primaryMonitor ? this._restGeometry() : null;
                if (g)
                    this.set_position(g.x, g.y), this.set_size(g.width, g.height);
            } else {
                this._springToRest({ duration: 460, damping: 0.95 });
            }
        } else {
            this._fadeIsland(255, instant ? 0 : 160);
            this._springToRest({ duration: 440, damping: 0.72 });
            if (this._pillMusicBox?.visible)
                this._startPillMarquee();
        }
    },

    // Fade the visible island (surface, shoulders, glass) — the outer actor
    // stays reactive so the pointer can still find the tucked strip.
    _fadeIsland(opacity, ms) {
        let targets = [this._surface, ...(this._shoulders ?? [])];
        if (this._glass)
            targets.push(this._glass.actor);
        for (let a of targets) {
            a.remove_transition('opacity');
            if (ms > 0 && St.Settings.get().enable_animations)
                a.ease({ opacity, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            else
                a.opacity = opacity;
        }
    },

    // Pointer crossings while collapsed. Tucked: resting on the top-centre
    // strip reveals the pill. Shown: entering holds it, leaving starts the
    // idle countdown. Returns true when the crossing was consumed.
    _tuckCrossing(entering) {
        if (entering) {
            this._cancelIdleTuck();
            if (!this._tucked || this._revealId)
                return this._tucked;
            this._revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DWELL_MS, () => {
                this._revealId = 0;
                if (this._pointerIsOverWidget()) {
                    this._hoverRevealed = true;
                    this._updateTuck();
                }
                return GLib.SOURCE_REMOVE;
            });
            return true;
        }
        if (this._revealId) {
            GLib.Source.remove(this._revealId);
            this._revealId = 0;
        }
        // Pointer left the pill: from now on it is merely idle.
        this._hoverRevealed = false;
        this._updateTuck();
        return false;
    },

    _clearTuckTimers() {
        if (this._revealId) {
            GLib.Source.remove(this._revealId);
            this._revealId = 0;
        }
        this._cancelIdleTuck();
    },

    // expand() from the tucked strip: be fully visible before blooming.
    _untuckForExpand() {
        this._clearTuckTimers();
        this._hoverRevealed = false;
        if (this._tucked) {
            this._tucked = false;
            this._fadeIsland(255, 120);
        }
    },

    // ================================================================ pill activities

    _buildPillStopwatch() {
        this._pillSwBox = new St.Button({ style_class: 'nn-pill-sw', reactive: true, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER, visible: false });
        let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        row.add_child(new St.Icon({ icon_name: 'alarm-symbolic', icon_size: 13, style_class: 'nn-pill-sw-icon',
            y_align: Clutter.ActorAlign.CENTER }));
        this._pillSwLabel = new St.Label({ style_class: 'nn-pill-sw-time', y_align: Clutter.ActorAlign.CENTER });
        row.add_child(this._pillSwLabel);
        this._pillSwBox.set_child(row);
        this._pillSwBox.connect('clicked', () => {
            this._focusMode = 'stopwatch';
            this._markTabDirty('focus');
            this._openTab('focus');
        });
        this._pill.insert_child_at_index(this._pillSwBox, 1);
    },

    _syncPillStopwatch() {
        if (!this._pillSwBox || !this._prod)
            return;
        let sw = this._prod.stopwatch;
        let show = sw.running && !this._prod.focusActive;
        let changed = show !== this._pillSwBox.visible;
        this._pillSwBox.visible = show;
        if (show)
            this._pillSwLabel.set_text(fmtCountdown(sw.elapsedMs));
        if (changed) {
            this._refreshLive();
            if (!this.isExpanded && !this._alertShowing)
                this._applyPillWidth();
            this._updateTuck();
        }
    },

    _onStopwatchChanged(kind) {
        if (kind === 'sw-tick') {
            if (this._pillSwBox?.visible)
                this._pillSwLabel.set_text(fmtCountdown(this._prod.stopwatch.elapsedMs));
            if (this.isExpanded && this._activeTab === 'focus')
                this._swUi?.update();
            return;
        }
        this._syncPillStopwatch();
        if (this._invalidateTab('focus') && this._activeTab === 'focus')
            this._swUi ? this._swUi.update() : this._focusUi?.update();
    },

    _buildPillStats() {
        this._pillStatsBox = new St.BoxLayout({ style_class: 'nn-pill-stats', y_align: Clutter.ActorAlign.CENTER, visible: false });
        let mk = name => {
            let col = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'nn-pill-stat' });
            col.add_child(new St.Label({ text: name, style_class: 'nn-pill-stat-cap' }));
            let v = new St.Label({ text: '–', style_class: 'nn-pill-stat-val' });
            col.add_child(v);
            this._pillStatsBox.add_child(col);
            return v;
        };
        this._pillMemLabel = mk('MEM');
        this._pillCpuLabel = mk('CPU');
        this._pill.insert_child_at_index(this._pillStatsBox, 2);
    },

    // Stats are the lowest-priority activity: any other one replaces them.
    _syncPillStats() {
        if (!this._pillStatsBox)
            return;
        let on = this._config.isFeatureEnabled('pillStats');
        if (on)
            this._startStatsTimer();
        else
            this._stopStatsTimer();
        let show = on && !this._pillFocusBox?.visible && !this._pillSwBox?.visible && !this._pillMusicBox?.visible;
        if (show !== this._pillStatsBox.visible) {
            this._pillStatsBox.visible = show;
            if (!this.isExpanded && !this._alertShowing)
                this._applyPillWidth();
        }
    },

    _startStatsTimer() {
        if (this._statsId)
            return;
        let tick = () => {
            this._system._updateCpuUsage?.();
            let cpu = Math.round(this._system.getCpuUsage?.() ?? 0);
            let mem = Math.round(this._system.getRamUsage?.() ?? 0);
            // No animation on the numbers: a redraw every 2 s is all it costs.
            this._pillCpuLabel.set_text(`${cpu}%`);
            this._pillCpuLabel.set_style(`color: ${statColor(cpu)};`);
            this._pillMemLabel.set_text(`${mem}%`);
            this._pillMemLabel.set_style(`color: ${statColor(mem)};`);
        };
        tick();
        this._statsId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STATS_INTERVAL_S, () => {
            if (this._destroyed) {
                this._statsId = 0;
                return GLib.SOURCE_REMOVE;
            }
            // Nobody can see it while the dashboard covers the pill row… it
            // still shows there, so keep ticking; but skip while tucked.
            if (this._pillStatsBox.visible && !this._tucked)
                tick();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _stopStatsTimer() {
        if (this._statsId) {
            GLib.Source.remove(this._statsId);
            this._statsId = 0;
        }
    },

    _buildPillAwake() {
        this._pillAwake = new St.Icon({ icon_name: 'preferences-desktop-screensaver-symbolic',
            style_class: 'nn-pill-awake', icon_size: 13, visible: false, y_align: Clutter.ActorAlign.CENTER });
        this._pillPrivBox.insert_child_at_index(this._pillAwake, 0);
    },

    // ================================================================ keep awake

    _setKeepAwake(on, { persist = true } = {}) {
        on = !!on;
        this._keepAwakeOn = on;
        if (persist)
            this._writeConfig(c => c.setKeepAwake(on));
        if (on && !this._keepAwakeCookie && !this._keepAwakePending) {
            this._keepAwakePending = true;
            // 4 = suspend, 8 = idle (screen blank / lock).
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'Inhibit',
                new GLib.Variant('(susu)', ['NotchNux', 0, 'Keep Awake is on', 4 | 8]),
                new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 3000, null, (c, res) => {
                    this._keepAwakePending = false;
                    let cookie = 0;
                    try {
                        [cookie] = c.call_finish(res).deep_unpack();
                    } catch (e) {
                        logDebug('Keep Awake inhibit failed', e.message);
                        this._keepAwakeOn = false;
                        this._syncAwakeUi();
                        return;
                    }
                    if (this._destroyed || !this._keepAwakeOn)
                        this._uninhibit(cookie);
                    else
                        this._keepAwakeCookie = cookie;
                });
        } else if (!on && this._keepAwakeCookie) {
            this._uninhibit(this._keepAwakeCookie);
            this._keepAwakeCookie = 0;
        }
        this._syncAwakeUi();
    },

    _uninhibit(cookie) {
        if (!cookie)
            return;
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Uninhibit', new GLib.Variant('(u)', [cookie]),
            null, Gio.DBusCallFlags.NONE, 3000, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {}
            });
    },

    _syncAwakeUi() {
        if (this._destroyed || !this._pillAwake)
            return;
        let before = this._pillAwake.visible;
        this._pillAwake.visible = this._keepAwakeOn;
        if (before !== this._keepAwakeOn && !this.isExpanded && !this._alertShowing)
            this._applyPillWidth();
        if (this._invalidateTab('launcher'))
            this._launcherUi?.update();
    },

    // ================================================================ gestures + quick menu

    _onIslandScroll(event) {
        if (!this._config.isFeatureEnabled('swipeGestures'))
            return Clutter.EVENT_PROPAGATE;
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;
        // Open: only the pill row counts (the content below scrolls itself).
        if (this.isExpanded && !this._isDescendantOf(global.stage.get_event_actor(event), this._compactStack))
            return Clutter.EVENT_PROPAGATE;
        let [dx, dy] = event.get_scroll_delta();
        let now = GLib.get_monotonic_time();
        let s = this._swipe;
        if (now - s.at > 250000 || event.is_scroll_stop?.())
            Object.assign(s, { dx: 0, dy: 0, fired: false });
        s.at = now;
        if (s.fired)
            return Clutter.EVENT_STOP;
        s.dx += dx;
        s.dy += dy;
        const T = 2.2;
        if (!this.isExpanded && Math.abs(s.dx) > T && Math.abs(s.dx) > Math.abs(s.dy) * 1.4) {
            s.fired = true;
            let info = this._mpris.getActiveTrackInfo();
            if (!info.hasMedia)
                return Clutter.EVENT_STOP;
            let next = s.dx > 0;
            if (next) this._mpris.next();
            else this._mpris.previous();
            this._pushAlert({ kind: 'media', instant: true, ms: 1100,
                icon: next ? 'media-skip-forward-symbolic' : 'media-skip-backward-symbolic',
                title: next ? 'Next' : 'Previous', value: '' });
            return Clutter.EVENT_STOP;
        }
        if (Math.abs(s.dy) > T && Math.abs(s.dy) > Math.abs(s.dx) * 1.4) {
            s.fired = true;
            // Pull down to open, push up to close.
            if (s.dy < 0 && !this.isExpanded) {
                this._untuckForExpand();
                this.expand();
            } else if (s.dy > 0 && this.isExpanded) {
                this._collapseImmediately();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    },

    _isDescendantOf(actor, ancestor) {
        for (let a = actor; a; a = a.get_parent()) {
            if (a === ancestor)
                return true;
        }
        return false;
    },

    // Right-click: the handful of things you'd otherwise open the notch for.
    _openPillMenu() {
        this._clearHoverTimers();
        if (!this._pillMenu) {
            this._pillMenuManager = new PopupMenu.PopupMenuManager(this);
            this._pillMenu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
            this._pillMenu.actor.add_style_class_name('notchnux-power-menu');
            Main.uiGroup.add_child(this._pillMenu.actor);
            this._pillMenu.close();
            this._pillMenuManager.addMenu(this._pillMenu);
            this._pillMenu.connect('open-state-changed', (m, open) => {
                if (!open)
                    this._updateTuck();
            });
        }
        let menu = this._pillMenu;
        menu.removeAll();
        let add = (text, icon, cb) => {
            let item = new PopupMenu.PopupImageMenuItem(text, icon);
            item.connect('activate', cb);
            menu.addMenuItem(item);
        };
        let info = this._mpris.getActiveTrackInfo();
        if (info.hasMedia) {
            let playing = info.status === 'Playing';
            add(playing ? 'Pause' : 'Play', playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                () => this._mpris.playPause());
            if (info.canNext)
                add('Next Track', 'media-skip-forward-symbolic', () => this._mpris.next());
            if (info.canPrev)
                add('Previous Track', 'media-skip-backward-symbolic', () => this._mpris.previous());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        let f = this._prod.focus;
        if (f.phase !== 'idle') {
            add(f.running ? 'Pause Timer' : 'Resume Timer', f.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                () => this._prod.toggleFocus());
            add('Stop Timer', 'media-playback-stop-symbolic', () => this._prod.resetFocus());
        } else {
            add('Start Focus', 'alarm-symbolic', () => this._prod.startFocus());
        }
        let sw = this._prod.stopwatch;
        add(sw.running ? 'Pause Stopwatch' : sw.active ? 'Resume Stopwatch' : 'Start Stopwatch', 'alarm-symbolic',
            () => this._prod.toggleStopwatch());
        if (sw.active)
            add('Reset Stopwatch', 'view-refresh-symbolic', () => this._prod.resetStopwatch());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let sw1 = new PopupMenu.PopupSwitchMenuItem('Keep Awake', this._keepAwakeOn);
        sw1.connect('toggled', (i, on) => this._setKeepAwake(on));
        menu.addMenuItem(sw1);
        let sw2 = new PopupMenu.PopupSwitchMenuItem('Hide When Idle', this._config.isFeatureEnabled('autoHide'));
        sw2.connect('toggled', (i, on) => this._setFeature('autoHide', on));
        menu.addMenuItem(sw2);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add('NotchNux Settings…', 'preferences-system-symbolic', () => {
            this.collapse();
            try {
                this.extension.openPreferences();
            } catch (e) {
                logError('Failed to open preferences.', e);
            }
        });
        menu.open();
    },

    // ================================================================ launcher (grid)

    _renderLauncherTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-launcher', vertical: true, x_expand: true });
        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        let title = lbl('Everything', 'nook-section-title');
        head.add_child(title);
        head.add_child(new St.Widget({ x_expand: true }));
        let hint = lbl('', 'nook-card-meta');
        head.add_child(hint);
        let edit = new St.Button({ style_class: 'nook-chip', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        edit.connect('clicked', () => {
            this._launcherEdit = !this._launcherEdit;
            update();
        });
        addPressFeedback(edit);
        head.add_child(edit);
        panel.add_child(head);

        let grid = new St.BoxLayout({ style_class: 'nn-grid', vertical: true, x_expand: true });
        panel.add_child(grid);

        let tabs = this._tabOrder.filter(id => id !== 'home' && this._tabs[id]);
        let entries = [
            ...tabs.map(id => ({ id, label: this._tabs[id].label, icon: this._tabs[id].icon, tab: true })),
            ...TOGGLE_TILES.map(t => ({ ...t, tab: false })),
        ];
        let tiles = [];
        let row = null;
        entries.forEach((e, i) => {
            if (i % LAUNCHER_COLS === 0) {
                row = new St.BoxLayout({ style_class: 'nn-grid-row', x_expand: true });
                grid.add_child(row);
            }
            let tile = new St.Button({ style_class: 'nn-tile', can_focus: true, reactive: true,
                accessible_name: e.label });
            let col = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
            let iconStack = new St.Widget({ layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER });
            let iconBin = new St.Bin({ style_class: 'nn-tile-icon' });
            iconBin.set_child(new St.Icon({ icon_name: e.icon, icon_size: 20 }));
            iconStack.add_child(iconBin);
            // Nudged past the icon's corner with a transform: a negative CSS
            // margin makes St report a negative (wrapped) preferred height.
            let badge = new St.Bin({ style_class: 'nn-tile-badge', x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START, visible: false, translation_x: 8, translation_y: -6 });
            let badgeIcon = new St.Icon({ icon_size: 9 });
            badge.set_child(badgeIcon);
            iconStack.add_child(badge);
            col.add_child(iconStack);
            let name = new St.Label({ text: e.label, style_class: 'nn-tile-label', x_align: Clutter.ActorAlign.CENTER });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            col.add_child(name);
            tile.set_child(col);
            addPressFeedback(tile, 0.94);
            // Hold a tile to start picking shortcuts.
            let holdId = 0;
            tile.connect('notify::pressed', () => {
                if (holdId) {
                    GLib.Source.remove(holdId);
                    holdId = 0;
                }
                if (tile.pressed && e.tab && !this._launcherEdit) {
                    holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                        holdId = 0;
                        this._launcherEdit = true;
                        tile._heldIntoEdit = true;
                        update();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
            tile.connect('destroy', () => {
                if (holdId)
                    GLib.Source.remove(holdId);
            });
            tile.connect('clicked', () => {
                if (tile._heldIntoEdit) {
                    tile._heldIntoEdit = false;
                    return;
                }
                this._onTileClicked(e);
                update();
            });
            row.add_child(tile);
            tiles.push({ e, tile, iconBin, badge, badgeIcon });
        });
        // Pad the last row so tiles keep their width.
        while (row && row.get_n_children() < LAUNCHER_COLS)
            row.add_child(new St.Widget({ style_class: 'nn-tile nn-tile-ghost' }));

        let update = () => {
            let pinned = this._config.pinnedTabs;
            let rgb = accentRgbStr();
            edit.label = this._launcherEdit ? 'Done' : 'Edit';
            edit.set_style(this._launcherEdit ? `background-color: ${accentHex()}; color: #000;` : null);
            let max = this._config.pinnedMax;
            hint.set_text(this._launcherEdit ? `Shortcuts beside Home · ${pinned.length}/${max}` : 'Hold a tile to pick shortcuts');
            for (let t of tiles) {
                let on = t.e.tab ? pinned.includes(t.e.id) : this._toggleTileOn(t.e.id);
                if (t.e.tab) {
                    let showBadge = this._launcherEdit || on;
                    t.badge.visible = showBadge;
                    t.badgeIcon.icon_name = on ? 'object-select-symbolic' : 'list-add-symbolic';
                    t.badge.set_style(on ? `background-color: ${accentHex()}; color: #000;` : null);
                    t.iconBin.set_style(this._launcherEdit && on ? `border-color: rgba(${rgb}, 0.7);` : null);
                    t.tile.opacity = this._launcherEdit && !on && pinned.length >= max ? 120 : 255;
                    if (t.e.id === 'notifications') {
                        let n = 0;
                        try {
                            n = this._collectNotifications().length;
                        } catch (err) {}
                        if (!this._launcherEdit && n > 0) {
                            t.badge.visible = true;
                            t.badgeIcon.visible = false;
                            t.badge.set_child(new St.Label({ text: n > 99 ? '99+' : String(n), style_class: 'nn-tile-count' }));
                        }
                    }
                } else {
                    t.badge.visible = false;
                    t.iconBin.set_style(on ? `background-color: rgba(${rgb}, 0.22); color: ${accentHex()};` : null);
                    t.tile.opacity = this._launcherEdit ? 110 : 255;
                }
            }
        };
        this._mount(panel);
        this._launcherUi = { update };
        update();
    },

    _toggleTileOn(id) {
        if (id === 'keepAwake')
            return this._keepAwakeOn;
        return this._config.isFeatureEnabled(id);
    },

    _onTileClicked(e) {
        if (!e.tab) {
            if (this._launcherEdit)
                return;
            if (e.id === 'keepAwake')
                this._setKeepAwake(!this._keepAwakeOn);
            else
                this._setFeature(e.id, !this._config.isFeatureEnabled(e.id));
            return;
        }
        if (!this._launcherEdit) {
            this._switchTab(e.id);
            return;
        }
        let pinned = this._config.pinnedTabs;
        if (pinned.includes(e.id))
            pinned = pinned.filter(id => id !== e.id);
        else if (pinned.length < this._config.pinnedMax)
            pinned = [...pinned, e.id];
        else
            return;
        this._writeConfig(c => c.setPinnedTabs(pinned));
        this._syncRail();
    },

    // Header grid button: open the grid, or go back to where you were.
    _toggleLauncher() {
        if (this._activeTab === 'launcher') {
            this._launcherEdit = false;
            this._switchTab(this._tabOrder.includes(this._lastTab) ? this._lastTab : this._tabOrder[0]);
        } else {
            this._switchTab('launcher');
        }
    },

    // ================================================================ clipboard

    _syncClipboardWatch() {
        if (!this._clipboard)
            return;
        if (this._tabOrder.includes('clipboard'))
            this._clipboard.start();
        else if (this._clipboard.running)
            this._clipboard.stop();
    },

    _onClipboardChanged() {
        if (this._destroyed)
            return;
        if (this._invalidateTab('clipboard') && this._activeTab === 'clipboard')
            this._clipUi?.fill();
    },

    _renderClipboardTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-clip', vertical: true, x_expand: true });
        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(lbl('Clipboard', 'nook-section-title'));
        let search = new St.Entry({ style_class: 'nook-input nook-input-compact nn-clip-search', hint_text: 'Search',
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        search.set_primary_icon(new St.Icon({ icon_name: 'system-search-symbolic', icon_size: 13, style_class: 'nn-search-icon' }));
        this._makeTypable(search);
        head.add_child(search);
        let clear = new St.Button({ style_class: 'nook-chip', label: 'Clear', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        clear.connect('clicked', () => this._clipboard.clear());
        addPressFeedback(clear);
        head.add_child(clear);
        panel.add_child(head);

        let list = new St.BoxLayout({ style_class: 'nn-clip-list', vertical: true, x_expand: true });
        panel.add_child(list);
        let foot = lbl('', 'nook-card-meta');
        panel.add_child(foot);

        let fill = () => {
            list.destroy_all_children();
            let q = search.get_text().trim().toLowerCase();
            let items = this._clipboard.items;
            let shown = items
                .filter(i => !q || i.text.toLowerCase().includes(q))
                .sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at))
                .slice(0, CLIP_ROWS);
            if (shown.length === 0) {
                let empty = new St.BoxLayout({ style_class: 'nook-empty', vertical: true, x_expand: true });
                empty.add_child(new St.Icon({ icon_name: 'edit-paste-symbolic', icon_size: 22, style_class: 'nook-dim', x_align: Clutter.ActorAlign.CENTER }));
                empty.add_child(new St.Label({ text: q ? 'No matches' : 'Nothing copied yet', style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
                empty.add_child(new St.Label({ text: q ? 'Try another word.' : 'Copy some text and it shows up here. Passwords are skipped.',
                    style_class: 'nook-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
                list.add_child(empty);
            }
            for (let item of shown)
                list.add_child(this._buildClipRow(item));
            let pinned = items.filter(i => i.pinned).length;
            foot.set_text(`${items.length - pinned} recent · ${pinned} pinned · only pinned clips are saved`);
            if (this.isExpanded && this._activeTab === 'clipboard')
                this._resizeToContent();
        };
        search.clutter_text.connect('text-changed', () => fill());
        this._mount(panel);
        this._clipUi = { fill };
        fill();
    },

    _buildClipRow(item) {
        let row = new St.BoxLayout({ style_class: 'nn-clip-row', x_expand: true, reactive: true, track_hover: true });
        let main = new St.Button({ style_class: 'nn-clip-main', x_expand: true, can_focus: true });
        let col = new St.BoxLayout({ vertical: true, x_expand: true });
        let text = lbl(item.text.replace(/\s+/g, ' ').trim().slice(0, 300), 'nn-clip-text');
        let meta = lbl([item.app, ago(item.at)].filter(Boolean).join(' · '), 'nook-card-meta');
        col.add_child(text);
        col.add_child(meta);
        main.set_child(col);
        main.connect('clicked', () => {
            if (!this._clipboard.copy(item.id))
                return;
            meta.set_text('Copied');
            meta.set_style(`color: ${SYS.green};`);
        });
        row.add_child(main);
        let pin = iconBtn(item.pinned ? 'view-pin-symbolic' : 'view-pin-symbolic', 'nook-mini-btn nn-clip-pin',
            () => this._clipboard.togglePin(item.id), item.pinned ? 'Unpin' : 'Pin');
        if (item.pinned)
            pin.set_style(`color: ${accentHex()}; background-color: rgba(${accentRgbStr()}, 0.16);`);
        row.add_child(pin);
        row.add_child(iconBtn('window-close-symbolic', 'nook-mini-btn', () => this._clipboard.remove(item.id), 'Remove'));
        return row;
    },

    // ================================================================ lyrics

    // The lyrics view that lives inside the Music tab (see _renderMediaTab).
    // A fixed-height window of LYRIC_CONTEXT*2+1 lines, so following the song
    // never resizes the notch. Returns the actor; state goes in _lyricsUi.
    _buildLyricsBlock(badge) {
        let block = new St.Widget({ style_class: 'nn-lyrics', layout_manager: new Clutter.BinLayout(),
            x_expand: true, clip_to_allocation: true });
        let body = new St.BoxLayout({ style_class: 'nn-lyrics-body', vertical: true, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER });
        block.add_child(body);
        let lines = [];
        for (let i = 0; i < LYRIC_CONTEXT * 2 + 1; i++) {
            let d = Math.abs(i - LYRIC_CONTEXT);
            let l = new St.Label({ style_class: d === 0 ? 'nn-lyric nn-lyric-now' : `nn-lyric nn-lyric-d${d}`,
                x_align: Clutter.ActorAlign.CENTER, x_expand: true });
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            body.add_child(l);
            lines.push(l);
        }
        // Untimed lyrics and status messages: a scrollable text column.
        let plainView = new St.ScrollView({ style_class: 'nn-lyrics-plain', x_expand: true, y_expand: true,
            visible: false, overlay_scrollbars: true });
        plainView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        let plainBox = new St.BoxLayout({ vertical: true, x_expand: true });
        let plain = new St.Label({ style_class: 'nn-lyrics-plain-text', x_expand: true });
        plain.clutter_text.line_wrap = true;
        plain.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        plainBox.add_child(plain);
        plainView.set_child(plainBox);
        block.add_child(plainView);
        let note = new St.Label({ style_class: 'nn-lyrics-note', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END, x_expand: true });
        block.add_child(note);

        let state = { key: null, result: undefined, idx: -2 };
        let setMessage = (title, sub = '') => {
            body.visible = true;
            plainView.visible = false;
            lines.forEach(l => l.set_text(''));
            lines[LYRIC_CONTEXT].set_text(title);
            lines[LYRIC_CONTEXT].add_style_class_name('nn-lyric-msg');
            note.set_text(sub);
            note.visible = !!sub;
            badge.set_text('');
            badge.visible = false;
            state.idx = -2;
        };
        // One line step = the block scrolls up by a line and the new current
        // line brightens. Transform + opacity only, so it never relayouts.
        let step = 0;
        let paintLine = idx => {
            let synced = state.result?.synced;
            if (!synced || idx === state.idx)
                return;
            let forward = idx === state.idx + 1;
            state.idx = idx;
            lines[LYRIC_CONTEXT].remove_style_class_name('nn-lyric-msg');
            for (let i = 0; i < lines.length; i++) {
                let k = idx - LYRIC_CONTEXT + i;
                let t = k >= 0 && k < synced.length ? synced[k].text : '';
                lines[i].set_text(i === LYRIC_CONTEXT && !t && k >= 0 ? '♪' : t);
            }
            if (!St.Settings.get().enable_animations || !this._lyricsOnScreen())
                return;
            step ||= Math.max(16, Math.round(lines[1].get_preferred_height(-1)[1] + 6));
            let now = lines[LYRIC_CONTEXT];
            body.remove_transition('translation-y');
            now.remove_transition('opacity');
            // A seek or the first paint just fades; only a real next line scrolls.
            body.translation_y = forward ? step : 0;
            now.opacity = forward ? 110 : 0;
            body.ease({ translation_y: 0, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_EXPO });
            now.ease({ opacity: 255, duration: 280, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        };
        let onTrack = info => {
            if (!info.hasMedia) {
                state.key = null;
                this._stopLyricsTick();
                setMessage('Play something to see its lyrics');
                return;
            }
            let key = `${info.artist}|${info.title}`;
            if (key === state.key) {
                this._syncLyricsTick(info);
                return;
            }
            state.key = key;
            state.result = undefined;
            this._stopLyricsTick();
            let online = this._config.isFeatureEnabled('lyricsOnline');
            setMessage(online ? 'Looking up lyrics…' : 'Lyrics are off',
                online ? '' : 'Turn on “Look up lyrics online” in Settings.');
            this._lyricsSvc ??= new LyricsService();
            this._lyricsSvc.lookup(info, online, result => {
                if (this._destroyed || state.key !== key || this._lyricsUi?.state !== state)
                    return;
                state.result = result;
                if (!result) {
                    setMessage('No lyrics for this song', online ? '' : 'Turn on “Look up lyrics online” in Settings.');
                } else if (result.synced) {
                    note.visible = false;
                    badge.set_text('SYNCED');
                    badge.visible = true;
                    state.idx = -2;
                    this._syncLyricsTick(this._mpris.getActiveTrackInfo(), true);
                } else {
                    body.visible = false;
                    note.visible = false;
                    plain.set_text(result.plain.split(/\r?\n/).map(s => s.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim());
                    plainView.visible = true;
                    plainView.vadjustment.value = 0;
                    badge.set_text('NOT TIMED');
                    badge.visible = true;
                }
            });
        };
        this._lyricsUi = { onTrack, paintLine, state };
        return block;
    },

    // The lyrics button only appears for songs that actually have lyrics.
    // Called from _updateMediaTab on every refresh; does work only when the
    // track changes. While the lookup is in flight the button stays hidden
    // (unless the lyrics view is already up, so it can still be closed). A song
    // without lyrics drops back to the player view without forgetting the
    // preference: the next song that has lyrics opens straight into them.
    _syncLyricsAvailability(info) {
        let ui = this._mediaUi;
        if (!ui)
            return;
        let key = info.hasMedia ? `${info.artist}|${info.title}|${info.album ?? ''}` : null;
        if (key === ui.lyricsKey)
            return;
        ui.lyricsKey = key;
        let animate = ui.lyricsBtn.btn.mapped;
        if (!key) {
            this._setLyricsButtonShown(false, animate);
            return;
        }
        let answered = false;
        let online = this._config.isFeatureEnabled('lyricsOnline');
        this._lyricsSvc ??= new LyricsService();
        this._lyricsSvc.lookup(info, online, result => {
            answered = true;
            if (this._destroyed || this._mediaUi !== ui || ui.lyricsKey !== key)
                return;
            let has = !!result;
            this._setLyricsButtonShown(has, animate);
            if (!has && ui.lyricsOn) {
                this._applyMusicView(false, animate);
                this._stopLyricsTick();
            } else if (has && !ui.lyricsOn && this._config.musicLyrics) {
                this._applyMusicView(true, animate);
                this._lyricsUi?.onTrack(this._mpris.getActiveTrackInfo());
            }
        });
        if (!answered)
            this._setLyricsButtonShown(ui.lyricsOn, animate);
    },

    _setLyricsButtonShown(show, animate) {
        let btn = this._mediaUi?.lyricsBtn.btn;
        if (!btn)
            return;
        btn.remove_transition('opacity');
        btn.remove_transition('scale-x');
        btn.remove_transition('scale-y');
        if (show === btn.visible && btn.opacity === 255)
            return;
        btn.set_pivot_point(0.5, 0.5);
        if (!show) {
            btn.visible = false;
            return;
        }
        btn.visible = true;
        if (!animate || !St.Settings.get().enable_animations) {
            btn.opacity = 255;
            btn.scale_x = btn.scale_y = 1;
            return;
        }
        btn.opacity = 0;
        btn.scale_x = btn.scale_y = 0.6;
        btn.ease({ opacity: 255, scale_x: 1, scale_y: 1, duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_BACK });
    },

    _lyricsOnScreen() {
        return this.isExpanded && this._activeTab === 'media' && !!this._mediaUi?.lyricsOn;
    },

    // Follow the song: re-read the player position every 2 s and extrapolate
    // in between; repaint only when the line changes. Runs only while the tab
    // is on screen and the track is playing.
    _syncLyricsTick(info, force = false) {
        let ui = this._lyricsUi;
        if (!ui?.state.result?.synced || !this._lyricsOnScreen()) {
            this._stopLyricsTick();
            return;
        }
        let playing = info.status === 'Playing';
        let sample = () => this._mpris.getPositionAsync(pos => {
            if (this._lyricsUi !== ui)
                return;
            ui.posUs = pos;
            ui.posAt = GLib.get_monotonic_time();
            ui.playing = playing;
            ui.paintLine(lineAt(ui.state.result.synced, pos / 1000 + 150));
        });
        if (force || !this._lyricsTickId)
            sample();
        if (!playing) {
            this._stopLyricsTick();
            return;
        }
        if (this._lyricsTickId)
            return;
        let n = 0;
        this._lyricsTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (this._destroyed || this._lyricsUi !== ui) {
                this._lyricsTickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (++n % 8 === 0) {
                sample();
            } else if (ui.posAt) {
                let est = ui.posUs + (GLib.get_monotonic_time() - ui.posAt);
                ui.paintLine(lineAt(ui.state.result.synced, est / 1000 + 150));
            }
            return GLib.SOURCE_CONTINUE;
        });
    },

    _stopLyricsTick() {
        if (this._lyricsTickId) {
            GLib.Source.remove(this._lyricsTickId);
            this._lyricsTickId = 0;
        }
    },

    // ================================================================ stopwatch (Focus tab)

    // Timer | Stopwatch switch shown at the top of the Focus tab.
    _buildFocusModeSwitch() {
        let seg = new St.BoxLayout({ style_class: 'nook-segmented', y_align: Clutter.ActorAlign.CENTER });
        for (let [mode, text] of [['timer', 'Timer'], ['stopwatch', 'Stopwatch']]) {
            let b = new St.Button({ style_class: 'nook-segment', label: text, can_focus: true });
            if (mode === this._focusMode)
                b.add_style_class_name('nook-segment-active');
            b.connect('clicked', () => {
                if (this._focusMode === mode)
                    return;
                this._focusMode = mode;
                this._renderActiveTab();
            });
            seg.add_child(b);
        }
        return seg;
    },

    _renderStopwatchPanel() {
        this._focusUi = null;
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-focus nn-sw', vertical: true, x_expand: true });
        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(this._buildFocusModeSwitch());
        head.add_child(new St.Widget({ x_expand: true }));
        panel.add_child(head);

        let body = new St.BoxLayout({ style_class: 'nn-sw-body', x_expand: true });
        let time = new St.Label({ style_class: 'nn-sw-time', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        body.add_child(time);
        let controls = new St.BoxLayout({ style_class: 'nook-focus-controls', y_align: Clutter.ActorAlign.CENTER });
        let reset = iconBtn('view-refresh-symbolic', 'nook-round-btn', () => this._prod.resetStopwatch(), 'Reset');
        let main = new St.Button({ style_class: 'nook-focus-main', can_focus: true });
        let mainRow = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        let mainIcon = new St.Icon({ icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        let mainLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        mainRow.add_child(mainIcon);
        mainRow.add_child(mainLabel);
        main.set_child(mainRow);
        main.connect('clicked', () => this._prod.toggleStopwatch());
        addPressFeedback(main);
        let lap = iconBtn('view-pin-symbolic', 'nook-round-btn', () => this._prod.lapStopwatch(), 'Lap');
        controls.add_child(reset);
        controls.add_child(main);
        controls.add_child(lap);
        body.add_child(controls);
        panel.add_child(body);

        let laps = new St.BoxLayout({ style_class: 'nn-sw-laps', vertical: true, x_expand: true });
        panel.add_child(laps);

        let lapSig = '';
        let update = () => {
            let sw = this._prod.stopwatch;
            time.set_text(fmtCountdown(sw.elapsedMs));
            time.set_style(sw.running ? `color: ${SYS.orange};` : null);
            mainIcon.icon_name = sw.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            mainLabel.set_text(sw.running ? 'Pause' : sw.active ? 'Resume' : 'Start');
            main.set_style(`background-color: ${SYS.orange}; color: #000;`);
            reset.reactive = sw.active;
            reset.opacity = sw.active ? 255 : 90;
            lap.reactive = sw.running;
            lap.opacity = sw.running ? 255 : 90;
            let sig = sw.laps.join(',');
            if (sig !== lapSig) {
                lapSig = sig;
                laps.destroy_all_children();
                sw.laps.slice(0, 4).forEach((ms, i) => {
                    let r = new St.BoxLayout({ style_class: 'nn-sw-lap', x_expand: true });
                    r.add_child(lbl(`Lap ${sw.laps.length - i}`, 'nook-dim'));
                    r.add_child(new St.Widget({ x_expand: true }));
                    let prev = sw.laps[i + 1] ?? 0;
                    r.add_child(lbl(`+${fmtCountdown(ms - prev)}`, 'nn-sw-lap-delta'));
                    r.add_child(lbl(fmtCountdown(ms), 'nn-sw-lap-time'));
                    laps.add_child(r);
                });
                laps.visible = sw.laps.length > 0;
                if (this.isExpanded && this._activeTab === 'focus')
                    this._resizeToContent();
            }
        };
        this._mount(panel);
        this._swUi = { update };
        update();
    },
};

export function installLedge(proto) {
    for (let [name, fn] of Object.entries(LedgeFeatures))
        proto[name] = fn;
}

