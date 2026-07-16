import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { SystemHelper } from './helpers/system.js';
import { MprisHelper } from './helpers/mpris.js';
import { WeatherHelper } from './helpers/weather.js';
import { MediaHelper } from './helpers/media.js';
import { ShelfHelper } from './helpers/shelf.js';
import { Vinyl, AlbumArtDisc, Knob, RingMeter, AnalogClock, EqBars, CameraView, ACCENT, AMBER, setAccent, accentHex, accentRgbStr } from './helpers/widgets.js';
import { ConfigStore, TAB_DEFS, FEATURE_DEFS } from './helpers/config.js';

// Configuration constants
// Minimum idle width. _pillWidth() measures the actual content (clock + battery
// + privacy dots) and grows past this when the clock string is long, so the
// time never has to ellipsize into "3:...". This is just the floor so a short
// clock still gets a comfortably wide pill.
const PILL_WIDTH = 260;
// Minimum width while a track is playing (title zone present). Same deal:
// content measurement can push wider, this is the floor.
const PILL_WIDTH_MUSIC = 340;
const PILL_HEIGHT = 40;

// 12-hour clock with an explicit AM/PM marker (e.g. "5:04 PM"). Forcing
// hour12 keeps the format stable regardless of the user's locale, so the pill
// is sized once and never clips the meridiem.
const PILL_TIME_FMT = { hour: 'numeric', minute: '2-digit', hour12: true };
// Weekday + day-of-month prefix shown before the time (e.g. "Thu, 19"). Kept
// short so the whole clock stays compact and comfortably centered in the pill.
const PILL_DATE_FMT = { weekday: 'short', day: 'numeric' };
// Compose the full pill clock text: "Thu, 19  ·  3:19 PM".
function pillClockText(date) {
    return `${date.toLocaleDateString([], PILL_DATE_FMT)}  ·  ${date.toLocaleTimeString([], PILL_TIME_FMT)}`;
}
// Dashboard width is fixed for a stable, centered card; height is measured
// from the active tab's content so each tab is only as tall as it needs.
// Widened to match the "Nook" concept's 560px glass panel proportions.
const DASHBOARD_WIDTH = 560;
const DASHBOARD_MIN_HEIGHT = 150;

// Transient "peek" banner shown when a notification arrives: the pill grows
// into a compact two-line card (icon + title + body), then auto-collapses.
const PEEK_WIDTH = 420;
const PEEK_HEIGHT = 72;
const PEEK_DISMISS_MS = 5000;   // auto-collapse after this idle time
const PEEK_ENTER_MS = 340;
const PEEK_LEAVE_MS = 280;

export const NotchNux = GObject.registerClass({
    GTypeName: 'NotchNux' }, class NotchNux extends St.Widget {
    _init(extension) {
        // Outer widget is a transparent positioning shell. All visible
        // surface (background/border/rounded corners) lives on the inner
        // `_surface` box, so nothing bleeds into the rectangular corners.
        super._init({
            name: 'NotchNux',
            reactive: true,
            layout_manager: new Clutter.BinLayout() });

        this.extension = extension;
        // Load persisted preferences and apply the accent colour before any
        // Cairo widget draws, so the very first render uses the user's colour.
        this._config = new ConfigStore();
        setAccent(this._config.accentRgb);
        this.isExpanded = false;
        this._isExpanding = false;
        this._pointerInside = false;
        this._activeTab = 'media';
        this._selectedCalendarDate = new Date();
        this._selectedCalendarDate.setHours(0, 0, 0, 0);
        this._calendarServerEvents = new Map();
        this._calendarServerSignalIds = [];
        this._lastCalendarRequestKey = '';
        this._lastTabScrollAt = 0;
        this._lastCalendarDateScrollAt = 0;
        // Rapid date-strip scrolling is coalesced: ticks accumulate into
        // _pendingCalendarDateDelta and a single re-render + calendar request
        // fires once the flurry settles, instead of one per wheel tick.
        this._pendingCalendarDateDelta = 0;
        this._calendarScrollFlushId = 0;
        this._collapseTimeoutId = null;
        this._expandTimeoutId = null;
        this._weatherRefreshId = null;
        // Media timeline scrubber state. _timelineTickId drives the 1s progress
        // tick; the rest cache the current track's timing so scroll-to-seek and
        // the ticking readout don't have to re-query D-Bus every frame.
        this._timelineTickId = 0;
        this._timelinePosUs = 0;
        this._timelineLenUs = 0;
        this._timelineTrackId = null;
        this._lastTimelineScrollAt = 0;
        // Studio tab: MediaHelper is created lazily on first open. Track the
        // open device pickers so they can be torn down on tab switch.
        this._media = null;
        this._studioMenus = [];
        this._studioPreviewIdle = 0;
        this._selectedCam = null;
        this._selectedMic = null;
        this._artSession = new Soup.Session({ timeout: 15 });
        this._artCache = new Map();
        this._artPending = new Map();
        this._artCacheDir = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'notchnux', 'art']));
        try {
            this._artCacheDir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.error('NotchNux: Failed to create album art cache dir', e);
        }

        // Initialize helper modules
        this._system = new SystemHelper();
        this._mpris = new MprisHelper();
        this._weather = new WeatherHelper();
        // The shelf is scratch space: wipe whatever survived the last session
        // so each shell start begins with an empty holding area.
        this._shelf = new ShelfHelper();
        this._shelf.clearShelf();

        // Inner rounded surface — this is what the user sees.
        this._surface = new St.BoxLayout({
            style_class: 'notchnux-island',
            x_expand: true,
            y_expand: true,
            vertical: true });
        this.add_child(this._surface);

        // 1. Collapsed pill
        this._buildPill();
        // 2. Expanded dashboard
        this._buildDashboard();
        // 3. Transient notification-peek banner
        this._buildNotifBanner();

        this._surface.add_child(this._pill);
        this._surface.add_child(this._dashboard);
        this._surface.add_child(this._notifBanner);

        this._dashboard.visible = false;
        this._notifBanner.visible = false;
        // Recolour the active-state chrome to match the persisted accent.
        this._applyAccentStyles();
        this.set_size(PILL_WIDTH, PILL_HEIGHT);

        // Hover + click on the widget
        this.connect('enter-event', (a, e) => this._onCrossing(e, true));
        this.connect('leave-event', (a, e) => this._onCrossing(e, false));
        this.connect('button-press-event', (a, e) => this._onClicked(e));

        // Click anywhere else on the stage collapses the dashboard.
        this._stageClickId = global.stage.connect('button-press-event', (s, e) => this._onStageClicked(e));

        // Helper callbacks refresh the live tab
        this._mpris.onMetadataChanged = () => this._refreshLive();
        this._mpris.onPlaybackChanged = () => this._refreshLive();
        this._system.onVolumeChanged = () => this._refreshLive();
        this._weather.onWeatherUpdated = () => this._refreshLive();
        // Mic mute + mic/camera in-use changes repaint the pill indicators.
        this._system.onMicChanged = () => this._updatePrivacyIndicators();
        this._system.onPrivacyChanged = () => this._updatePrivacyIndicators();

        if (this._config.isFeatureEnabled('calendarSync'))
            this._initCalendarServer();
        this._initNotificationWatch();
        this._startClock();
        if (this._config.isFeatureEnabled('weatherAutoRefresh'))
            this._startWeatherRefresh();
        this._weather.updateWeather();
        // Reflect any already-playing media in the pill right away, rather
        // than waiting for the next MPRIS property-change callback.
        this._refreshLive();
        this._updatePrivacyIndicators();

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this.reposition());
        this.reposition();

        // Watch the config file so edits made in the separate prefs.js process
        // apply to the live notch without a shell restart.
        this._watchConfig();
    }

    // Snapshot of the config values the shell reacts to, used to diff against
    // the file after prefs.js writes it (so we only re-apply what changed).
    _configSnapshot() {
        let features = {};
        for (let f of FEATURE_DEFS)
            features[f.id] = this._config.isFeatureEnabled(f.id);
        return {
            accent: this._config.accent,
            tabsKey: JSON.stringify(this._config.visibleTabs),
            features,
        };
    }

    // Monitor ~/.config/notchnux/config.json for external writes (from the
    // prefs window) and re-apply accent / tabs / feature changes live.
    _watchConfig() {
        this._configState = this._configSnapshot();
        try {
            let file = Gio.File.new_for_path(this._config.path);
            this._configMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._configMonitorId = this._configMonitor.connect('changed', (m, f, other, evtType) => {
                // replace_contents() renames a temp file over the target, so the
                // meaningful signal is CHANGES_DONE_HINT / CREATED. Coalesce a
                // burst of events into one deferred reload.
                if (evtType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    evtType !== Gio.FileMonitorEvent.CREATED &&
                    evtType !== Gio.FileMonitorEvent.CHANGED)
                    return;
                if (this._configReloadId)
                    GLib.Source.remove(this._configReloadId);
                this._configReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                    this._configReloadId = 0;
                    this._onConfigFileChanged();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.error('NotchNux: Failed to watch config file.', e);
        }
    }

    // Re-read config from disk and apply whatever changed since the last
    // snapshot. Kept diff-based so an accent tweak doesn't needlessly rebuild
    // the whole dashboard, and a tab toggle doesn't repaint unrelated chrome.
    _onConfigFileChanged() {
        let prev = this._configState;
        this._config.reload();
        let next = this._configSnapshot();
        this._configState = next;

        if (next.accent !== prev.accent) {
            setAccent(this._config.accentRgb);
            this._applyAccentStyles();
        }

        // Feature toggles: run the same live-apply logic the in-notch panel used.
        for (let f of FEATURE_DEFS) {
            if (next.features[f.id] !== prev.features[f.id])
                this._onFeatureToggled(f.id, next.features[f.id]);
        }

        // Tab order / enabled set changed: rebuild the carousel. This also
        // re-reads visibleTabs, so it must run after reload().
        if (next.tabsKey !== prev.tabsKey) {
            this._tabOrder = this._config.visibleTabs;
            this._rebuildDashboard();
        }
    }

    destroy() {
        this._stopClock();
        this._stopWeatherRefresh();
        this._stopSystemRefresh();
        this._stopMediaAnimations();
        this._stopPillMarquee();
        if (this._pillEq) this._pillEq.stop();
        this._destroyCalendarServer();
        this._teardownStudio();
        if (this._media) { this._media.destroy(); this._media = null; }
        this._system.destroy();
        this._mpris.destroy();
        if (this._artSession) {
            this._artSession.abort();
            this._artSession = null;
        }
        this._artPending.clear();
        this._artCache.clear();

        this._teardownNotificationWatch();
        if (this._configMonitor) {
            if (this._configMonitorId)
                this._configMonitor.disconnect(this._configMonitorId);
            this._configMonitor.cancel();
            this._configMonitor = null;
            this._configMonitorId = 0;
        }
        if (this._stageClickId) {
            global.stage.disconnect(this._stageClickId);
            this._stageClickId = null;
        }
        this._clearTimers();
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
        }
        super.destroy();
    }

    _clearTimers() {
        if (this._collapseTimeoutId) {
            GLib.Source.remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
        if (this._expandTimeoutId) {
            GLib.Source.remove(this._expandTimeoutId);
            this._expandTimeoutId = null;
        }
        if (this._calendarScrollFlushId) {
            GLib.Source.remove(this._calendarScrollFlushId);
            this._calendarScrollFlushId = 0;
        }
        if (this._shareStatusId) {
            GLib.Source.remove(this._shareStatusId);
            this._shareStatusId = 0;
        }
        if (this._peekDismissId) {
            GLib.Source.remove(this._peekDismissId);
            this._peekDismissId = 0;
        }
        if (this._configReloadId) {
            GLib.Source.remove(this._configReloadId);
            this._configReloadId = 0;
        }
        if (this._tabScrollFrameId) {
            GLib.Source.remove(this._tabScrollFrameId);
            this._tabScrollFrameId = 0;
        }
    }

    reposition() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let width = this.isExpanded ? DASHBOARD_WIDTH : this._pillWidth();
        this.set_position(monitor.x + Math.floor((monitor.width - width) / 2), monitor.y);
    }

    // Measure how tall the currently-rendered dashboard wants to be at the
    // fixed dashboard width, so each tab animates to its own natural height.
    _measureDashboardHeight() {
        // Measure at exactly the dashboard width. (The carousel header can want
        // to be wider than the card, so don't let its preferred width inflate
        // the measuring width — that would under-report the content height.)
        let [, natHeight] = this._dashboard.get_preferred_height(DASHBOARD_WIDTH);
        // The pill now stays pinned above the dashboard inside the surface, so
        // the expanded box must be tall enough for both. Add the pill's height.
        let pillH = 0;
        if (this._pill && this._pill.visible) {
            let [, natPillH] = this._pill.get_preferred_height(DASHBOARD_WIDTH);
            // +14 for the expanded pill's bottom margin (CSS margins aren't
            // reported by get_preferred_height, so account for it explicitly).
            pillH = Math.ceil(natPillH) + 14;
        }
        // Add the surface's own vertical padding (top + bottom) so nothing clips.
        return Math.max(DASHBOARD_MIN_HEIGHT, Math.ceil(natHeight) + pillH + 40);
    }

    // Animate the widget to fit the active tab's content. Called after any
    // render that can change the content height while expanded.
    _resizeToContent() {
        if (!this.isExpanded) return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let targetHeight = this._measureDashboardHeight();
        let targetX = monitor.x + Math.floor((monitor.width - DASHBOARD_WIDTH) / 2);
        this.ease({
            x: targetX, y: monitor.y, width: DASHBOARD_WIDTH, height: targetHeight,
            duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    // True if `actor` is this widget or any descendant.
    _isDescendant(actor) {
        let p = actor;
        while (p) {
            if (p === this) return true;
            p = p.get_parent();
        }
        return false;
    }

    // True if the mouse pointer currently sits within our on-screen box.
    // Used to distinguish a real "pointer left" from grab-induced crossings.
    _pointerIsOverWidget() {
        let [px, py] = global.get_pointer();
        let [ax, ay] = this.get_transformed_position();
        let w = this.get_width();
        let h = this.get_height();
        return px >= ax && px <= ax + w && py >= ay && py <= ay + h;
    }

    // ============================================================
    // Pill
    // ============================================================
    _buildPill() {
        this._pill = new St.BoxLayout({
            style_class: 'notchnux-pill-content',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER });

        // --- Left zone: music (hidden unless a player has media) ---
        // Animated 4-bar equaliser + scrolling title.
        this._pillMusicBox = new St.BoxLayout({
            style_class: 'notchnux-pill-music',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false });

        this._pillEq = new EqBars();
        this._pillMusicBox.add_child(this._pillEq);

        // The title is clipped to a fixed width; when it overflows we marquee it
        // via _startPillMarquee. For a seamless (infinite) loop the text is drawn
        // twice inside a scrolling track: as copy 1 scrolls out, copy 2 scrolls in
        // to take its place, so the reset back to the start is invisible.
        this._pillTitleClip = new St.Widget({
            style_class: 'notchnux-pill-title-clip',
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout() });
        // The track holds both copies side by side; it's what we translate.
        this._pillTitleTrack = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER });
        const mkTitleLabel = () => {
            let l = new St.Label({
                text: '',
                style_class: 'notchnux-pill-title',
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER });
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            l.clutter_text.single_line_mode = true;
            return l;
        };
        this._pillTitle = mkTitleLabel();   // primary — _refreshLive sets its text
        this._pillTitle2 = mkTitleLabel();  // trailing copy for the seamless loop
        this._pillTitle2.visible = false;   // only shown while marqueeing
        this._pillTitleTrack.add_child(this._pillTitle);
        this._pillTitleTrack.add_child(this._pillTitle2);
        this._pillTitleClip.add_child(this._pillTitleTrack);
        this._pillMusicBox.add_child(this._pillTitleClip);

        this._pill.add_child(this._pillMusicBox);

        // --- Center zone: clock ---
        // The clock sits IN the flow, flanked by two expanding spacers so it
        // centres in the space left over between the music zone and the
        // battery/privacy zone. The LEFT spacer additionally carries a reserve
        // that mirrors the right-hand zone's width (see _balancePillClock): when
        // music is off the left zone is empty, so without this the centred clock
        // would drift right toward the battery/mute icons. Reserving matching
        // space on the left keeps the clock visually centred in the pill and
        // lets the otherwise-empty left side hold the date/time instead.
        this._pillClockLeftSpacer = new St.Widget({ x_expand: true });
        this._pill.add_child(this._pillClockLeftSpacer);

        this._pillClock = new St.Label({
            text: pillClockText(new Date()),
            style_class: 'notchnux-pill-clock',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER });
        // The clock must never be squeezed into an ellipsis ("3:..."): keep it on
        // one line and let it always demand its full natural width, so _pillWidth
        // can size the pill around it instead of the label collapsing.
        this._pillClock.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._pillClock.clutter_text.single_line_mode = true;
        this._pill.add_child(this._pillClock);

        this._pillClockRightSpacer = new St.Widget({ x_expand: true });
        this._pill.add_child(this._pillClockRightSpacer);

        // --- Right zone: battery icon + percentage, pinned to the right. ---
        this._pillBatteryBox = new St.BoxLayout({
            style_class: 'notchnux-pill-battery',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillBatteryIcon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style_class: 'notchnux-pill-icon',
            icon_size: 13,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillBatteryLabel = new St.Label({
            text: '',
            style_class: 'notchnux-pill-battery-pct',
            y_align: Clutter.ActorAlign.CENTER });
        this._pillBatteryBox.add_child(this._pillBatteryIcon);
        this._pillBatteryBox.add_child(this._pillBatteryLabel);
        this._pill.add_child(this._pillBatteryBox);

        // --- Right zone: notification indicator (bell + unread count). Stays
        //     hidden while the tray is empty so an idle pill reads clean; when
        //     notifications pile up it shows a bell with a count pill, mirroring
        //     the Alerts tab badge. _updateTabCountBadge drives both together. ---
        this._pillNotifBox = new St.BoxLayout({
            style_class: 'notchnux-pill-notif',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false });
        this._pillNotifIcon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style_class: 'notchnux-pill-icon',
            icon_size: 13,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillNotifCount = new St.Label({
            text: '',
            style_class: 'notchnux-pill-notif-count',
            y_align: Clutter.ActorAlign.CENTER });
        this._pillNotifBox.add_child(this._pillNotifIcon);
        this._pillNotifBox.add_child(this._pillNotifCount);
        this._pill.add_child(this._pillNotifBox);

        // --- Far right: privacy indicators (mic + camera), grouped so they sit
        //     together. Colour reflects state: green in-use · (mic only) red
        //     when muted. Each stays hidden until it has something to signal. ---
        this._pillPrivBox = new St.BoxLayout({
            style_class: 'notchnux-pill-priv-box',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillMic = new St.Icon({
            icon_name: 'microphone-sensitivity-high-symbolic',
            style_class: 'notchnux-pill-priv',
            icon_size: 13,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillCam = new St.Icon({
            icon_name: 'camera-web-symbolic',
            style_class: 'notchnux-pill-priv',
            icon_size: 13,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER });
        this._pillPrivBox.add_child(this._pillMic);
        this._pillPrivBox.add_child(this._pillCam);
        this._pill.add_child(this._pillPrivBox);
    }

    // ============================================================
    // Notification peek banner (transient)
    // ============================================================
    // The compact two-line card the pill morphs into when a notification lands.
    // It's a sibling of the pill/dashboard inside `_surface`; only one of the
    // three is visible at a time. The whole banner is a Button so a click opens
    // the full Notifications tab.
    _buildNotifBanner() {
        // The banner is a reactive column, not a single Button, so notification
        // action buttons ("Examine", "Reply", …) can live inside it as their
        // own clickable buttons without nesting buttons-in-buttons.
        this._notifBanner = new St.BoxLayout({
            style_class: 'nook-notif-peek',
            vertical: true,
            x_expand: true,
            y_expand: true,
            reactive: true });

        // --- Top: icon + title/body. Clicking this area activates the
        //     notification's default action (open the app / whatever it links
        //     to), mirroring what clicking a normal shell banner does. ---
        this._notifPeekMain = new St.Button({
            style_class: 'nook-notif-peek-main',
            x_expand: true,
            reactive: true,
            can_focus: false });
        let row = new St.BoxLayout({
            style_class: 'nook-notif-peek-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER });

        this._notifPeekIconBin = new St.Bin({
            style_class: 'nook-notif-peek-iconbin',
            y_align: Clutter.ActorAlign.CENTER });
        this._notifPeekIcon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            icon_size: 22 });
        this._notifPeekIconBin.set_child(this._notifPeekIcon);
        row.add_child(this._notifPeekIconBin);

        let textCol = new St.BoxLayout({
            style_class: 'nook-notif-peek-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER });
        this._notifPeekTitle = new St.Label({
            text: '', style_class: 'nook-notif-peek-title' });
        this._notifPeekTitle.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._notifPeekBody = new St.Label({
            text: '', style_class: 'nook-notif-peek-body' });
        this._notifPeekBody.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        textCol.add_child(this._notifPeekTitle);
        textCol.add_child(this._notifPeekBody);
        row.add_child(textCol);
        this._notifPeekMain.set_child(row);
        this._notifBanner.add_child(this._notifPeekMain);

        // --- Bottom: a row of the notification's action buttons, populated per
        //     notification. Hidden when the notification has no actions. ---
        this._notifPeekActions = new St.BoxLayout({
            style_class: 'nook-notif-peek-actions',
            vertical: false,
            x_expand: true,
            visible: false });
        this._notifBanner.add_child(this._notifPeekActions);

        // Clicking the main area = activate the notification (its default
        // action) and dismiss the peek.
        this._notifPeekMain.connect('clicked', () => {
            this._activateCurrentNotification();
        });

        // Hovering anywhere on the banner pauses the auto-dismiss; leaving
        // restarts it. Bound on the outer box so the actions row counts too.
        this._notifBanner.connect('enter-event', () => {
            this._clearPeekDismissTimer();
            return Clutter.EVENT_PROPAGATE;
        });
        this._notifBanner.connect('leave-event', () => {
            if (this._peekActive) this._armPeekDismissTimer();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Activate the notification currently shown in the peek (as if the user
    // clicked the real shell banner) and collapse. Falls back to just opening
    // the Notifications tab if the notification is gone or can't be activated.
    _activateCurrentNotification() {
        let n = this._peekNotification;
        this._hideNotificationPeek(true);
        let activated = false;
        try {
            if (n && typeof n.activate === 'function') {
                n.activate();
                activated = true;
            }
        } catch (e) {
            console.error('NotchNux: notification activate failed', e);
        }
        // Activating a notification normally raises its app; only fall back to
        // our own tab if there was nothing to activate.
        if (!activated) {
            this._activeTab = 'notifications';
            this.expand();
        }
    }

    // Rebuild the row of action buttons for the current notification. Each
    // action is {label, callback}; invoking it fires the app's handler (e.g.
    // "Examine" opens Disk Utility) and then dismisses the peek. We cap the
    // number shown so a chatty notification can't blow out the banner width.
    _renderPeekActions(actions) {
        this._notifPeekActions.destroy_all_children();
        let shown = (actions || []).slice(0, 3);
        if (shown.length === 0) {
            this._notifPeekActions.visible = false;
            return;
        }
        for (let action of shown) {
            let label = (action?.label || 'Open').toString();
            let btn = new St.Button({
                style_class: 'nook-notif-peek-action',
                label,
                x_expand: true,
                can_focus: false,
                reactive: true });
            btn.connect('clicked', () => {
                // Run the app's action handler, then collapse. Guard it — a
                // throwing callback must not leave the peek stuck open.
                try {
                    if (typeof action.callback === 'function') action.callback();
                } catch (e) {
                    console.error('NotchNux: notification action failed', e);
                }
                this._hideNotificationPeek(true);
            });
            this._notifPeekActions.add_child(btn);
        }
        this._notifPeekActions.visible = true;
    }

    // ============================================================
    // Dashboard shell
    // ============================================================
    _buildDashboard() {
        this._dashboard = new St.BoxLayout({
            style_class: 'notchnux-dashboard-content',
            vertical: true,
            x_expand: true,
            y_expand: true });

        // Full catalog of tabs (label + icon) keyed by id. Which of these are
        // shown, and in what order, is driven by user config below.
        this._tabs = {};
        for (let t of TAB_DEFS)
            this._tabs[t.id] = { label: t.label, icon: t.icon };
        // Ordered list of *visible* tab ids (config order, enabled only) — the
        // carousel and forward/back navigation walk this list.
        this._tabOrder = this._config.visibleTabs;
        // Fall back to at least the media tab if the user disabled everything,
        // so the dashboard never renders an empty header with nothing to show.
        if (this._tabOrder.length === 0)
            this._tabOrder = ['media'];

        // Carousel header: a horizontally-scrolling strip of tab pills. The
        // strip scrolls (drag / mouse-wheel / clicking a partly-hidden tab)
        // instead of forcing every tab to fit in the fixed dashboard width.
        let headerWrap = new St.BoxLayout({
            style_class: 'notchnux-dashboard-header-wrap',
            vertical: false,
            x_expand: true });

        let headerRow = new St.ScrollView({
            style_class: 'notchnux-dashboard-header',
            x_expand: true });
        headerRow.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
        headerRow.set_overlay_scrollbars(true);

        this._tabStrip = new St.BoxLayout({
            style_class: 'notchnux-tab-strip',
            vertical: false });
        headerRow.set_child(this._tabStrip);

        // Mouse-wheel over the header scrolls the carousel horizontally.
        // Wheel/trackpad over the header moves through tabs, so the strip can
        // be driven without having to click each pill.
        headerRow.connect('scroll-event', (actor, event) => {
            let dir = event.get_scroll_direction();
            let now = GLib.get_monotonic_time();
            if (now - this._lastTabScrollAt < 180000)
                return Clutter.EVENT_STOP;
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
                this._switchTabRelative(-1);
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
                this._switchTabRelative(1);
            else
                return Clutter.EVENT_PROPAGATE;
            this._lastTabScrollAt = now;
            return Clutter.EVENT_STOP;
        });
        this._tabScroll = headerRow;

        this._tabButtons = {};
        for (let id of this._tabOrder) {
            let tab = this._tabs[id];
            if (!tab) continue;
            let btn = new St.Button({ style_class: 'notchnux-tab-btn', reactive: true, can_focus: true });
            let row = new St.BoxLayout();
            row.add_child(new St.Icon({ icon_name: tab.icon, style_class: 'notchnux-tab-icon', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
            // Keep the label at its full width — St ellipsizes to "…" by default
            // once the strip can't fit the fixed dashboard width, which is what
            // clipped the tab names. The strip scrolls instead (see below), so
            // labels stay whole no matter how many tabs get added.
            let label = new St.Label({ text: tab.label, y_align: Clutter.ActorAlign.CENTER });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            row.add_child(label);
            // Alerts tab carries a live count badge beside its label so the
            // number of pending notifications is visible without opening it.
            if (id === 'notifications') {
                // Bin-wrapping the label (like nook-alerts-badge) guarantees the
                // digit gets an allocation — a bare Label in this x_expand row can
                // collapse to zero width and render as an empty dot.
                this._tabCountBadge = new St.Bin({ style_class: 'notchnux-tab-count', y_align: Clutter.ActorAlign.CENTER });
                this._tabCountLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
                this._tabCountBadge.set_child(this._tabCountLabel);
                this._tabCountBadge.visible = false;
                row.add_child(this._tabCountBadge);
            }
            btn.set_child(row);
            btn.connect('clicked', () => this._switchTab(id));
            this._tabStrip.add_child(btn);
            this._tabButtons[id] = btn;
        }
        // Populate the alerts count badge with the current notification total.
        this._updateTabCountBadge();

        this._settingsButton = new St.Button({
            style_class: 'notchnux-settings-btn',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.END });
        this._settingsButton.set_child(new St.Icon({
            icon_name: 'preferences-system-symbolic',
            icon_size: 15,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER }));
        // The gear opens the native preferences window (prefs.js) in its own
        // GTK process. Edits there land in config.json, which _watchConfig()
        // picks up to re-apply live.
        this._settingsButton.connect('clicked', () => {
            try {
                this.extension.openPreferences();
            } catch (e) {
                console.error('NotchNux: Failed to open preferences.', e);
            }
        });

        this._contentContainer = new St.BoxLayout({
            style_class: 'notchnux-content-container',
            x_expand: true,
            y_expand: true,
            vertical: true });

        headerWrap.add_child(headerRow);
        headerWrap.add_child(this._settingsButton);
        this._dashboard.add_child(headerWrap);
        this._dashboard.add_child(this._contentContainer);

        // Start on the first visible tab (media when enabled, otherwise
        // whatever the user ordered first).
        this._activeTab = this._tabOrder.includes('media') ? 'media' : this._tabOrder[0];
        if (this._tabButtons[this._activeTab])
            this._tabButtons[this._activeTab].add_style_class_name('notchnux-tab-btn-active');
    }

    // Tear down and rebuild the entire dashboard from current config. Called
    // after the user changes tab order / enabled tabs in settings so the
    // carousel reflects the change without needing a shell restart.
    _rebuildDashboard() {
        let wasExpanded = this.isExpanded;
        // Preserve the current tab if it's still visible; otherwise fall back.
        let prevTab = this._activeTab;
        this._teardownStudio();
        this._surface.remove_child(this._dashboard);
        this._dashboard.destroy();
        this._buildDashboard();
        this._surface.add_child(this._dashboard);
        this._dashboard.visible = wasExpanded;
        if (this._tabOrder.includes(prevTab) && prevTab !== this._activeTab) {
            // _buildDashboard already marked the default first tab active;
            // move that highlight to the tab we were actually on.
            if (this._tabButtons[this._activeTab])
                this._tabButtons[this._activeTab].remove_style_class_name('notchnux-tab-btn-active');
            this._activeTab = prevTab;
            if (this._tabButtons[this._activeTab])
                this._tabButtons[this._activeTab].add_style_class_name('notchnux-tab-btn-active');
        }
        this._applyAccentStyles();
        this._renderActiveTab();
    }

    // The stylesheet paints selected/active chrome in a fixed blue. To honour
    // the user's accent we override just that spot with an inline style built
    // from the current ACCENT. Inline style wins over the style class, so this
    // recolours the active tab pill without touching the CSS. Called on
    // startup, after a rebuild, and whenever accent changes.
    _applyAccentStyles() {
        let rgb = accentRgbStr();
        this._accentTabActiveStyle =
            `background-color: rgba(${rgb}, 0.18); border: 1px solid rgba(${rgb}, 0.4);`;
        // Repaint the currently-active tab pill.
        for (let [id, btn] of Object.entries(this._tabButtons ?? {}))
            btn.set_style(id === this._activeTab ? this._accentTabActiveStyle : null);
        // The collapsed pill's EQ bars are built once, so recolour them live.
        if (this._pillEq)
            this._pillEq.setAccentColor();
        // Keep the Alerts tab count pill in sync with the new accent.
        this._updateTabCountBadge();
    }

    _switchTab(tabId) {
        if (!this._tabs[tabId] || tabId === this._activeTab)
            return;
        if (this._tabButtons[this._activeTab]) {
            this._tabButtons[this._activeTab].remove_style_class_name('notchnux-tab-btn-active');
            this._tabButtons[this._activeTab].set_style(null);
        }
        this._activeTab = tabId;
        if (this._tabButtons[this._activeTab]) {
            this._tabButtons[this._activeTab].add_style_class_name('notchnux-tab-btn-active');
            this._tabButtons[this._activeTab].set_style(this._accentTabActiveStyle ?? null);
        }
        this._scrollActiveTabIntoView();
        this._renderActiveTab();
    }

    _switchTabRelative(delta) {
        let idx = this._tabOrder.indexOf(this._activeTab);
        if (idx < 0)
            idx = 0;
        let next = (idx + delta + this._tabOrder.length) % this._tabOrder.length;
        this._switchTab(this._tabOrder[next]);
    }

    // Slide the carousel so the active tab pill is fully visible.
    //
    // The read (button x/width, adjustment upper/page_size) is only meaningful
    // once the strip has been allocated. When switching to a tab near the far
    // end — especially right after the pill expands — those values are still
    // stale/zero, so the scroll silently no-ops and the tab stays off-screen
    // until a close/reopen re-lays-out the strip. Defer to the next paint so we
    // read a settled allocation, and retry once if it still isn't ready.
    _scrollActiveTabIntoView() {
        let attempt = (retriesLeft) => {
            let btn = this._tabButtons[this._activeTab];
            if (!btn || !this._tabScroll) return;
            let adj = this._tabScroll.get_hadjustment();
            // upper==page_size means "nothing to scroll" — but before the strip
            // is allocated upper is also 0, indistinguishable from that. If the
            // active button hasn't been given a real width yet, wait a frame.
            if (btn.get_width() <= 0 && retriesLeft > 0) {
                this._tabScrollFrameId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, 16, () => {
                        this._tabScrollFrameId = 0;
                        attempt(retriesLeft - 1);
                        return GLib.SOURCE_REMOVE;
                    });
                return;
            }
            let x = btn.get_x();
            let w = btn.get_width();
            let maxScroll = Math.max(0, adj.upper - adj.page_size);
            if (x < adj.value)
                adj.value = Math.max(0, x - 8);
            else if (x + w > adj.value + adj.page_size)
                adj.value = Math.min(maxScroll, x + w - adj.page_size + 8);
        };
        // Run after the current layout cycle so the first read sees a settled
        // allocation; the retry covers the just-expanded case where even that
        // isn't ready yet.
        if (this._tabScrollFrameId) {
            GLib.Source.remove(this._tabScrollFrameId);
            this._tabScrollFrameId = 0;
        }
        this._tabScrollFrameId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._tabScrollFrameId = 0;
            attempt(3);
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderActiveTab() {
        // Stop any running Cairo-widget animations before their actors are
        // destroyed — EqBars in particular drives GLib timers that would
        // otherwise fire into freed actors.
        this._stopMediaAnimations();
        // Leaving whatever tab was showing: stop the live camera preview and
        // close any open device pickers before their actors are freed. Recording
        // (if any) intentionally survives a tab switch.
        this._teardownStudio();
        this._contentContainer.destroy_all_children();
        switch (this._activeTab) {
            case 'media': this._renderMediaTab(); break;
            case 'system': this._renderSystemTab(); break;
            case 'weather': this._renderWeatherTab(); break;
            case 'studio': this._renderStudioTab(); break;
            case 'calendar': this._renderCalendarTab(); break;
            case 'notifications': this._renderNotificationsTab(); break;
            case 'shelf': this._renderShelfTab(); break;
        }
        // Re-fit to the new content height, unless expand() is driving its own
        // open animation (it renders first, then animates size itself).
        if (this.isExpanded && !this._isExpanding)
            this._resizeToContent();
    }

    // Halt vinyl spin + EQ bounce and drop the references, so nothing keeps
    // animating (or firing timers) after the media tab's actors are gone.
    _stopMediaAnimations() {
        if (this._eq) { this._eq.stop(); this._eq = null; }
        if (this._vinyl) { this._vinyl.stopSpin(); this._vinyl = null; }
        // Halt the timeline tick and drop actor refs before they're freed.
        this._stopTimelineTick();
        this._timelineFill = null;
        this._timelineBase = null;
        this._timelineElapsed = null;
    }

    _loadAlbumArt(url, art) {
        if (!url || !art) {
            if (art) art.visible = false;
            return;
        }

        art._notchnuxDestroyed = false;
        art.connect('destroy', () => {
            art._notchnuxDestroyed = true;
        });

        this._resolveAlbumArt(url, (path) => {
            if (!path || art._notchnuxDestroyed)
                return;

            try {
                if (art.setArtPath)
                    art.setArtPath(path);
                else {
                    art.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(path) });
                    art.visible = true;
                }
            } catch (e) {
                console.error('NotchNux: Failed to apply album art', e);
            }
        });
    }

    _resolveAlbumArt(url, done) {
        if (typeof url !== 'string') {
            done(null);
            return;
        }

        if (url.startsWith('file://')) {
            let file = Gio.File.new_for_uri(url);
            let path = file.get_path();
            done(path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            done(null);
            return;
        }

        if (this._artCache.has(url)) {
            done(this._artCache.get(url));
            return;
        }

        if (this._artPending.has(url)) {
            this._artPending.get(url).push(done);
            return;
        }

        this._artPending.set(url, [done]);
        let name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1) + '.img';
        let target = this._artCacheDir.get_child(name);
        let path = target.get_path();

        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._finishAlbumArtResolve(url, path);
            return;
        }

        let msg = Soup.Message.new('GET', url);
        this._artSession.send_and_read_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, res) => {
                try {
                    let bytes = session.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK || bytes.get_size() === 0) {
                        this._finishAlbumArtResolve(url, null);
                        return;
                    }

                    target.replace_contents_bytes_async(
                        bytes,
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null,
                        (file, writeRes) => {
                            try {
                                file.replace_contents_finish(writeRes);
                                this._finishAlbumArtResolve(url, path);
                            } catch (e) {
                                console.error('NotchNux: Failed to cache album art', e);
                                this._finishAlbumArtResolve(url, null);
                            }
                        }
                    );
                } catch (e) {
                    console.error('NotchNux: Failed to download album art', e);
                    this._finishAlbumArtResolve(url, null);
                }
            }
        );
    }

    _finishAlbumArtResolve(url, path) {
        if (path)
            this._artCache.set(url, path);

        let callbacks = this._artPending.get(url) || [];
        this._artPending.delete(url);
        for (let cb of callbacks)
            cb(path);
    }

    _refreshLive() {
        let info = this._mpris.getActiveTrackInfo();
        // Show the pill music zone whenever a player has media loaded (playing
        // OR paused) — a paused Spotify track is still "the media you're on".
        let showMusic = info.hasMedia &&
            (info.status === 'Playing' || info.status === 'Paused');
        let wasVisible = this._pillMusicBox.visible;
        this._pillMusicBox.visible = showMusic;

        if (showMusic) {
            let label = info.artist && info.artist !== 'Unknown Artist'
                ? `${info.title} — ${info.artist}` : info.title;
            if (this._pillTitle.text !== label) {
                this._pillTitle.set_text(label);
                this._startPillMarquee();
            }
            // Bars only bounce while actually playing; a paused track sits still.
            if (info.status === 'Playing') this._pillEq.start();
            else this._pillEq.stop();
        } else {
            this._pillEq.stop();
            this._stopPillMarquee();
            this._pillTitle.set_text('');
        }

        // Grow/shrink the pill to make room for (or reclaim) the title.
        if (showMusic !== wasVisible && !this.isExpanded)
            this._applyPillWidth();

        if (this.isExpanded)
            this._renderActiveTab();
    }

    // Repaint the mic / camera privacy dots on the pill.
    //   Mic:    muted → red, in use → green, otherwise hidden (idle).
    //   Camera: in use → green, otherwise hidden (idle).
    // We only surface an indicator when it has something to say, so an idle
    // machine keeps a clean pill.
    _updatePrivacyIndicators() {
        if (!this._pillMic) return;
        let before = this._pillMic.visible + '|' + this._pillCam.visible;

        // Feature off: hide both dots and reflow if that changed anything.
        if (!this._config.isFeatureEnabled('showPrivacy')) {
            this._pillMic.visible = false;
            this._pillCam.visible = false;
            if (before !== 'false|false' && !this.isExpanded)
                this._applyPillWidth();
            return;
        }

        let micMuted = this._system.isMicMuted();
        let micUsed = this._system.isMicInUse();
        this._pillMic.remove_style_class_name('priv-green');
        this._pillMic.remove_style_class_name('priv-red');
        if (micMuted) {
            this._pillMic.icon_name = 'microphone-disabled-symbolic';
            this._pillMic.add_style_class_name('priv-red');
            this._pillMic.visible = true;
        } else if (micUsed) {
            this._pillMic.icon_name = 'microphone-sensitivity-high-symbolic';
            this._pillMic.add_style_class_name('priv-green');
            this._pillMic.visible = true;
        } else {
            this._pillMic.visible = false;
        }

        let camUsed = this._system.isCameraInUse();
        this._pillCam.remove_style_class_name('priv-green');
        if (camUsed) {
            this._pillCam.add_style_class_name('priv-green');
            this._pillCam.visible = true;
        } else {
            this._pillCam.visible = false;
        }

        // Reflow the pill if an indicator appeared/disappeared.
        let after = this._pillMic.visible + '|' + this._pillCam.visible;
        if (after !== before && !this.isExpanded)
            this._applyPillWidth();
    }

    // Even gap (px) the pill keeps between neighbouring zones — the "slot" width
    // that a `justify-content: space-evenly` layout would distribute. The two
    // expanding spacers flanking the clock each occupy one of these; sizing the
    // pill to include them keeps the zones from crowding and never clips a zone.
    static get _ZONE_GAP() { return 18; }

    // Current collapsed-pill width. The pill hugs its content and then spaces the
    // zones out evenly — like flexbox `justify-content: space-evenly`. The two
    // x_expand spacers flanking the clock split whatever surplus width exists, so
    // as long as the pill is wide enough to hold every visible zone PLUS an even
    // gap between each, nothing truncates and the spacing reads uniform. We size
    // the pill to exactly that: sum of visible zone widths + one _ZONE_GAP per
    // interior gap + the content box's padding.
    _pillWidth() {
        let floor = this._pillMusicBox.visible ? PILL_WIDTH_MUSIC : PILL_WIDTH;
        // Measuring preferred widths queries the theme node, which is only valid
        // once the actor is on the stage. Before then (early setup / reposition)
        // fall back to the floor; the real width is applied once staged.
        if (!this._pillClock || !this._pillClock.get_stage()) return floor;

        // Collect the widths of the zones that are actually visible, in flow
        // order. The clock is always present; music/battery/priv are optional.
        let zones = [];
        if (this._pillMusicBox.visible)
            zones.push(this._pillMusicBox.get_preferred_width(-1)[1]);
        zones.push(this._pillClock.get_preferred_width(-1)[1]);
        if (this._pillBatteryBox && this._pillBatteryBox.visible)
            zones.push(this._pillBatteryBox.get_preferred_width(-1)[1]);
        if (this._pillNotifBox && this._pillNotifBox.visible)
            zones.push(this._pillNotifBox.get_preferred_width(-1)[1]);
        if (this._pillPrivBox && this._pillPrivBox.visible)
            zones.push(this._pillPrivBox.get_preferred_width(-1)[1]);

        let content = zones.reduce((a, b) => a + b, 0);
        // One even gap between each pair of adjacent zones, plus a half-gap of
        // breathing room inside each end (the space-evenly look also spaces the
        // outer edges), plus the content box's 2*4px horizontal padding.
        let gaps = (zones.length + 1) * NotchNux._ZONE_GAP;
        const PADDING = 2 * 4;
        let needed = content + gaps + PADDING;
        return Math.max(floor, Math.ceil(needed));
    }

    // Animate the collapsed pill to its current target width, keeping it centred
    // on the monitor.
    _applyPillWidth() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let width = this._pillWidth();
        let targetX = monitor.x + Math.floor((monitor.width - width) / 2);
        this.ease({ x: targetX, width: width, duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._balancePillClock();
    }

    // Distribute the zones evenly. With the pill sized by _pillWidth to hold all
    // zones plus even gaps, we just clear any spacer reserve and let the two
    // x_expand spacers flanking the clock split the surplus equally — the clock
    // floats in the middle and every gap comes out uniform (space-evenly). No
    // per-side reserve is needed anymore, which is what used to steal width from
    // the battery/mic zone and clip the "%" + mic off the right edge.
    _balancePillClock() {
        if (!this._pillClockLeftSpacer || !this._pillClockRightSpacer) return;
        this._pillClockLeftSpacer.set_width(0);
        this._pillClockRightSpacer.set_width(0);
    }

    // Marquee: if the title overflows its clip, scroll it left in a seamless
    // loop; short titles just sit still. Two copies of the text ride the track
    // with a fixed gap between them. We translate the track left by exactly one
    // copy+gap, then snap back to 0 — at which point copy 2 is sitting precisely
    // where copy 1 started, so the loop is continuous with no visible restart.
    _startPillMarquee() {
        this._stopPillMarquee();
        // Feature off: leave the (clipped) title static, no scrolling.
        if (!this._config.isFeatureEnabled('pillMarquee'))
            return;
        this._marqueeTries = 0;
        // Gap (px) between the end of one copy and the start of the next.
        const GAP = 40;
        // Defer so allocations (clip width, text width) are valid. On first show
        // the pill may still be animating its width, so retry a few times until
        // both the clip and the text report a real size before giving up.
        this._marqueeStartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            // Prefer the natural (unclipped) text width; get_width() can report
            // the clipped/allocated size which understates a long title.
            let [, natTextW] = this._pillTitle.get_preferred_width(-1);
            let textW = Math.max(natTextW, this._pillTitle.get_width());
            let clipW = this._pillTitleClip.get_width();
            this._pillTitleTrack.translation_x = 0;

            // Allocations not ready yet: try again shortly (bounded).
            if ((clipW <= 0 || textW <= 0) && this._marqueeTries++ < 12)
                return GLib.SOURCE_CONTINUE;

            this._marqueeStartId = 0;

            // Short enough to fit: sit still, single copy, no second label.
            if (textW <= clipW || clipW <= 0) {
                this._pillTitle2.visible = false;
                return GLib.SOURCE_REMOVE;
            }

            // Overflowing: mirror the text into copy 2 and space it by GAP so the
            // trailing copy trails the leading one with a clean gap between them.
            this._pillTitle2.set_text(this._pillTitle.get_text());
            this._pillTitle2.set_style(`margin-left: ${GAP}px;`);
            this._pillTitle2.visible = true;

            // One full cycle = one copy plus the gap. Snapping back by exactly
            // this distance lands copy 2 where copy 1 began: seamless.
            let cycle = textW + GAP;
            let step = () => {
                this._pillTitleTrack.translation_x = 0;
                this._pillTitleTrack.ease({
                    translation_x: -cycle,
                    duration: Math.max(3000, cycle * 45),
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => {
                        if (!this._pillMusicBox.visible) return;
                        step();   // immediate, no pause → continuous scroll
                    } });
            };
            step();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPillMarquee() {
        if (this._marqueeStartId) { GLib.Source.remove(this._marqueeStartId); this._marqueeStartId = 0; }
        if (this._marqueeHoldId) { GLib.Source.remove(this._marqueeHoldId); this._marqueeHoldId = 0; }
        if (this._pillTitleTrack) {
            this._pillTitleTrack.remove_all_transitions();
            this._pillTitleTrack.translation_x = 0;
        }
        if (this._pillTitle2) this._pillTitle2.visible = false;
    }

    // ============================================================
    // Tab: Media
    // ============================================================
    _renderMediaTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel', vertical: true, x_expand: true, y_expand: true });
        let info = this._mpris.getActiveTrackInfo();
        let playing = info.status === 'Playing';

        // Player body: vinyl · info+transport · volume knob.
        let body = new St.BoxLayout({ style_class: 'nook-media-body', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });

        // --- Spinning vinyl (Cairo) ---
        let vinyl = new Vinyl(140);
        this._vinyl = vinyl;
        if (playing) vinyl.startSpin();
        let vinylWrap = new St.Bin({ y_align: Clutter.ActorAlign.CENTER });
        let vinylStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: 140,
            height: 140
        });
        vinylStack.add_child(vinyl);
        let artDisc = new AlbumArtDisc(52);
        artDisc.x_align = Clutter.ActorAlign.CENTER;
        artDisc.y_align = Clutter.ActorAlign.CENTER;
        let artFrame = new St.Bin({
            style_class: 'nook-vinyl-art-frame',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        artFrame.set_child(artDisc);
        vinylStack.add_child(artFrame);
        this._loadAlbumArt(info.albumArt, artDisc);
        vinylWrap.set_child(vinylStack);
        body.add_child(vinylWrap);

        // --- Info + transport ---
        let mid = new St.BoxLayout({ style_class: 'nook-media-mid', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });

        // "NOW PLAYING" eyebrow + animated EQ bars.
        let eyebrow = new St.BoxLayout({ style_class: 'nook-eyebrow-row', vertical: false });
        let eyebrowLabel = new St.Label({ text: playing ? 'NOW PLAYING' : (info.hasMedia ? 'PAUSED' : 'NO MEDIA'), style_class: 'nook-eyebrow', y_align: Clutter.ActorAlign.CENTER });
        eyebrowLabel.set_style(`color: ${accentHex()};`);
        eyebrowLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        eyebrow.add_child(eyebrowLabel);
        let eq = new EqBars();
        this._eq = eq;
        if (playing) eq.start();
        eyebrow.add_child(eq);
        mid.add_child(eyebrow);

        // Coerce to string defensively: if mpris ever hands back an un-unwrapped
        // GLib.Variant, passing it as an St.Label `text:` throws and takes the
        // whole render (and thus expand) down with it.
        let title = String(info.hasMedia ? info.title : 'Nothing playing');
        let artist = String(info.hasMedia ? info.artist : 'Start something in your player');
        if (title.length > 44) title = title.substring(0, 42) + '…';
        if (artist.length > 48) artist = artist.substring(0, 46) + '…';
        mid.add_child(new St.Label({ text: title, style_class: 'nook-track-title' }));
        mid.add_child(new St.Label({ text: artist, style_class: 'nook-track-artist' }));

        // Transport controls.
        let controls = new St.BoxLayout({ style_class: 'nook-transport', vertical: false });
        // `active` tints the icon with the accent to signal an on/engaged toggle
        // (shuffle on, repeat all/one); `reactive: false` dims unsupported ones.
        let mkBtn = (icon, cb, reactive, primary, active = false) => {
            let b = new St.Button({ style_class: primary ? 'nook-transport-btn nook-transport-primary' : 'nook-transport-btn', reactive: reactive !== false });
            // The CSS paints the primary (play/pause) button a fixed blue; override
            // it with the current accent so it tracks the user's chosen colour.
            if (primary) {
                let rgb = accentRgbStr();
                b.set_style(`background-color: rgba(${rgb}, 1); box-shadow: 0px 2px 8px rgba(${rgb}, 0.28);`);
            }
            let ic = new St.Icon({ icon_name: icon, icon_size: primary ? 18 : 16, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            if (active && !primary)
                ic.set_style(`color: ${accentHex()};`);
            b.set_child(ic);
            b.connect('clicked', cb);
            return b;
        };
        controls.add_child(mkBtn('media-skip-backward-symbolic', () => this._mpris.previous(), info.canPrev));
        controls.add_child(mkBtn(playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic', () => this._mpris.playPause(), info.canPlay, true));
        controls.add_child(mkBtn('media-skip-forward-symbolic', () => this._mpris.next(), info.canNext));
        // Shuffle: lit when on; dimmed if the player doesn't support it.
        controls.add_child(mkBtn(
            'media-playlist-shuffle-symbolic',
            () => { this._mpris.toggleShuffle(); this._refreshLive(); },
            info.hasShuffle, false, info.shuffle));
        // Repeat: cycles off → all → one. "Repeat one" uses the dedicated icon
        // when the theme has it. Lit for both all and one.
        let loopIcon = info.loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        controls.add_child(mkBtn(
            loopIcon,
            () => { this._mpris.cycleLoop(); this._refreshLive(); },
            info.hasLoop, false, info.loopStatus !== 'None'));
        mid.add_child(controls);
        body.add_child(mid);

        // --- Volume knob (Cairo, scroll to change) ---
        let knobCol = new St.BoxLayout({ style_class: 'nook-knob-col', vertical: true, y_align: Clutter.ActorAlign.CENTER });
        let knob = new Knob(74);
        knob.setValue(this._system.volume / 100);
        // Scroll over the knob nudges the volume ±4%.
        let knobBtn = new St.Button({ style_class: 'nook-knob-btn', reactive: true, can_focus: false });
        knobBtn.set_child(knob);
        knobBtn.connect('scroll-event', (a, e) => {
            let dir = e.get_scroll_direction();
            let delta = (dir === Clutter.ScrollDirection.UP) ? 4 : (dir === Clutter.ScrollDirection.DOWN) ? -4 : 0;
            if (delta) {
                let v = Math.max(0, Math.min(100, this._system.volume + delta));
                this._system.setVolume(v);
                knob.setValue(v / 100);
                this._knobValue.set_text(String(v));
            }
            return Clutter.EVENT_STOP;
        });
        let knobOverlay = new St.Bin({ style_class: 'nook-knob-value', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._knobValue = new St.Label({ text: String(this._system.volume), style_class: 'nook-knob-num' });
        knobOverlay.set_child(this._knobValue);
        // Stack the number over the drawn knob.
        let knobStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        knobStack.add_child(knobBtn);
        knobStack.add_child(knobOverlay);
        knobCol.add_child(knobStack);
        let scrollHint = new St.BoxLayout({ style_class: 'nook-scroll-hint', x_align: Clutter.ActorAlign.CENTER });
        scrollHint.add_child(new St.Icon({ icon_name: 'input-mouse-symbolic', icon_size: 11, y_align: Clutter.ActorAlign.CENTER }));
        scrollHint.add_child(new St.Label({ text: 'SCROLL', y_align: Clutter.ActorAlign.CENTER }));
        knobCol.add_child(scrollHint);
        body.add_child(knobCol);

        panel.add_child(body);

        // --- Timeline scrubber (below the controls & knob) ---
        // Aligned to start where the track title starts — i.e. indented past the
        // vinyl by the vinyl width (140) plus the media body's 20px spacing — and
        // running to the knob's right edge. Scroll anywhere on it to move
        // ahead / back; the fill and time labels update live via a 1s tick.
        // 156 = 140 (vinyl) + 20 (body spacing) − 4 (the timeline's own left
        // padding) so the bar's visible edge lines up with the title glyphs.
        let timelineRow = new St.BoxLayout({ vertical: false, x_expand: true });
        timelineRow.add_child(new St.Widget({ width: 156 }));
        let timeline = this._buildMediaTimeline(info);
        timeline.x_expand = true;
        timelineRow.add_child(timeline);
        panel.add_child(timelineRow);

        this._contentContainer.add_child(panel);
    }

    // Full-width playback timeline placed below the media body. Shows elapsed /
    // total time with an accent-filled progress bar, and seeks on scroll.
    _buildMediaTimeline(info) {
        let lenUs = Number(info.length) || 0;
        this._timelineLenUs = lenUs;
        this._timelineTrackId = info.trackId ?? null;
        // Seed the position from a live read so the bar isn't empty on open.
        this._timelinePosUs = info.hasMedia ? this._mpris.getPosition() : 0;

        let wrap = new St.BoxLayout({ style_class: 'nook-timeline', vertical: true, x_expand: true });

        // The track is a reactive button so it captures scroll events across the
        // whole width. The base is a full-width bar (sized by the parent box);
        // the accent fill is a child of the base, absolutely positioned at its
        // left edge (x=0) via a FixedLayout, so it grows strictly left→right.
        // (A BinLayout centres a fixed-width child regardless of x_align on some
        // Clutter versions, which is what floated the fill in the middle.)
        let trackBtn = new St.Button({ style_class: 'nook-timeline-track', reactive: info.hasMedia, can_focus: false, x_expand: true });
        let base = new St.Widget({
            style_class: 'nook-timeline-base',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.FixedLayout() });
        let fill = new St.Widget({ style_class: 'nook-timeline-fill' });
        fill.set_style(`background-color: ${accentHex()};`);
        // Anchor the fill to the base's top-left; only its width changes as the
        // track progresses, so it always fills from the left.
        fill.set_position(0, 0);
        base.add_child(fill);
        trackBtn.set_child(base);
        this._timelineFill = fill;
        this._timelineBase = base;
        // The base width is unknown until allocated; recompute the fill once the
        // base gets its real size (and on any later resize).
        base.connect('notify::width', () => this._updateTimelineFill());
        base.connect('notify::height', () => this._updateTimelineFill());

        let labels = new St.BoxLayout({ style_class: 'nook-timeline-labels', vertical: false, x_expand: true });
        let elapsed = new St.Label({ text: this._fmtTime(this._timelinePosUs), style_class: 'nook-timeline-elapsed' });
        let total = new St.Label({ text: lenUs > 0 ? this._fmtTime(lenUs) : '--:--', style_class: 'nook-timeline-total', x_align: Clutter.ActorAlign.END, x_expand: true });
        labels.add_child(elapsed);
        labels.add_child(total);
        this._timelineElapsed = elapsed;

        wrap.add_child(trackBtn);
        wrap.add_child(labels);

        // Scroll to scrub: one notch = ±5s, throttled so a spin doesn't spam
        // D-Bus. Only meaningful when we know the track length and can seek.
        trackBtn.connect('scroll-event', (actor, event) => {
            if (!info.hasMedia || this._timelineLenUs <= 0)
                return Clutter.EVENT_PROPAGATE;
            let now = GLib.get_monotonic_time();
            if (now - this._lastTimelineScrollAt < 60000)
                return Clutter.EVENT_STOP;
            let dir = event.get_scroll_direction();
            let step = 0;
            if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
                step = -5;
            else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
                step = 5;
            else if (dir === Clutter.ScrollDirection.SMOOTH && event.get_scroll_delta) {
                let [dx, dy] = event.get_scroll_delta();
                let d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
                step = d > 0 ? 5 : d < 0 ? -5 : 0;
            }
            if (step === 0)
                return Clutter.EVENT_PROPAGATE;
            this._lastTimelineScrollAt = now;
            this._scrubTimeline(step * 1000000);
            return Clutter.EVENT_STOP;
        });

        this._updateTimelineFill();
        if (info.status === 'Playing' && lenUs > 0)
            this._startTimelineTick();
        return wrap;
    }

    // Move the playhead by deltaUs (µs, signed), clamp to the track, update the
    // UI immediately, then push the new absolute position to the player.
    _scrubTimeline(deltaUs) {
        let len = this._timelineLenUs;
        if (len <= 0) return;
        let pos = Math.max(0, Math.min(len, this._timelinePosUs + deltaUs));
        this._timelinePosUs = pos;
        this._updateTimelineFill();
        if (this._timelineTrackId)
            this._mpris.setPosition(this._timelineTrackId, pos);
        else
            this._mpris.seek(deltaUs); // fall back to relative seek
    }

    // Repaint the fill width and elapsed label from the cached position.
    _updateTimelineFill() {
        let len = this._timelineLenUs;
        let frac = len > 0 ? Math.max(0, Math.min(1, this._timelinePosUs / len)) : 0;
        if (this._timelineFill && this._timelineBase) {
            let w = this._timelineBase.get_width();
            let h = this._timelineBase.get_height();
            // Dimensions are 0 until the base is allocated; the base's
            // notify::width / notify::height handlers re-invoke this once it has
            // real dimensions. The fill is a FixedLayout child of the base pinned
            // at (0,0), so we set its width (fraction of the base) and match its
            // height to the base so the accent bar fills strictly left→right.
            if (w > 0) {
                this._timelineFill.set_width(Math.round(w * frac));
                if (h > 0)
                    this._timelineFill.set_height(h);
                this._timelineFill.set_position(0, 0);
            }
        }
        if (this._timelineElapsed)
            this._timelineElapsed.set_text(this._fmtTime(this._timelinePosUs));
    }

    _startTimelineTick() {
        this._stopTimelineTick();
        this._timelineTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            // Advance locally by 1s; periodically resync from the player to
            // correct drift (and catch external seeks).
            this._timelinePosUs += 1000000;
            if (this._timelinePosUs >= this._timelineLenUs && this._timelineLenUs > 0) {
                this._timelinePosUs = this._timelineLenUs;
                this._updateTimelineFill();
                return GLib.SOURCE_CONTINUE;
            }
            this._updateTimelineFill();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimelineTick() {
        if (this._timelineTickId) {
            GLib.Source.remove(this._timelineTickId);
            this._timelineTickId = 0;
        }
    }

    // Format microseconds as M:SS (or H:MM:SS for long media).
    _fmtTime(us) {
        let totalSec = Math.max(0, Math.floor((Number(us) || 0) / 1000000));
        let h = Math.floor(totalSec / 3600);
        let m = Math.floor((totalSec % 3600) / 60);
        let s = totalSec % 60;
        let pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    // ============================================================
    // Tab: System
    // ============================================================
    _renderSystemTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel', vertical: true, x_expand: true, y_expand: true });

        // --- Radial meters: CPU / RAM / SWAP / DISK / BRIGHTNESS ---
        let meters = new St.BoxLayout({ style_class: 'nook-meters-row', vertical: false, x_expand: true });
        // `onScroll(delta)` (optional) makes the tile an interactive knob: it
        // returns the new percentage to display, or null to leave it unchanged.
        // `displayText` (optional) overrides the centered "NN%" readout — used
        // by the network tile which shows a rate string ("1.2 MB/s") while the
        // ring still fills proportionally to `pct`.
        // `displayText` may be a string ("1.2 MB/s") for a single readout, or an
        // array of strings (["↓ 0.4 KB/s", "↑ 0.4 KB/s"]) to stack each as its
        // own label in a tight 2px-spaced box — used by the network tile.
        // `subRates` (optional) is an array of strings rendered as a tidy
        // stacked block *below* the ring (above the label) — used by the NET
        // tile so the ↓/↑ rates get their own breathing room instead of being
        // crammed into the ring center.
        let mkMeter = (label, pct, icon, color = ACCENT, onScroll = null, displayText = null, subRates = null) => {
            let t = new St.BoxLayout({ style_class: 'nook-meter-tile', vertical: true, x_expand: true, x_align: Clutter.ActorAlign.CENTER });
            let ring = new RingMeter(58, color);
            ring.setValue(pct / 100);

            // Build the centered readout actor.
            let readout;
            let numLabel = null;
            if (Array.isArray(displayText)) {
                // Each rate on its own line as a separate label; 2px gap between.
                readout = new St.BoxLayout({ vertical: true, style_class: 'nook-meter-rates',
                    x_align: Clutter.ActorAlign.CENTER });
                for (let line of displayText)
                    readout.add_child(new St.Label({ text: line,
                        style_class: 'nook-meter-num nook-meter-num-sm',
                        x_align: Clutter.ActorAlign.CENTER }));
            } else {
                numLabel = new St.Label({ text: displayText !== null ? displayText : `${pct}%`, style_class: displayText !== null ? 'nook-meter-num nook-meter-num-sm' : 'nook-meter-num' });
                readout = numLabel;
            }
            let stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
            stack.add_child(ring);
            let numBin = new St.Bin({ x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            numBin.set_child(readout);
            stack.add_child(numBin);

            if (onScroll) {
                // Wrap the ring in a reactive button so scrolling nudges the value.
                let btn = new St.Button({ style_class: 'nook-meter-knob-btn', reactive: true, can_focus: false });
                btn.set_child(stack);
                btn.connect('scroll-event', (a, e) => {
                    let dir = e.get_scroll_direction();
                    let delta = (dir === Clutter.ScrollDirection.UP) ? 5 : (dir === Clutter.ScrollDirection.DOWN) ? -5 : 0;
                    if (delta) {
                        let v = onScroll(delta);
                        if (v !== null && v !== undefined) {
                            ring.setValue(v / 100);
                            numLabel.set_text(`${v}%`);
                        }
                    }
                    return Clutter.EVENT_STOP;
                });
                t.add_child(btn);
            } else {
                t.add_child(stack);
            }

            // Optional rates block below the ring (NET tile).
            if (Array.isArray(subRates) && subRates.length) {
                let sub = new St.BoxLayout({ vertical: true, style_class: 'nook-meter-subrates',
                    x_align: Clutter.ActorAlign.CENTER });
                for (let line of subRates)
                    sub.add_child(new St.Label({ text: line, style_class: 'nook-meter-subrate',
                        x_align: Clutter.ActorAlign.CENTER }));
                t.add_child(sub);
            }

            let lbl = new St.BoxLayout({ style_class: 'nook-meter-label-row', x_align: Clutter.ActorAlign.CENTER });
            lbl.add_child(new St.Icon({ icon_name: icon, icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
            lbl.add_child(new St.Label({ text: label, y_align: Clutter.ActorAlign.CENTER }));
            t.add_child(lbl);
            return t;
        };
        meters.add_child(mkMeter('CPU', this._system.getCpuUsage(), 'system-run-symbolic'));
        meters.add_child(mkMeter('RAM', this._system.getRamUsage(), 'media-flash-symbolic'));
        meters.add_child(mkMeter('SWAP', this._system.getSwapUsage(), 'media-flash-symbolic'));
        meters.add_child(mkMeter('DISK', this._system.getDiskUsage(), 'drive-harddisk-symbolic'));
        // Live network throughput as two separate cards — download and upload —
        // each its own ring meter. Rings fill against a soft 12.5 MB/s ceiling
        // (~100 Mbit); the center readout shows the rate split into value + unit
        // on two lines so it fits the ring cleanly.
        const NET_CEIL = 12.5 * 1024 * 1024;
        let downRate = this._system.getNetDownRate();
        let upRate = this._system.getNetUpRate();
        let downPct = Math.min(100, Math.round((downRate / NET_CEIL) * 100));
        let upPct = Math.min(100, Math.round((upRate / NET_CEIL) * 100));
        let downLabel = this._system.getNetDownLabel();
        let upLabel = this._system.getNetUpLabel();
        // Ring center: rate split into value + unit on two lines.
        let splitRate = (r) => { let i = r.indexOf(' '); return i < 0 ? [r, ''] : [r.slice(0, i), r.slice(i + 1)]; };
        let downTile = mkMeter('DOWN', downPct, 'go-down-symbolic', ACCENT, null, splitRate(downLabel));
        downTile.add_style_class_name('nook-meter-tile-net');
        meters.add_child(downTile);
        let upTile = mkMeter('UP', upPct, 'go-up-symbolic', ACCENT, null, splitRate(upLabel));
        upTile.add_style_class_name('nook-meter-tile-net');
        meters.add_child(upTile);
        // Brightness as an interactive knob-tile. When no backend reports a
        // brightness value we show 0% but still allow scroll (which no-ops).
        let bright = this._system.getBrightness();
        meters.add_child(mkMeter('LIGHT', bright === null ? 0 : bright, 'display-brightness-symbolic', AMBER, (delta) => {
            let cur = this._system.getBrightness();
            if (cur === null) cur = 50;
            let v = Math.max(0, Math.min(100, cur + delta));
            this._system.setBrightness(v);
            return v;
        }));
        panel.add_child(meters);

        // --- Lower row: devices card + quick-toggle grid ---
        let lower = new St.BoxLayout({ style_class: 'nook-tray-lower', vertical: false, x_expand: true });

        // Devices card (battery levels of wireless accessories + this machine).
        // x_expand lets it flex to fill the space left by the fixed-width toggle
        // grid instead of overrunning the panel with a hard-coded width.
        let devCard = new St.BoxLayout({ style_class: 'nook-devices-card', vertical: true, x_expand: true });
        devCard.add_child(new St.Label({ text: 'DEVICES', style_class: 'nook-card-eyebrow' }));
        let devices = this._system.getBluetoothDevices();
        let bat = this._system.getBatteryInfo();
        let rows = [{ name: 'This device', icon: 'battery-good-symbolic', pct: bat.percentage }];
        for (let d of devices.slice(0, 3))
            rows.push({ name: d.name, icon: d.icon, pct: d.percentage,
                status: d.connected ? 'On' : d.type,
                // Carry the fields needed to toggle the connection on click.
                dbusPath: d.dbusPath, connected: d.connected, bluetooth: true });
        if (rows.length === 1)
            rows.push({ name: 'No wireless devices', icon: 'bluetooth-disconnected-symbolic', pct: null });
        for (let d of rows) {
            // Paired Bluetooth devices become clickable so the whole row toggles
            // its connection; everything else stays a plain, non-reactive row.
            let clickable = d.bluetooth && d.dbusPath;
            let row = clickable
                ? new St.Button({ style_class: 'nook-device-row nook-device-row-btn', reactive: true, x_expand: true, can_focus: true })
                : new St.BoxLayout({ style_class: 'nook-device-row', vertical: false, x_expand: true });
            let inner = clickable
                ? new St.BoxLayout({ vertical: false, x_expand: true })
                : row;
            inner.add_child(new St.Icon({ icon_name: d.icon, icon_size: 16, style_class: 'nook-device-icon', y_align: Clutter.ActorAlign.CENTER }));
            inner.add_child(new St.Label({ text: d.name, style_class: 'nook-device-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
            if (Number.isFinite(d.pct)) {
                const TRACK_W = 44;
                let track = new St.BoxLayout({ style_class: 'nook-batt-track', y_align: Clutter.ActorAlign.CENTER });
                let low = d.pct <= 25;
                let fill = new St.Widget({ style_class: low ? 'nook-batt-fill nook-batt-low' : 'nook-batt-fill' });
                // Normal fill follows the accent; the low state keeps its amber
                // warning colour, so only tint when not low.
                if (!low) fill.set_style(`background-color: ${accentHex()};`);
                fill.set_width(Math.max(3, Math.round((TRACK_W / 100) * d.pct)));
                track.add_child(fill);
                inner.add_child(track);
                inner.add_child(new St.Label({ text: `${d.pct}%`, style_class: 'nook-device-pct', y_align: Clutter.ActorAlign.CENTER }));
            } else if (d.status) {
                inner.add_child(new St.Label({ text: clickable && !d.connected ? 'Connect' : d.status,
                    style_class: 'nook-device-pct', y_align: Clutter.ActorAlign.CENTER }));
            }
            if (clickable) {
                row.set_child(inner);
                let want = !d.connected;
                row.connect('clicked', () => {
                    row.reactive = false;
                    this._system.setBluetoothConnected(d.dbusPath, want, (ok) => {
                        this._renderActiveTab();
                    });
                });
            }
            devCard.add_child(row);
        }
        lower.add_child(devCard);

        // Quick-toggles arranged in a plus around a central circular airplane
        // button. Each arm is a rounded tile whose center-facing corners are
        // heavily rounded, so the circle nestles into the cavity between them.
        let dndSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        let isDnd = !dndSettings.get_boolean('show-banners');

        // Cluster geometry (px). Arms sit N/E/S/W; the circle overlaps them.
        const ARM_W = 96, ARM_H = 58;          // arm tile size (horizontal arms)
        const V_ARM_W = 58, V_ARM_H = 96;      // vertical arm tile size
        const CIRCLE = 72;                     // center circle diameter
        // Gap kept between each arm's inner edge and the circle so the tiles
        // don't cut into it.
        const GAP = 6;
        // Footprint sized so the circle sits centred with an arm + gap on each
        // side: horizontal = V_ARM_W + GAP + CIRCLE + GAP + V_ARM_W, and the
        // vertical run of arm + gap + circle + gap + arm.
        const CL_W = V_ARM_W + GAP + CIRCLE + GAP + V_ARM_W;   // 200
        const CL_H = ARM_H + GAP + CIRCLE + GAP + ARM_H;       // 200
        const cx = CL_W / 2, cy = CL_H / 2;

        let cluster = new St.Widget({ style_class: 'nook-cluster', layout_manager: new Clutter.FixedLayout() });
        cluster.set_size(CL_W, CL_H);

        let mkArm = (icon, name, sub, active, corner, cb) => {
            let cls = 'nook-toggle nook-arm nook-arm-' + corner + (active ? ' nook-toggle-on' : '');
            let b = new St.Button({ style_class: cls, reactive: true, x_expand: true });
            let col = new St.BoxLayout({ vertical: true, x_expand: true,
                x_align: Clutter.ActorAlign.CENTER });
            col.add_child(new St.Icon({ icon_name: icon, icon_size: 18,
                style_class: 'nook-toggle-icon', x_align: Clutter.ActorAlign.CENTER }));
            let txt = new St.BoxLayout({ vertical: true, style_class: 'nook-toggle-text',
                x_expand: true, x_align: Clutter.ActorAlign.CENTER });
            txt.add_child(new St.Label({ text: name, style_class: 'nook-toggle-name',
                x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
            txt.add_child(new St.Label({ text: sub, style_class: 'nook-toggle-sub',
                x_align: Clutter.ActorAlign.CENTER, x_expand: true }));
            col.add_child(txt);
            b.set_child(col);
            if (cb) b.connect('clicked', cb);
            return b;
        };

        // Inner edge of each arm, offset from the circle so tiles never overlap it.
        const halfC = CIRCLE / 2;

        let muted = this._system.isMuted;
        // TOP arm — Sound (cavity on its bottom edge).
        let top = mkArm(muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
            muted ? 'Muted' : 'Sound', muted ? 'Off' : `${this._system.volume}%`, muted, 'top', () => {
            this._system.setMuted(!this._system.isMuted); this._renderActiveTab();
        });
        top.set_size(ARM_W, ARM_H);
        top.set_position(Math.round(cx - ARM_W / 2), Math.round(cy - halfC - GAP - ARM_H));

        // BOTTOM arm — Focus (cavity on its top edge).
        let bottom = mkArm(isDnd ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic',
            'Focus', isDnd ? 'On' : 'Off', isDnd, 'bottom', () => {
            dndSettings.set_boolean('show-banners', isDnd); this._renderActiveTab();
        });
        bottom.set_size(ARM_W, ARM_H);
        bottom.set_position(Math.round(cx - ARM_W / 2), Math.round(cy + halfC + GAP));

        // LEFT arm — Screenshot (cavity on its right edge).
        let left = mkArm('accessories-screenshot-symbolic', 'Shot', 'Capture', false, 'left', () => {
            this._collapseImmediately(); Main.screenshotUI.open();
        });
        left.set_size(V_ARM_W, V_ARM_H);
        left.set_position(Math.round(cx - halfC - GAP - V_ARM_W), Math.round(cy - V_ARM_H / 2));

        // RIGHT arm — Lock (cavity on its left edge).
        let right = mkArm('preferences-desktop-screensaver-symbolic', 'Lock', 'Screen', false, 'right', () => {
            this._collapseImmediately(); Main.screenShield.lock(true);
        });
        right.set_size(V_ARM_W, V_ARM_H);
        right.set_position(Math.round(cx + halfC + GAP), Math.round(cy - V_ARM_H / 2));

        // CENTER — circular airplane-mode toggle, on top of the arms.
        let airOn = this._system.getAirplaneMode();
        let center = new St.Button({ style_class: 'nook-air-btn' + (airOn ? ' nook-air-on' : ''), reactive: true });
        center.set_size(CIRCLE, CIRCLE);
        center.set_position(Math.round(cx - CIRCLE / 2), Math.round(cy - CIRCLE / 2));
        let airCol = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        airCol.add_child(new St.Icon({ icon_name: 'airplane-mode-symbolic', icon_size: 22, style_class: 'nook-air-icon', x_align: Clutter.ActorAlign.CENTER }));
        airCol.add_child(new St.Label({ text: airOn ? 'On' : 'Off', style_class: 'nook-air-sub', x_align: Clutter.ActorAlign.CENTER }));
        center.set_child(airCol);
        center.connect('clicked', () => {
            this._system.setAirplaneMode(!this._system.getAirplaneMode());
            this._renderActiveTab();
        });

        cluster.add_child(top);
        cluster.add_child(bottom);
        cluster.add_child(left);
        cluster.add_child(right);
        cluster.add_child(center);
        lower.add_child(cluster);

        panel.add_child(lower);
        this._contentContainer.add_child(panel);
    }

    // ============================================================
    // Tab: Weather
    // ============================================================
    _renderWeatherTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel', vertical: true, x_expand: true, y_expand: true });
        let w = this._weather.weatherData;

        // Top: analog clock · conditions.
        let top = new St.BoxLayout({ style_class: 'nook-weather-top', vertical: false, x_expand: true });

        // Analog clock column.
        let clockCol = new St.BoxLayout({ style_class: 'nook-clock-col', vertical: true, x_align: Clutter.ActorAlign.CENTER });
        let clock = new AnalogClock(122);
        clock.setDate(new Date());
        clockCol.add_child(clock);
        let now = new Date();
        clockCol.add_child(new St.Label({
            text: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            style_class: 'nook-clock-digital' }));
        clockCol.add_child(new St.Label({
            text: now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
            style_class: 'nook-clock-date' }));
        top.add_child(clockCol);

        // Conditions column.
        let cond = new St.BoxLayout({ style_class: 'nook-cond-col', vertical: true, x_expand: true });
        let locRow = new St.BoxLayout({ style_class: 'nook-loc-row', vertical: false });
        locRow.add_child(new St.Icon({ icon_name: 'find-location-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER }));
        locRow.add_child(new St.Label({ text: w.city || 'Locating…', y_align: Clutter.ActorAlign.CENTER }));
        let refreshWx = new St.Button({ style_class: 'nook-weather-icon-btn', reactive: true, y_align: Clutter.ActorAlign.CENTER });
        refreshWx.set_child(new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 13 }));
        refreshWx.connect('clicked', () => this._weather.updateWeather());
        locRow.add_child(refreshWx);
        cond.add_child(locRow);

        let tempRow = new St.BoxLayout({ style_class: 'nook-temp-row', vertical: false });
        tempRow.add_child(new St.Label({ text: w.temp || '--°', style_class: 'nook-temp', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        tempRow.add_child(new St.Icon({ icon_name: w.icon || 'weather-few-clouds-symbolic', icon_size: 52, style_class: 'nook-cond-icon', y_align: Clutter.ActorAlign.CENTER }));
        cond.add_child(tempRow);
        cond.add_child(new St.Label({ text: w.condition || 'No Data', style_class: 'nook-cond-text' }));
        cond.add_child(new St.Label({ text: `H:${w.high}  L:${w.low}`, style_class: 'nook-cond-hl' }));

        // Detail grid: humidity / wind / sunrise / sunset.
        let dGrid = new St.Widget({ style_class: 'nook-wx-grid', layout_manager: new Clutter.GridLayout() });
        let dl = dGrid.layout_manager;
        let mkStat = (icon, label, value) => {
            let r = new St.BoxLayout({ style_class: 'nook-wx-stat', vertical: false });
            r.add_child(new St.Icon({ icon_name: icon, icon_size: 14, style_class: 'nook-wx-icon', y_align: Clutter.ActorAlign.CENTER }));
            r.add_child(new St.Label({ text: label, style_class: 'nook-wx-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
            r.add_child(new St.Label({ text: value, style_class: 'nook-wx-value', y_align: Clutter.ActorAlign.CENTER }));
            return r;
        };
        dl.attach(mkStat('weather-showers-symbolic', 'Humidity', w.humidity), 0, 0, 1, 1);
        dl.attach(mkStat('weather-windy-symbolic', 'Wind', w.wind), 1, 0, 1, 1);
        dl.attach(mkStat('daytime-sunrise-symbolic', 'Sunrise', w.sunrise), 0, 1, 1, 1);
        dl.attach(mkStat('daytime-sunset-symbolic', 'Sunset', w.sunset), 1, 1, 1, 1);
        cond.add_child(dGrid);
        top.add_child(cond);
        panel.add_child(top);

        this._contentContainer.add_child(panel);
    }

    // ============================================================
    // Tab: Studio (webcam preview + mic, with recording)
    // ============================================================
    // Layout: [ camera square ] [ device pickers ] [ audio/record square ].
    // Left square shows a live webcam feed and records webcam+mic to WebM.
    // Right square is an audio-only recorder for the selected mic. The two
    // drop-downs in the middle switch the active camera / microphone.
    _renderStudioTab() {
        // Lazily spin up GStreamer only when the tab is first opened.
        if (!this._media)
            this._media = new MediaHelper();

        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-studio-panel', vertical: true, x_expand: true, y_expand: true });

        if (!this._media.available) {
            panel.add_child(new St.Label({
                text: 'GStreamer is unavailable — camera/mic capture can’t start.',
                style_class: 'nook-studio-error' }));
            this._contentContainer.add_child(panel);
            return;
        }

        // Enumerate devices and reconcile the current selection.
        let cams = this._media.listCameras();
        let mics = this._media.listMics();
        this._studioCams = cams;
        this._studioMics = mics;
        if (!this._selectedCam || !cams.some(c => c.id === this._selectedCam.id))
            this._selectedCam = cams[0] || null;
        if (!this._selectedMic || !mics.some(m => m.id === this._selectedMic.id))
            this._selectedMic = mics[0] || null;

        let row = new St.BoxLayout({ style_class: 'nook-studio-row', vertical: false, x_expand: true });

        // ---- Left: live camera square + video record button ----
        let camCol = new St.BoxLayout({ style_class: 'nook-studio-col', vertical: true, x_align: Clutter.ActorAlign.CENTER });
        let camView = new CameraView(150);
        this._studioCamView = camView;
        camCol.add_child(camView);

        let recBtn = new St.Button({ style_class: 'nook-studio-rec', reactive: true, can_focus: true });
        let recVideoOn = this._media.isRecording && this._media.recordingKind === 'video';
        this._studioVideoRecBtn = recBtn;
        recBtn.set_child(this._mkRecLabel(recVideoOn, 'Record'));
        if (recVideoOn) recBtn.add_style_class_name('nook-studio-rec-on');
        recBtn.connect('clicked', () => this._toggleStudioVideoRecord());
        recBtn.reactive = !!this._selectedCam;
        camCol.add_child(recBtn);
        row.add_child(camCol);

        // ---- Middle: camera + mic drop-downs ----
        let mid = new St.BoxLayout({ style_class: 'nook-studio-mid', vertical: true, y_align: Clutter.ActorAlign.CENTER });
        mid.add_child(this._mkStudioPicker('camera-web-symbolic', cams, this._selectedCam,
            (dev) => {
                this._selectedCam = dev;
                this._startStudioPreview();
                this._syncStudioButtons();
            }, 'No camera'));
        mid.add_child(this._mkStudioPicker('audio-input-microphone-symbolic', mics, this._selectedMic,
            (dev) => {
                this._selectedMic = dev;
                this._syncStudioButtons();
            }, 'No microphone'));
        row.add_child(mid);

        // ---- Right: audio recorder square ----
        let audCol = new St.BoxLayout({ style_class: 'nook-studio-col', vertical: true, x_align: Clutter.ActorAlign.CENTER });
        let audSquare = new St.Bin({ style_class: 'nook-studio-audio', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        audSquare.set_size(150, 150);
        let audIcon = new St.Icon({
            icon_name: (this._media.isRecording && this._media.recordingKind === 'audio')
                ? 'media-record-symbolic' : 'audio-input-microphone-symbolic',
            icon_size: 44, style_class: 'nook-studio-audio-icon' });
        this._studioAudioIcon = audIcon;
        audSquare.set_child(audIcon);
        audCol.add_child(audSquare);

        let audBtn = new St.Button({ style_class: 'nook-studio-rec', reactive: true, can_focus: true });
        let recAudioOn = this._media.isRecording && this._media.recordingKind === 'audio';
        this._studioAudioRecBtn = audBtn;
        audBtn.set_child(this._mkRecLabel(recAudioOn, 'Record'));
        if (recAudioOn) audBtn.add_style_class_name('nook-studio-rec-on');
        audBtn.connect('clicked', () => this._toggleStudioAudioRecord());
        audBtn.reactive = !!this._selectedMic;
        audCol.add_child(audBtn);
        row.add_child(audCol);

        panel.add_child(row);
        this._contentContainer.add_child(panel);

        // Wire live frames into the camera view and start the preview.
        this._media.onFrame = (bytes, w, h, stride) => {
            if (this._studioCamView && this._activeTab === 'studio')
                this._studioCamView.setFrame(bytes, w, h, stride);
        };
        this._media.onRecordingChanged = () => this._syncStudioButtons();
        // Delay spinning up the camera pipeline for ~1s after the tab is shown.
        // set_state(PLAYING) opens the PipeWire camera node, which triggers the
        // portal permission prompt and blocks briefly — doing that inline made
        // switching to Studio stutter. Waiting also means scrolling *past* the
        // Studio tab (the timer is cancelled in _teardownStudio when we leave)
        // never opens the camera or raises the permission prompt at all.
        if (this._studioPreviewIdle)
            GLib.Source.remove(this._studioPreviewIdle);
        this._studioPreviewIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._studioPreviewIdle = 0;
            this._startStudioPreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A record button's inner content: a red dot + "Record"/"Stop".
    _mkRecLabel(on, idle) {
        let box = new St.BoxLayout({ vertical: false, x_align: Clutter.ActorAlign.CENTER });
        box.add_child(new St.Widget({ style_class: 'nook-studio-rec-dot' }));
        box.add_child(new St.Label({ text: on ? 'Stop' : idle, y_align: Clutter.ActorAlign.CENTER }));
        return box;
    }

    // A device drop-down: a button showing the current selection that opens a
    // PopupMenu of the available devices. `onPick(device)` fires on selection.
    _mkStudioPicker(icon, devices, current, onPick, emptyLabel) {
        let btn = new St.Button({ style_class: 'nook-studio-picker', reactive: true, can_focus: true, x_expand: true });
        let inner = new St.BoxLayout({ vertical: false, x_expand: true });
        inner.add_child(new St.Icon({ icon_name: icon, icon_size: 13, y_align: Clutter.ActorAlign.CENTER, style_class: 'nook-studio-picker-icon' }));
        let lbl = new St.Label({
            text: current ? current.name : emptyLabel,
            y_align: Clutter.ActorAlign.CENTER, x_expand: true,
            style_class: 'nook-studio-picker-label' });
        lbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        inner.add_child(lbl);
        inner.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER, style_class: 'nook-studio-picker-caret' }));
        btn.set_child(inner);

        if (devices.length === 0) {
            btn.reactive = false;
            return btn;
        }

        let menu = new PopupMenu.PopupMenu(btn, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._studioMenus.push(menu);
        for (let dev of devices) {
            let item = new PopupMenu.PopupMenuItem(dev.name);
            if (current && dev.id === current.id)
                item.setOrnament(PopupMenu.Ornament.DOT);
            item.connect('activate', () => {
                lbl.set_text(dev.name);
                onPick(dev);
            });
            menu.addMenuItem(item);
        }
        btn.connect('clicked', () => menu.toggle());
        // The menu lives in Main.uiGroup (not a child of the content). Tie its
        // lifetime to the button and guard against double-destroy (both this
        // handler and _teardownStudio may run for the same menu on a re-render).
        btn.connect('destroy', () => this._destroyStudioMenu(menu));
        return btn;
    }

    _startStudioPreview() {
        if (!this._media || this._activeTab !== 'studio') return;
        if (this._selectedCam) {
            this._media.startPreview(this._selectedCam);
        } else {
            this._media.stopPreview();
            if (this._studioCamView) this._studioCamView.clearFrame();
        }
    }

    _toggleStudioVideoRecord() {
        if (!this._media) return;
        if (this._media.isRecording && this._media.recordingKind === 'video') {
            this._media.stopRecording();
            Main.notify('NotchNux', 'Video saved to Videos.');
        } else if (!this._media.isRecording && this._selectedCam) {
            let path = this._media.startVideoRecording(this._selectedCam, this._selectedMic);
            if (!path) Main.notify('NotchNux', 'Could not start recording.');
        }
        this._syncStudioButtons();
    }

    _toggleStudioAudioRecord() {
        if (!this._media) return;
        if (this._media.isRecording && this._media.recordingKind === 'audio') {
            this._media.stopRecording();
            Main.notify('NotchNux', 'Recording saved to Music.');
        } else if (!this._media.isRecording && this._selectedMic) {
            let path = this._media.startAudioRecording(this._selectedMic);
            if (!path) Main.notify('NotchNux', 'Could not start recording.');
        }
        this._syncStudioButtons();
    }

    // Repaint the record buttons / audio icon to match the current recording
    // state. While one kind is recording, the other button is disabled (a single
    // pipeline at a time keeps device contention simple).
    _syncStudioButtons() {
        if (this._activeTab !== 'studio' || !this._media) return;
        let rec = this._media.isRecording;
        let kind = this._media.recordingKind;

        if (this._studioVideoRecBtn) {
            let on = rec && kind === 'video';
            this._studioVideoRecBtn.set_child(this._mkRecLabel(on, 'Record'));
            this._studioVideoRecBtn.reactive = !!this._selectedCam && (!rec || on);
            if (on) this._studioVideoRecBtn.add_style_class_name('nook-studio-rec-on');
            else this._studioVideoRecBtn.remove_style_class_name('nook-studio-rec-on');
        }
        if (this._studioAudioRecBtn) {
            let on = rec && kind === 'audio';
            this._studioAudioRecBtn.set_child(this._mkRecLabel(on, 'Record'));
            this._studioAudioRecBtn.reactive = !!this._selectedMic && (!rec || on);
            if (on) this._studioAudioRecBtn.add_style_class_name('nook-studio-rec-on');
            else this._studioAudioRecBtn.remove_style_class_name('nook-studio-rec-on');
        }
        if (this._studioAudioIcon) {
            this._studioAudioIcon.icon_name = (rec && kind === 'audio')
                ? 'media-record-symbolic' : 'audio-input-microphone-symbolic';
        }
    }

    // Tear down preview + any open pickers when leaving the Studio tab. Recording
    // deliberately keeps running so switching tabs doesn't stop a capture.
    _teardownStudio() {
        if (this._studioPreviewIdle) {
            GLib.Source.remove(this._studioPreviewIdle);
            this._studioPreviewIdle = 0;
        }
        if (this._media) {
            this._media.stopPreview();
            this._media.onFrame = null;
        }
        this._studioCamView = null;
        this._studioVideoRecBtn = null;
        this._studioAudioRecBtn = null;
        this._studioAudioIcon = null;
        for (let m of this._studioMenus.slice())
            this._destroyStudioMenu(m);
        this._studioMenus = [];
    }

    // Destroy a picker's PopupMenu exactly once, forgetting it from the list.
    _destroyStudioMenu(menu) {
        if (!menu || menu._notchnuxDestroyed) return;
        menu._notchnuxDestroyed = true;
        let i = this._studioMenus.indexOf(menu);
        if (i >= 0) this._studioMenus.splice(i, 1);
        try { menu.destroy(); } catch (e) {}
    }

    // ============================================================
    // Tab: Calendar
    // ============================================================
    _renderCalendarTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-calendar-panel', vertical: true, x_expand: true, y_expand: true });
        let selected = this._selectedCalendarDate ?? new Date();
        selected.setHours(0, 0, 0, 0);
        this._requestCalendarServerRange(45, false);

        let summary = new St.BoxLayout({ style_class: 'nook-calendar-summary', vertical: false, x_expand: true });
        let iconBox = new St.Bin({ style_class: 'nook-calendar-summary-icon', y_align: Clutter.ActorAlign.CENTER });
        let accRgb = accentRgbStr();
        iconBox.set_style(`background-color: rgba(${accRgb}, 0.18); border: 1px solid rgba(${accRgb}, 0.28);`);
        iconBox.set_child(new St.Icon({ icon_name: 'x-office-calendar-symbolic', icon_size: 24 }));
        summary.add_child(iconBox);

        let text = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._calSummaryDay = new St.Label({
            text: selected.toLocaleDateString([], { weekday: 'long' }),
            style_class: 'nook-calendar-summary-day'
        });
        text.add_child(this._calSummaryDay);
        this._calSummaryDate = new St.Label({
            text: selected.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }),
            style_class: 'nook-calendar-summary-date'
        });
        text.add_child(this._calSummaryDate);
        summary.add_child(text);

        panel.add_child(summary);
        this._calDateStrip = this._buildDateStrip(selected);
        panel.add_child(this._calDateStrip);
        // Keep the panel + agenda so a date scroll can rebuild ONLY the agenda
        // (see _refreshCalendarAgenda) instead of tearing down the whole tab.
        this._calPanel = panel;
        this._calAgenda = this._buildCalendarAgenda({
            title: this._dayKey(selected) === this._dayKey(new Date()) ? 'Today' : 'Events',
            days: 45,
            selectedDate: selected,
            fullHeight: true
        });
        panel.add_child(this._calAgenda);

        this._contentContainer.add_child(panel);
    }

    // Swap just the agenda list for the currently-selected date, leaving the
    // summary header and date strip (already updated in place) untouched. Used
    // by the coalesced scroll flush so scrolling never rebuilds the whole tab.
    // Returns false if the cached actors are gone (tab was re-rendered), so the
    // caller can fall back to a full render.
    _refreshCalendarAgenda() {
        let panel = this._calPanel;
        let old = this._calAgenda;
        if (!panel || panel.is_finalized?.() || !old || old.get_parent() !== panel)
            return false;
        let selected = this._startOfDay(this._selectedCalendarDate ?? new Date());
        let fresh = this._buildCalendarAgenda({
            title: this._dayKey(selected) === this._dayKey(new Date()) ? 'Today' : 'Events',
            days: 45,
            selectedDate: selected,
            fullHeight: true
        });
        panel.replace_child(old, fresh);
        this._calAgenda = fresh;
        return true;
    }

    // React to a feature toggle without needing a shell restart where possible.
    _onFeatureToggled(id, on) {
        switch (id) {
            case 'weatherAutoRefresh':
                if (on) this._startWeatherRefresh();
                else this._stopWeatherRefresh();
                break;
            case 'calendarSync':
                if (on) this._initCalendarServer();
                else this._destroyCalendarServer();
                break;
            // showBattery / showPrivacy / pillMarquee are read at render time
            // by the pill; repaint it so the change shows immediately.
            case 'showBattery':
                this._updateClock();
                break;
            case 'showPrivacy':
                this._updatePrivacyIndicators();
                break;
            case 'pillMarquee':
                // Re-run the live refresh so the marquee starts/stops.
                this._refreshLive();
                break;
        }
    }

    _initCalendarServer() {
        try {
            let conn = Gio.DBus.session;
            let onEvents = (connection, sender, path, iface, signal, params) => {
                let events = params.deep_unpack()?.[0] ?? [];
                for (let raw of events) {
                    let ev = this._calendarServerEvent(raw);
                    if (ev?.id)
                        this._calendarServerEvents.set(ev.id, ev);
                }
                this._refreshLive();
            };
            let onRemoved = (connection, sender, path, iface, signal, params) => {
                let ids = params.deep_unpack()?.[0] ?? [];
                for (let id of ids)
                    this._calendarServerEvents.delete(id);
                this._refreshLive();
            };
            this._calendarServerSignalIds.push(conn.signal_subscribe(
                'org.gnome.Shell.CalendarServer',
                'org.gnome.Shell.CalendarServer',
                'EventsAddedOrUpdated',
                '/org/gnome/Shell/CalendarServer',
                null,
                Gio.DBusSignalFlags.NONE,
                onEvents));
            this._calendarServerSignalIds.push(conn.signal_subscribe(
                'org.gnome.Shell.CalendarServer',
                'org.gnome.Shell.CalendarServer',
                'EventsRemoved',
                '/org/gnome/Shell/CalendarServer',
                null,
                Gio.DBusSignalFlags.NONE,
                onRemoved));
            this._requestCalendarServerRange(45, true);
        } catch (e) {
            console.error('NotchNux: Failed to initialize calendar server.', e);
        }
    }

    _destroyCalendarServer() {
        try {
            let conn = Gio.DBus.session;
            for (let id of this._calendarServerSignalIds)
                conn.signal_unsubscribe(id);
        } catch (e) {
            // ignore shutdown races
        }
        this._calendarServerSignalIds = [];
        this._calendarServerEvents.clear();
    }

    _requestCalendarServerRange(days = 45, force = false) {
        try {
            // Anchor the fetched window to today (a fixed point), not the sliding
            // selected date, and widen it generously so scrolling a few weeks in
            // either direction stays inside an already-requested range. Because
            // the range no longer shifts per selected day, the dedup key below
            // actually stays stable while scrolling, so we don't re-hit DBus for
            // every date the user passes over — only when they scroll clear out
            // of the window (or on an explicit force refresh).
            let anchor = this._startOfDay(new Date());
            let selected = this._startOfDay(this._selectedCalendarDate ?? anchor);
            let start = new Date(anchor);
            start.setDate(start.getDate() - Math.max(30, days));
            let end = new Date(anchor);
            end.setDate(end.getDate() + Math.max(60, days) + 30);
            // If the user has scrolled the selection outside this window, recenter
            // on the selection so its events are always covered.
            if (selected < start) {
                start = new Date(selected);
                start.setDate(start.getDate() - 30);
            }
            if (selected > end) {
                end = new Date(selected);
                end.setDate(end.getDate() + 30);
            }
            let key = `${start.getTime()}:${end.getTime()}`;
            if (!force && this._lastCalendarRequestKey === key)
                return;
            this._lastCalendarRequestKey = key;
            Gio.DBus.session.call(
                'org.gnome.Shell.CalendarServer',
                '/org/gnome/Shell/CalendarServer',
                'org.gnome.Shell.CalendarServer',
                'SetTimeRange',
                new GLib.Variant('(xxb)', [
                    Math.floor(start.getTime() / 1000),
                    Math.floor(end.getTime() / 1000),
                    force
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        console.error('NotchNux: Failed to request calendar range.', e);
                    }
                });
        } catch (e) {
            console.error('NotchNux: Failed to request calendar range.', e);
        }
    }

    _calendarServerEvent(raw) {
        try {
            let [id, title, startSecs, endSecs, attrs] = raw;
            let start = new Date(Number(startSecs) * 1000);
            let end = new Date(Number(endSecs) * 1000);
            let meta = this._unpackVariantMap(attrs);
            return {
                id: String(id),
                title: String(title || 'Untitled event'),
                location: String(meta.location ?? ''),
                start,
                end,
                allDay: Boolean(meta['all-day'] ?? meta.allDay ?? meta.isAllDay)
            };
        } catch (e) {
            console.error('NotchNux: Failed to parse calendar server event.', e);
            return null;
        }
    }

    _unpackVariantMap(value) {
        let out = {};
        for (let [key, variant] of Object.entries(value ?? {})) {
            try {
                out[key] = variant?.deep_unpack ? variant.deep_unpack() :
                    variant?.unpack ? variant.unpack() : variant;
            } catch (e) {
                out[key] = variant;
            }
        }
        return out;
    }

    _buildDateStrip(selected) {
        let strip = new St.Button({
            style_class: 'nook-date-strip',
            x_expand: true,
            reactive: true,
            can_focus: true
        });
        let row = new St.BoxLayout({
            style_class: 'nook-date-strip-row',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        strip.set_child(row);
        // Keep the row so a scroll can repopulate it in place (no tab rebuild).
        this._calDateStripRow = row;
        this._populateDateStripRow(row, selected);

        strip.connect('scroll-event', (actor, event) => this._onCalendarDateScroll(event));
        return strip;
    }

    // Show the seven day-pills centred on `selected`. The seven pill actors are
    // built ONCE (cached on `row._pills`) and thereafter only have their text +
    // style_class re-stamped — scrolling the strip used to `destroy_all_children`
    // and reconstruct ~25 St actors per tick, which forced a full relayout on
    // every notch and was the visible scroll lag. Reusing the actors makes a
    // scroll a handful of cheap set_text / set_style_class_name calls instead.
    _populateDateStripRow(row, selected) {
        let today = this._startOfDay(new Date());
        let start = new Date(selected);
        start.setDate(start.getDate() - 3);

        // First call: build the persistent pill actors and cache them.
        if (!row._pills || row._pills.length !== 7) {
            row.destroy_all_children();
            row._pills = [];
            for (let i = 0; i < 7; i++) {
                let btn = new St.Button({ style_class: 'nook-date-pill', reactive: true, can_focus: true });
                let col = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
                let weekday = new St.Label({ style_class: 'nook-date-weekday', x_align: Clutter.ActorAlign.CENTER });
                let number = new St.Label({ style_class: 'nook-date-number', x_align: Clutter.ActorAlign.CENTER });
                let todayTag = new St.Label({ text: 'TODAY', style_class: 'nook-date-today', x_align: Clutter.ActorAlign.CENTER });
                col.add_child(weekday);
                col.add_child(number);
                col.add_child(todayTag);
                btn.set_child(col);
                let pill = { btn, weekday, number, todayTag, date: null };
                // Clicking a pill selects whatever date it currently shows.
                btn.connect('clicked', () => {
                    if (!pill.date) return;
                    this._selectedCalendarDate = this._startOfDay(pill.date);
                    this._requestCalendarServerRange(45, false);
                    this._renderActiveTab();
                });
                row.add_child(btn);
                row._pills.push(pill);
            }
        }

        // Re-stamp all seven pills in place for `selected`.
        for (let i = 0; i < 7; i++) {
            let date = new Date(start);
            date.setDate(start.getDate() + i);
            let pill = row._pills[i];
            pill.date = date;

            let active = this._dayKey(date) === this._dayKey(selected);
            let isToday = this._dayKey(date) === this._dayKey(today);
            let distance = Math.abs(i - 3);
            let classes = 'nook-date-pill';
            if (active) classes += ' nook-date-pill-active';
            if (isToday) classes += ' nook-date-pill-today';
            if (distance === 1) classes += ' nook-date-pill-near';
            else if (distance > 1) classes += ' nook-date-pill-far';
            pill.btn.set_style_class_name(classes);

            pill.weekday.set_text(date.toLocaleDateString([], { weekday: 'narrow' }).toUpperCase());
            pill.number.set_text(String(date.getDate()));

            // The CSS hardcodes today's colour to blue; override with the accent.
            let todayColor = isToday ? `color: ${accentHex()};` : '';
            pill.weekday.set_style(todayColor);
            pill.number.set_style(todayColor);
            pill.todayTag.set_style(todayColor);
            // Only today's pill carries the "TODAY" caption.
            pill.todayTag.visible = isToday;
        }
    }

    // Cheap in-place update of the strip + summary header to the currently
    // selected date, for instant scroll feedback without the heavy tab rebuild.
    _refreshCalendarStripSelection() {
        let selected = this._selectedCalendarDate ?? new Date();
        if (this._calDateStripRow)
            this._populateDateStripRow(this._calDateStripRow, selected);
        if (this._calSummaryDay)
            this._calSummaryDay.set_text(selected.toLocaleDateString([], { weekday: 'long' }));
        if (this._calSummaryDate)
            this._calSummaryDate.set_text(selected.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }));
    }

    _onCalendarDateScroll(event) {
        // One notched tick = one day. SMOOTH devices emit a burst of sub-events
        // per physical notch, so we normalise those to a single unit step and
        // rate-limit *that* — but, crucially, we never drop the input on the
        // floor: within the window we keep accumulating the delta (see
        // _moveSelectedCalendarDate) rather than returning early, so fast
        // scrolling advances by every tick instead of feeling unresponsive.
        let dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            delta = -1;
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            delta = 1;
        } else if (dir === Clutter.ScrollDirection.SMOOTH && event.get_scroll_delta) {
            let [dx, dy] = event.get_scroll_delta();
            let d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            // Coalesce the sub-event stream: only the first sub-event past the
            // window counts as a step, the rest of the burst is absorbed.
            let now = GLib.get_monotonic_time();
            if (d === 0 || now - this._lastCalendarDateScrollAt < 90000)
                return Clutter.EVENT_STOP;
            this._lastCalendarDateScrollAt = now;
            delta = d > 0 ? 1 : -1;
        }

        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        this._moveSelectedCalendarDate(delta);
        return Clutter.EVENT_STOP;
    }

    _moveSelectedCalendarDate(delta) {
        // Update the selected date immediately AND update the lightweight bits of
        // the UI (the date strip + summary header) in place, so the strip tracks
        // the cursor with no perceptible lag. The expensive work — a full tab
        // re-render plus a DBus calendar range request, which also reloads
        // camera/glycin previews — is coalesced into one deferred flush so fast
        // scrolling doesn't queue a rebuild per tick and stutter.
        let date = this._startOfDay(this._selectedCalendarDate ?? new Date());
        date.setDate(date.getDate() + delta);
        this._selectedCalendarDate = date;

        // Cheap in-place refresh of the visible strip/header for instant feedback.
        this._refreshCalendarStripSelection();

        // Debounce the expensive work (DBus event pull + agenda rebuild) until
        // the user actually settles on a date. The timer is reset on every tick,
        // so mid-scroll days never trigger a fetch — only the day you stop on
        // does, ~280ms after the last notch. Keeps scrolling to the cheap
        // in-place strip refresh above.
        if (this._calendarScrollFlushId)
            GLib.source_remove(this._calendarScrollFlushId);
        this._calendarScrollFlushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 280, () => {
            this._calendarScrollFlushId = 0;
            this._requestCalendarServerRange(45, false);
            // Rebuild only the agenda list for the new day; the summary + strip
            // are already updated in place. Fall back to a full render if the
            // cached calendar actors are gone (e.g. tab switched mid-flush).
            if (!this._refreshCalendarAgenda())
                this._renderActiveTab();
            else if (this.isExpanded && !this._isExpanding)
                this._resizeToContent();
            return GLib.SOURCE_REMOVE;
        });
    }

    _openControlCenter(args) {
        try {
            Gio.Subprocess.new(['gnome-control-center', ...args], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error('NotchNux: Failed to open GNOME Settings.', e);
        }
    }

    _buildCalendarAgenda(options = {}) {
        let title = options.title ?? 'Today';
        let days = options.days ?? 14;
        let selectedDate = this._startOfDay(options.selectedDate ?? new Date());
        let outer = new St.BoxLayout({
            style_class: options.fullHeight ? 'nook-calendar nook-calendar-full' : 'nook-calendar',
            vertical: true,
            x_expand: true
        });
        let header = new St.BoxLayout({ style_class: 'nook-calendar-header', vertical: false, x_expand: true });
        header.add_child(new St.Label({ text: title, style_class: 'nook-calendar-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        header.add_child(new St.Label({
            text: selectedDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
            style_class: 'nook-calendar-date',
            y_align: Clutter.ActorAlign.CENTER }));
        outer.add_child(header);

        let scroll = new St.ScrollView({ style_class: 'nook-calendar-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let list = new St.BoxLayout({ style_class: 'nook-calendar-list', vertical: true, x_expand: true });
        scroll.set_child(list);

        let events = this._collectCalendarEvents(days, selectedDate);
        if (events.length === 0) {
            let empty = new St.BoxLayout({ style_class: 'nook-calendar-empty', vertical: true, x_expand: true, x_align: Clutter.ActorAlign.CENTER });
            let emptyIcon = new St.Icon({ icon_name: 'x-office-calendar-symbolic', icon_size: 24, style_class: 'nook-calendar-empty-icon', x_align: Clutter.ActorAlign.CENTER });
            emptyIcon.set_style(`color: rgba(${accentRgbStr()}, 0.75);`);
            empty.add_child(emptyIcon);
            empty.add_child(new St.Label({ text: 'No events for this day', style_class: 'nook-calendar-empty-title', x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: 'Scroll the dates to check another day.', style_class: 'nook-calendar-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
            list.add_child(empty);
        } else {
            let grouped = this._groupEventsByDay(events);
            for (let group of grouped) {
                let day = new St.Label({ text: group.label, style_class: 'nook-calendar-day' });
                day.set_style(`color: ${accentHex()};`);
                list.add_child(day);
                for (let ev of group.events) {
                    let row = new St.BoxLayout({ style_class: 'nook-calendar-event', vertical: false, x_expand: true });
                    let time = new St.BoxLayout({ style_class: 'nook-calendar-time', vertical: true, y_align: Clutter.ActorAlign.START });
                    time.add_child(new St.Label({ text: ev.allDay ? 'All' : this._fmtEventTime(ev.start), style_class: 'nook-calendar-start' }));
                    time.add_child(new St.Label({ text: ev.allDay ? 'day' : this._fmtEventTime(ev.end), style_class: 'nook-calendar-end' }));
                    row.add_child(time);
                    let text = new St.BoxLayout({ vertical: true, x_expand: true });
                    text.add_child(new St.Label({ text: this._ellipsize(ev.title || 'Untitled event', 42), style_class: 'nook-calendar-event-title' }));
                    if (ev.location)
                        text.add_child(new St.Label({ text: this._ellipsize(ev.location, 56), style_class: 'nook-calendar-event-location' }));
                    row.add_child(text);
                    list.add_child(row);
                }
            }
        }

        outer.add_child(scroll);
        return outer;
    }

    _collectCalendarEvents(days, selectedDate = null) {
        let now = new Date();
        let todayStart = this._startOfDay(now);
        let rangeStart = selectedDate ? this._startOfDay(selectedDate) : todayStart;
        let dayEnd = new Date(rangeStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        let end = new Date(todayStart);
        end.setDate(end.getDate() + days);
        let out = Array.from(this._calendarServerEvents.values());

        try {
            let source = Main.panel.statusArea.dateMenu?._calendar?._eventSource ??
                Main.panel.statusArea.dateMenu?._eventSource;
            if (source?.requestRange)
                source.requestRange(rangeStart, selectedDate ? dayEnd : end);
            let raw = source?.getEvents ? source.getEvents(rangeStart, selectedDate ? dayEnd : end) : [];
            for (let ev of raw || []) {
                let evStart = this._eventDate(ev.date ?? ev.start ?? ev.startDate ?? ev.begin ?? null);
                let evEnd = this._eventDate(ev.end ?? ev.endDate ?? ev.endTime ?? evStart);
                if (!evStart)
                    continue;
                if (!evEnd || Number.isNaN(evEnd.getTime()))
                    evEnd = evStart;
                out.push({
                    title: String(ev.summary ?? ev.title ?? ev.name ?? 'Untitled event'),
                    location: String(ev.location ?? ''),
                    start: evStart,
                    end: evEnd,
                    allDay: Boolean(ev.allDay ?? ev.isAllDay)
                });
            }
        } catch (e) {
            console.error('NotchNux: Failed to read calendar events.', e);
        }

        let seen = new Set();
        return out
            .filter(ev => ev.start instanceof Date &&
                !Number.isNaN(ev.start.getTime()) &&
                ev.start < end &&
                (selectedDate ? this._eventOverlapsDay(ev, rangeStart, dayEnd) :
                    (ev.allDay ? ev.end >= todayStart : ev.end >= now)))
            .filter(ev => {
                // Deduplicate on event identity (title + time span), NOT on id.
                // The same event arrives from two sources — the DBus CalendarServer
                // (which carries an id) and GNOME's dateMenu event source (which
                // does not) — so keying on id lets both copies through. This also
                // collapses the same event synced across multiple accounts.
                let key = `${ev.title}|${ev.allDay ? 'A' : 'T'}|${ev.start.getTime()}|${ev.end.getTime()}`;
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => a.start - b.start)
            .slice(0, 30);
    }

    _eventDate(value) {
        if (!value)
            return null;
        if (value instanceof Date)
            return value;
        if (value instanceof GLib.DateTime)
            return new Date(value.to_unix() * 1000);
        if (typeof value.toJSDate === 'function')
            return value.toJSDate();
        return new Date(value);
    }

    _eventOverlapsDay(ev, start, end) {
        let evEnd = ev.end instanceof Date && !Number.isNaN(ev.end.getTime()) ? ev.end : ev.start;
        if (evEnd <= ev.start)
            evEnd = new Date(ev.start.getTime() + 1);
        return ev.start < end && evEnd > start;
    }

    _startOfDay(date) {
        let out = new Date(date);
        out.setHours(0, 0, 0, 0);
        return out;
    }

    _groupEventsByDay(events) {
        let groups = [];
        let todayKey = this._dayKey(new Date());
        let tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        let tomorrowKey = this._dayKey(tomorrow);

        for (let ev of events) {
            let key = this._dayKey(ev.start);
            let group = groups.find(g => g.key === key);
            if (!group) {
                let label = key === todayKey ? 'Today' :
                    key === tomorrowKey ? 'Tomorrow' :
                    ev.start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                group = { key, label, events: [] };
                groups.push(group);
            }
            group.events.push(ev);
        }
        return groups;
    }

    _dayKey(date) {
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    _fmtEventTime(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime()))
            return '--:--';
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    _ellipsize(text, max) {
        text = String(text || '');
        return text.length > max ? text.substring(0, max - 1) + '…' : text;
    }

    // ============================================================
    // Tab: Notifications
    // ============================================================
    _renderNotificationsTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-alerts-panel', vertical: true, x_expand: true, y_expand: true });

        let messages = this._collectNotifications();
        // Keep the tab-strip count badge in sync with what we're rendering.
        this._updateTabCountBadge(messages.length);
        // Remember what we just rendered so the periodic refresh can skip a
        // rebuild while the queue is unchanged — rebuilding would reset the
        // scroll position and collapse any card the user expanded.
        this._notifSignature = this._notificationsSignature(messages);

        // Header: "Notifications" + count badge · Clear all.
        let header = new St.BoxLayout({ style_class: 'nook-alerts-header', vertical: false, x_expand: true });
        let titleBox = new St.BoxLayout({ vertical: false, x_expand: true });
        titleBox.add_child(new St.Label({ text: 'Notifications', style_class: 'nook-alerts-title', y_align: Clutter.ActorAlign.CENTER }));
        if (messages.length > 0) {
            let badge = new St.Bin({ style_class: 'nook-alerts-badge', y_align: Clutter.ActorAlign.CENTER });
            badge.set_style(`background-color: ${accentHex()};`);
            badge.set_child(new St.Label({ text: String(messages.length) }));
            titleBox.add_child(badge);
        }
        header.add_child(titleBox);
        let clearBtn = new St.Button({ style_class: 'nook-clear-btn', reactive: true, y_align: Clutter.ActorAlign.CENTER });
        let clearRow = new St.BoxLayout({ vertical: false });
        clearRow.add_child(new St.Icon({ icon_name: 'edit-clear-all-symbolic', icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
        clearRow.add_child(new St.Label({ text: 'Clear all', y_align: Clutter.ActorAlign.CENTER }));
        clearBtn.set_child(clearRow);
        clearBtn.connect('clicked', () => { this._clearNotifications(); this._renderActiveTab(); });
        header.add_child(clearBtn);
        panel.add_child(header);

        if (messages.length > 0) {
            // All notifications live in a vertical scroll view instead of being
            // capped at 5 with a "+N more" stub, so the whole queue is reachable.
            let scroll = new St.ScrollView({ style_class: 'nook-alerts-scroll', x_expand: true, y_expand: true });
            scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            let list = new St.BoxLayout({ style_class: 'nook-alerts-list', vertical: true, x_expand: true });
            for (let m of messages)
                list.add_child(this._buildAlertCard(m));
            scroll.set_child(list);
            panel.add_child(scroll);
        } else {
            let empty = new St.BoxLayout({ style_class: 'nook-alerts-empty', vertical: true, x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            empty.add_child(new St.Icon({ icon_name: 'preferences-system-notifications-symbolic', icon_size: 30, style_class: 'nook-alerts-empty-icon', x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: 'You’re all caught up', style_class: 'nook-alerts-empty-title', x_align: Clutter.ActorAlign.CENTER }));
            empty.add_child(new St.Label({ text: 'New notifications will land here.', style_class: 'nook-alerts-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
            panel.add_child(empty);
        }

        this._contentContainer.add_child(panel);
    }

    // A cheap fingerprint of the notification queue: count plus each title/body.
    // Used to decide whether the live-open Alerts tab actually needs rebuilding.
    _notificationsSignature(messages) {
        return messages.length + '|' + messages.map(m => `${m.title} ${m.body}`).join('');
    }

    // Update the little count pill next to the "Alerts" tab label. Pass a known
    // count to avoid a re-poll, or omit it to collect the current total. The
    // badge hides itself at zero so the tab reads clean when nothing's pending.
    _updateTabCountBadge(count = null) {
        if (!this._tabCountBadge) return;
        if (count === null) {
            try { count = this._collectNotifications().length; }
            catch (e) { count = 0; }
        }
        if (count > 0) {
            this._tabCountLabel.set_text(count > 99 ? '99+' : String(count));
            // Follow the accent (CSS hardcodes blue); light when the Alerts tab
            // is the active one, matching the .notchnux-tab-btn-active override.
            let active = this._activeTab === 'notifications';
            this._tabCountBadge.set_style(active ? 'background-color: #eaf0ff; color: #0d0d10;'
                                                 : `background-color: ${accentHex()}; color: #0d0d10;`);
            this._tabCountBadge.visible = true;
        } else {
            this._tabCountBadge.visible = false;
        }

        // Mirror the count onto the collapsed pill's notification indicator.
        this._updatePillNotifIndicator(count);
    }

    // Reflect the unread notification count on the pill (bell + count pill).
    // Hidden when the tray is empty, the notification feature is off, or the
    // dashboard is open (the count lives in the Alerts tab then). Reflows the
    // pill when it appears/disappears so the zone spacing stays even.
    _updatePillNotifIndicator(count) {
        if (!this._pillNotifBox) return;
        let before = this._pillNotifBox.visible;

        let show = count > 0 &&
            this._config.isFeatureEnabled('notifPeek') &&
            !this.isExpanded;
        if (show) {
            this._pillNotifCount.set_text(count > 99 ? '99+' : String(count));
            this._pillNotifCount.set_style(`color: ${accentHex()};`);
            this._pillNotifBox.visible = true;
        } else {
            this._pillNotifBox.visible = false;
        }

        if (this._pillNotifBox.visible !== before && !this.isExpanded)
            this._applyPillWidth();
    }

    // One notification tile. Title/body are truncated by default; if either
    // overflows its preview, the card becomes clickable and toggles between the
    // truncated and full text (a small chevron signals the affordance). Cards
    // with nothing extra to show stay static (non-reactive).
    _buildAlertCard(m) {
        const TITLE_MAX = 34;
        const BODY_MAX = 74;
        let fullTitle = m.title || '';
        let fullBody = m.body || '';
        let hasMore = fullTitle.length > TITLE_MAX || fullBody.length > BODY_MAX;

        let meta = this._notifStyle(fullTitle);
        let cls = 'nook-alert-card' + (meta.accent ? ' nook-alert-accent' : '') + (hasMore ? ' nook-alert-expandable' : '');
        // Use a button when expandable so it's focusable/clickable; a plain box
        // otherwise (keeps non-interactive cards out of the focus chain).
        let card = hasMore
            ? new St.Button({ style_class: cls, x_expand: true, reactive: true, can_focus: true })
            : new St.BoxLayout({ style_class: cls, vertical: false, x_expand: true });
        // Accented cards follow the user accent instead of the CSS blue.
        if (meta.accent) {
            let accRgb = accentRgbStr();
            card.set_style(`background-color: rgba(${accRgb}, 0.1); border: 1px solid rgba(${accRgb}, 0.28);`);
        }

        let inner = new St.BoxLayout({ vertical: false, x_expand: true });
        if (hasMore)
            card.set_child(inner);

        let badge = new St.Bin({ style_class: 'nook-alert-badge', y_align: Clutter.ActorAlign.START });
        badge.set_child(new St.Icon({ icon_name: meta.icon, icon_size: 18 }));
        badge.set_style(`background-color: ${meta.color};`);
        inner.add_child(badge);

        let txt = new St.BoxLayout({ vertical: true, x_expand: true });
        let titleRow = new St.BoxLayout({ vertical: false, x_expand: true });
        let titleLabel = new St.Label({ style_class: 'nook-alert-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titleRow.add_child(titleLabel);
        // Expand/collapse chevron, only on cards that have more to reveal.
        let chevron = null;
        if (hasMore) {
            chevron = new St.Icon({ icon_name: 'pan-end-symbolic', style_class: 'nook-alert-chevron', icon_size: 12, y_align: Clutter.ActorAlign.CENTER });
            titleRow.add_child(chevron);
        }
        txt.add_child(titleRow);
        let bodyLabel = null;
        if (fullBody) {
            bodyLabel = new St.Label({ style_class: 'nook-alert-body' });
            // Let the full body wrap across lines when expanded.
            bodyLabel.clutter_text.line_wrap = true;
            bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            txt.add_child(bodyLabel);
        }
        inner.add_child(txt);
        if (!hasMore)
            card.add_child(inner);

        let expanded = false;
        let apply = () => {
            if (expanded) {
                titleLabel.set_text(fullTitle);
                titleLabel.clutter_text.line_wrap = true;
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                if (bodyLabel) bodyLabel.set_text(fullBody);
                if (chevron) chevron.icon_name = 'pan-down-symbolic';
            } else {
                titleLabel.set_text(fullTitle.length > TITLE_MAX ? fullTitle.substring(0, TITLE_MAX - 1) + '…' : fullTitle);
                titleLabel.clutter_text.line_wrap = false;
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                if (bodyLabel) bodyLabel.set_text(fullBody.length > BODY_MAX ? fullBody.substring(0, BODY_MAX - 2) + '…' : fullBody);
                if (chevron) chevron.icon_name = 'pan-end-symbolic';
            }
        };
        apply();

        if (hasMore) {
            card.connect('clicked', () => {
                expanded = !expanded;
                apply();
                // Card grew/shrank — refit the dashboard to the new height.
                if (this.isExpanded && !this._isExpanding)
                    this._resizeToContent();
            });
        }
        return card;
    }

    // Map a notification's source name to a badge colour + glyph, so each
    // tile reads at a glance (the concept colour-codes Slack/Mail/Calendar/etc).
    _notifStyle(title) {
        let t = (title || '').toLowerCase();
        if (t.includes('slack')) return { icon: 'user-available-symbolic', color: '#4a154b', accent: false };
        if (t.includes('mail') || t.includes('gmail')) return { icon: 'mail-unread-symbolic', color: '#1a73e8', accent: false };
        if (t.includes('calendar') || t.includes('event')) return { icon: 'x-office-calendar-symbolic', color: '#7aa2ff', accent: true };
        if (t.includes('update') || t.includes('software')) return { icon: 'system-software-install-symbolic', color: '#2b2b31', accent: false };
        if (t.includes('discord')) return { icon: 'user-available-symbolic', color: '#5865f2', accent: false };
        return { icon: 'preferences-system-notifications-symbolic', color: '#2b2b31', accent: false };
    }

    // ============================================================
    // Notification peek: watch the shell's message tray and, when a new
    // notification arrives, morph the collapsed pill into a compact banner.
    // ============================================================
    // Subscribe to the message tray. `source-added` fires for each app that
    // posts; each source then fires `notification-added` per notification. We
    // fan out so we hear about notifications from sources that already exist as
    // well as ones created later.
    _initNotificationWatch() {
        this._peekSourceIds = new Map();   // source -> its notification-added id
        this._peekActive = false;
        let tray = Main.messageTray;
        if (!tray) return;
        try {
            this._peekSourceAddedId = tray.connect('source-added',
                (t, source) => this._watchNotifSource(source));
            // Attach to sources that existed before we connected.
            let sources = tray.getSources ? tray.getSources() : (tray._sources ?? []);
            for (let source of sources) this._watchNotifSource(source);
        } catch (e) {
            console.error('NotchNux: notification watch init failed', e);
        }
        this._installBannerSuppression();
    }

    // Replace the shell's own top-right notification banner with our pill peek.
    // We wrap `_updateState` (the tray's state machine): when it's about to pop
    // a queued notification into a banner, we short-circuit — pull the item off
    // the queue and mark it shown WITHOUT mounting the banner actor. The
    // notification still lands in tray history (and fires `notification-added`,
    // so our peek shows it); it just never appears as the default popup.
    //
    // Suppression is conditional: if the peek feature is off or system DND is
    // on, we fall through to the real banner so the user still sees something.
    _installBannerSuppression() {
        let tray = Main.messageTray;
        if (!tray || this._origShowNotification) return;
        let self = this;
        try {
            this._origShowNotification = tray._showNotification;
            tray._showNotification = function (...args) {
                // Fall through to the real banner when we shouldn't suppress.
                if (!self._shouldSuppressShellBanner()) {
                    return self._origShowNotification.apply(this, args);
                }
                // Suppress: end the show cycle without a banner. Pull the queued
                // notification (our `notification-added` handler already fired
                // and drove the peek) and let the state machine settle.
                try {
                    let n = this._notificationQueue.shift() || null;
                    this._notification = n;
                    // MessageTray.State.SHOWN === 2 on GNOME 45–50.
                    this._notificationState = 2;
                    this._notificationTimeoutId = 0;
                    if (typeof this._showNotificationCompleted === 'function')
                        this._showNotificationCompleted();
                } catch (e) {
                    // If our short-circuit ever fails, don't wedge the tray —
                    // fall back to the real implementation.
                    return self._origShowNotification.apply(this, args);
                }
            };
        } catch (e) {
            console.error('NotchNux: banner suppression install failed', e);
            this._origShowNotification = null;
        }
    }

    _removeBannerSuppression() {
        let tray = Main.messageTray;
        if (tray && this._origShowNotification) {
            try { tray._showNotification = this._origShowNotification; }
            catch (e) {}
        }
        this._origShowNotification = null;
    }

    // True when a fresh notification should be shown ONLY in our pill (i.e. the
    // shell's own banner should be hidden). Mirrors the gate in
    // _onNotificationAdded so the two stay consistent.
    _shouldSuppressShellBanner() {
        try {
            if (!this._config.isFeatureEnabled('notifPeek')) return false;
            if (!this._dndSettings)
                this._dndSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
            // If the user has DND on, we don't peek — and we also shouldn't eat
            // the shell's banner (which respects DND itself). Return false so the
            // real path runs and honours DND.
            if (!this._dndSettings.get_boolean('show-banners')) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    _watchNotifSource(source) {
        if (!source || this._peekSourceIds.has(source)) return;
        try {
            let addId = source.connect('notification-added',
                (s, notification) => this._onNotificationAdded(s, notification));
            // Clean the map when the source goes away so we don't leak or hold
            // a disposed object.
            let destroyId = source.connect('destroy', () => {
                this._peekSourceIds.delete(source);
            });
            this._peekSourceIds.set(source, [addId, destroyId]);
        } catch (e) {
            // A source shape we don't recognise — skip it quietly.
        }
    }

    // A notification just arrived. Decide whether to peek, then extract its
    // title/body/icon and drive the banner.
    _onNotificationAdded(source, notification) {
        try {
            if (!this._config.isFeatureEnabled('notifPeek')) return;
            // Respect the user's Do-Not-Disturb: if banners are off system-wide,
            // stay quiet too. (Settings object cached — one per shell session.)
            if (!this._dndSettings)
                this._dndSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
            if (!this._dndSettings.get_boolean('show-banners')) return;
            // Don't hijack the pill while the full dashboard is open — that's an
            // intentional interaction and the notification is already in the tab.
            if (this.isExpanded) return;
            // Transient/resident flags vary by shell; a missing flag means show.
            if (notification && notification.acknowledged) return;

            let title = (notification?.title || source?.title || 'Notification').toString();
            let body = (notification?.body || '').toString();
            let gicon = notification?.gicon ?? notification?.icon ??
                        source?.icon ?? source?.gicon ?? null;
            // The notification's action buttons (e.g. "Examine"). In GNOME
            // 46+ these live on `notification.actions` as {label, callback}.
            let actions = Array.isArray(notification?.actions) ? notification.actions : [];
            this._showNotificationPeek(title, body, gicon, notification, actions);
        } catch (e) {
            console.error('NotchNux: notification peek error', e);
        }
    }

    // Morph pill → banner and start the auto-dismiss countdown. If a peek is
    // already showing, just swap its content and restart the timer (so a burst
    // of notifications keeps the banner up and current rather than flickering).
    _showNotificationPeek(title, body, gicon, notification = null, actions = []) {
        if (!this._notifBanner) return;

        this._peekNotification = notification;
        this._notifPeekTitle.set_text(title);
        this._notifPeekBody.set_text(body);
        this._notifPeekBody.visible = body.length > 0;
        if (gicon && this._notifPeekIcon.set_gicon) {
            try { this._notifPeekIcon.set_gicon(gicon); }
            catch (e) { this._notifPeekIcon.icon_name = 'preferences-system-notifications-symbolic'; }
        } else {
            this._notifPeekIcon.icon_name = 'preferences-system-notifications-symbolic';
        }
        this._renderPeekActions(actions);

        if (this._peekActive) {
            // Already peeking — refresh content and restart the dismiss timer.
            this._armPeekDismissTimer();
            this._resizePeekToContent();
            return;
        }
        this._peekActive = true;

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) { this._peekActive = false; return; }

        // The pill stays pinned at the top; the banner grows in below it from the
        // same top-center pivot the expand animation uses, so the two motions feel
        // like one family and the pill's info never blinks out.
        this._surface.add_style_class_name('notchnux-island-peek');
        this._notifBanner.opacity = 0;
        this._notifBanner.visible = true;

        // Set the final width BEFORE measuring height (mirrors expand()). Height
        // measured at the wrong width, or while the actor still carries no
        // allocation, makes Clutter log "needs an allocation" when the ensuing
        // ease tries to update stage views. Fixing the width first gives the
        // banner a real allocation to measure against.
        this.set_width(PEEK_WIDTH);
        let targetHeight = this._measurePeekHeight();
        let targetX = monitor.x + Math.floor((monitor.width - PEEK_WIDTH) / 2);

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.scale_y = 0.9;
        this._surface.scale_x = 0.985;
        this._surface.opacity = 255;
        this._surface.ease({
            scale_x: 1.0, scale_y: 1.0,
            duration: PEEK_ENTER_MS, mode: Clutter.AnimationMode.EASE_OUT_QUINT });

        // Pill stays put — only the banner fades in beneath it.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;
        this._notifBanner.ease({
            opacity: 255, duration: PEEK_ENTER_MS, mode: Clutter.AnimationMode.EASE_OUT_QUINT });
        this.ease({
            x: targetX, y: monitor.y, width: PEEK_WIDTH, height: targetHeight,
            duration: PEEK_ENTER_MS, mode: Clutter.AnimationMode.EASE_OUT_QUINT });

        this._armPeekDismissTimer();
    }

    // Natural height of the banner content at the peek width, floored to the
    // designed height so a one-line notification still reads as a card.
    _measurePeekHeight() {
        let [, nat] = this._notifBanner.get_preferred_height(PEEK_WIDTH);
        // The pill now stays pinned above the banner, so the peek box must be
        // tall enough for both. Add the pill height plus its bottom margin (10px,
        // set on .notchnux-island-peek .notchnux-pill-content in the stylesheet).
        let pillH = 0;
        if (this._pill && this._pill.visible) {
            let [, natPillH] = this._pill.get_preferred_height(PEEK_WIDTH);
            pillH = Math.ceil(natPillH) + 10;
        }
        return Math.max(PEEK_HEIGHT, Math.ceil(nat) + pillH + 20);
    }

    // Re-fit the banner if its content changed while already showing.
    _resizePeekToContent() {
        if (!this._peekActive) return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let targetHeight = this._measurePeekHeight();
        let targetX = monitor.x + Math.floor((monitor.width - PEEK_WIDTH) / 2);
        this.ease({
            x: targetX, width: PEEK_WIDTH, height: targetHeight,
            duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    // Collapse the banner back to the pill. `immediate` skips the timer clear
    // path used when a click is handing off to the full expand.
    _hideNotificationPeek(immediate = false) {
        if (!this._peekActive) return;
        this._peekActive = false;
        this._peekNotification = null;
        this._clearPeekDismissTimer();

        // If the full dashboard is being opened (click handoff), don't animate
        // back to the pill — expand() takes over the surface. Just reset state.
        if (immediate && this.isExpanded === false) {
            // expand() will run right after; hide the banner without a bounce.
            this._notifBanner.visible = false;
            this._notifBanner.opacity = 0;
            this._surface.remove_style_class_name('notchnux-island-peek');
            this._pill.visible = true;
            this._pill.opacity = 255;
            return;
        }

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let pillW = this._pillWidth();
        let targetX = monitor.x + Math.floor((monitor.width - pillW) / 2);

        // Pill stayed visible the whole peek — nothing to fade in, just keep it
        // opaque while the banner shrinks away beneath it.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.ease({
            scale_y: 0.9, scale_x: 0.985,
            duration: PEEK_LEAVE_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_QUINT,
            onComplete: () => {
                this._surface.scale_x = 1.0;
                this._surface.scale_y = 1.0;
            } });

        this._notifBanner.ease({
            opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._notifBanner.visible = false;
                this._surface.remove_style_class_name('notchnux-island-peek');
            } });
        this.ease({
            x: targetX, y: monitor.y, width: pillW, height: PILL_HEIGHT,
            duration: PEEK_LEAVE_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_QUINT });
    }

    _armPeekDismissTimer() {
        this._clearPeekDismissTimer();
        this._peekDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_DISMISS_MS, () => {
            this._peekDismissId = 0;
            // Don't yank the banner out from under the pointer — reschedule.
            if (this._peekBannerHovered()) { this._armPeekDismissTimer(); return GLib.SOURCE_REMOVE; }
            this._hideNotificationPeek();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPeekDismissTimer() {
        if (this._peekDismissId) {
            GLib.Source.remove(this._peekDismissId);
            this._peekDismissId = 0;
        }
    }

    // True if the pointer is currently over the banner (used so the auto-dismiss
    // waits until the user moves away).
    _peekBannerHovered() {
        if (!this._notifBanner || !this._notifBanner.visible) return false;
        let [px, py] = global.get_pointer();
        let [ax, ay] = this.get_transformed_position();
        return px >= ax && px <= ax + this.get_width() &&
               py >= ay && py <= ay + this.get_height();
    }

    _teardownNotificationWatch() {
        this._clearPeekDismissTimer();
        this._removeBannerSuppression();
        try {
            if (this._peekSourceAddedId && Main.messageTray) {
                Main.messageTray.disconnect(this._peekSourceAddedId);
                this._peekSourceAddedId = 0;
            }
            if (this._peekSourceIds) {
                for (let [source, ids] of this._peekSourceIds) {
                    for (let id of ids) {
                        try { source.disconnect(id); } catch (e) {}
                    }
                }
                this._peekSourceIds.clear();
            }
        } catch (e) {
            // ignore — shutting down
        }
    }

    // Dismiss all current notification sources. Best-effort across shell
    // versions — same defensive posture as _collectNotifications.
    _clearNotifications() {
        try {
            let tray = Main.messageTray;
            let sources = tray?.getSources ? tray.getSources() : (tray?._sources ?? []);
            for (let source of [...sources]) {
                if (source?.destroy) source.destroy();
            }
        } catch (e) {
            // ignore — nothing to clear or API shape changed
        }
    }

    // Gather current notification messages from the calendar message list.
    // Shell internals here are renamed often, so probe the source of truth —
    // the live notification queue in Main.messageTray — and fall back to
    // scraping the dateMenu message-list actors if that shape ever changes.
    _collectNotifications() {
        let out = [];

        // 1. Preferred: the message tray's own source/notification model.
        try {
            let tray = Main.messageTray;
            let sources = tray?.getSources ? tray.getSources() : (tray?._sources ?? []);
            for (let source of sources) {
                let notifs = source?.notifications ?? source?._notifications ?? [];
                for (let n of notifs) {
                    if (n?.acknowledged) continue;
                    out.push({
                        title: (n.title || source.title || 'Notification').toString(),
                        body: (n.body || '').toString()
                    });
                }
            }
        } catch (e) {
            // fall through to the actor-scraping path
        }
        if (out.length > 0) return out;

        // 2. Fallback: scrape the dateMenu message list's Message actors.
        try {
            let msgList = Main.panel.statusArea.dateMenu?._messageList;
            // The list of message groups/sections lives under different names
            // depending on the shell version; walk the whole subtree and pick
            // out actors that expose a notification's title/body.
            let stack = msgList ? [msgList] : [];
            let seen = 0;
            while (stack.length && seen < 2000) {
                seen++;
                let actor = stack.pop();
                let title = actor?.notification?.title ?? actor?._notification?.title ?? actor?.title;
                if (typeof title === 'string' && title.length) {
                    let body = actor?.notification?.body ?? actor?._notification?.body ?? '';
                    out.push({ title, body: (body || '').toString() });
                    continue; // don't descend into a matched message
                }
                let kids = actor?.get_children ? actor.get_children() : [];
                for (let k of kids) stack.push(k);
            }
        } catch (e) {
            // give up quietly — empty state renders
        }
        return out;
    }

    // ============================================================
    // Tab: Shelf — a temporary file holding area plus quick-share.
    // Files live in ~/.local/share/notchnux/shelf and are wiped on shell
    // restart (see the clearShelf() call in _init). Each file can be opened,
    // revealed in Files, copied (as a real file via wl-copy, or its path as a
    // fallback), or removed. A small notes box below offers quick-share text.
    // ============================================================
    _renderShelfTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-shelf-panel', vertical: true, x_expand: true, y_expand: true });

        let files = this._shelf.getFiles();

        // Header: "Shelf" + count badge · Add file · Clear.
        let header = new St.BoxLayout({ style_class: 'nook-shelf-header', vertical: false, x_expand: true });
        let titleBox = new St.BoxLayout({ vertical: false, x_expand: true });
        titleBox.add_child(new St.Label({ text: 'Shelf', style_class: 'nook-shelf-title', y_align: Clutter.ActorAlign.CENTER }));
        if (files.length > 0) {
            let badge = new St.Bin({ style_class: 'nook-shelf-badge', y_align: Clutter.ActorAlign.CENTER });
            badge.set_style(`background-color: ${accentHex()};`);
            badge.set_child(new St.Label({ text: String(files.length) }));
            titleBox.add_child(badge);
        }
        header.add_child(titleBox);

        if (files.length > 0) {
            let clearBtn = new St.Button({ style_class: 'nook-clear-btn', reactive: true, y_align: Clutter.ActorAlign.CENTER });
            let clearRow = new St.BoxLayout({ vertical: false });
            clearRow.add_child(new St.Icon({ icon_name: 'edit-clear-all-symbolic', icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
            clearRow.add_child(new St.Label({ text: 'Clear', y_align: Clutter.ActorAlign.CENTER }));
            clearBtn.set_child(clearRow);
            clearBtn.connect('clicked', () => { this._shelf.clearShelf(); this._renderActiveTab(); });
            header.add_child(clearBtn);
        }
        panel.add_child(header);

        // Cache the paired/connected devices once per render so every file row
        // shares the same list without re-hitting D-Bus.
        let devices = this._shelf.getShareDevices();

        if (files.length > 0) {
            let scroll = new St.ScrollView({ style_class: 'nook-shelf-scroll', x_expand: true, y_expand: true });
            scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            let list = new St.BoxLayout({ style_class: 'nook-shelf-list', vertical: true, x_expand: true });
            for (let f of files)
                list.add_child(this._buildShelfRow(f, devices));
            scroll.set_child(list);
            panel.add_child(scroll);
        }

        // Drop zone: always shown so it's a persistent target. Wayland won't
        // deliver external file drops into our actors, so "drop" here means
        // click-to-browse or paste a file copied in the file manager.
        panel.add_child(this._buildDropZone(files.length === 0));

        panel.add_child(this._buildQuickShareBox(devices));

        this._contentContainer.add_child(panel);
    }

    // The click-to-add / paste-from-clipboard drop zone. `spacious` gives it
    // extra vertical room when the shelf is empty so it reads as the main hero.
    _buildDropZone(spacious) {
        let zone = new St.Button({
            style_class: spacious ? 'nook-shelf-drop nook-shelf-drop-spacious' : 'nook-shelf-drop',
            reactive: true, can_focus: false, x_expand: true,
        });
        let inner = new St.BoxLayout({ vertical: true, x_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        inner.add_child(new St.Icon({ icon_name: 'document-send-symbolic',
            icon_size: spacious ? 30 : 22, style_class: 'nook-shelf-drop-icon',
            x_align: Clutter.ActorAlign.CENTER }));
        inner.add_child(new St.Label({ text: 'Drop files here',
            style_class: 'nook-shelf-drop-title', x_align: Clutter.ActorAlign.CENTER }));
        inner.add_child(new St.Label({ text: 'Click to browse · or paste a copied file',
            style_class: 'nook-shelf-drop-sub', x_align: Clutter.ActorAlign.CENTER }));

        // A small "Paste" affordance inside the zone. Its own click must not
        // also trigger the zone's browse click, so it swallows the event.
        let pasteBtn = new St.Button({ style_class: 'nook-shelf-paste', reactive: true, can_focus: false,
            x_align: Clutter.ActorAlign.CENTER });
        let pasteRow = new St.BoxLayout({ vertical: false });
        pasteRow.add_child(new St.Icon({ icon_name: 'edit-paste-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
        pasteRow.add_child(new St.Label({ text: 'Paste from clipboard', y_align: Clutter.ActorAlign.CENTER }));
        pasteBtn.set_child(pasteRow);
        pasteBtn.set_style(`color: ${accentHex()};`);
        pasteBtn.connect('clicked', () => {
            this._shelf.pasteFilesFromClipboard((added) => {
                if (added === -1) { this._flashShareStatus('Install wl-clipboard to paste files'); return; }
                if (added > 0 && this._activeTab === 'shelf') this._renderActiveTab();
                else if (added === 0) this._flashShareStatus('No file on the clipboard');
            });
            return Clutter.EVENT_STOP;
        });
        inner.add_child(pasteBtn);

        zone.set_child(inner);
        zone.connect('clicked', () => {
            this._shelf.pickFilesIntoShelf((added) => {
                if (added > 0 && this._activeTab === 'shelf')
                    this._renderActiveTab();
            });
        });
        return zone;
    }

    // One file row: icon + name/size, then Send / Copy / Open / Reveal / Remove.
    _buildShelfRow(f, devices) {
        let row = new St.BoxLayout({ style_class: 'nook-shelf-row', vertical: false, x_expand: true });
        row.add_child(new St.Icon({ icon_name: f.icon, icon_size: 20, style_class: 'nook-shelf-row-icon', y_align: Clutter.ActorAlign.CENTER }));

        let meta = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let name = new St.Label({ text: f.name, style_class: 'nook-shelf-row-name' });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        meta.add_child(name);
        meta.add_child(new St.Label({ text: f.sizeStr, style_class: 'nook-shelf-row-size' }));
        row.add_child(meta);

        let actions = new St.BoxLayout({ style_class: 'nook-shelf-row-actions', vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const mkAction = (icon, tip, fn) => {
            let b = new St.Button({ style_class: 'nook-shelf-action', reactive: true, can_focus: false });
            b.set_child(new St.Icon({ icon_name: icon, icon_size: 14 }));
            b.connect('clicked', fn);
            actions.add_child(b);
            return b;
        };
        // Send: quick-share this file to a paired GSConnect device (the Linux
        // "nearby share"). With one device we send straight to it; with several
        // we pop a small menu to pick. Hidden entirely when nothing is paired.
        if (devices && devices.length === 1) {
            let d = devices[0];
            mkAction('send-to-symbolic', `Send to ${d.name}`, () => {
                if (this._shelf.sendFileToDevice(d.path, f.path))
                    this._flashShareStatus(`Sending to ${d.name}…`);
                else
                    this._flashShareStatus('Send failed');
            });
        } else if (devices && devices.length > 1) {
            let sendBtn = mkAction('send-to-symbolic', 'Send to device', () => {});
            sendBtn.connect('clicked', () => this._showDevicePicker(sendBtn, f, devices));
        }
        // Copy: put the real file on the clipboard, falling back to its URI as
        // text if wl-copy isn't available.
        mkAction('edit-copy-symbolic', 'Copy', () => {
            if (!this._shelf.copyFileToClipboard(f.path))
                this._shelf.copyToClipboard(f.uri);
            this._flashShareStatus('Copied to clipboard');
        });
        mkAction('document-open-symbolic', 'Open', () => this._shelf.openFile(f.path));
        mkAction('folder-symbolic', 'Reveal', () => this._shelf.showInFiles(f.path));
        mkAction('user-trash-symbolic', 'Remove', () => {
            this._shelf.deleteFile(f.path);
            this._renderActiveTab();
        });
        row.add_child(actions);

        return row;
    }

    // Quick Share footer: a status line plus a hint about where files go. The
    // per-file "Send" actions are the actual share control (they target paired
    // GSConnect devices); this box just reports what's happening and nudges the
    // user when there's no device to send to. `devices` is the list already
    // gathered by the render.
    _buildQuickShareBox(devices) {
        let box = new St.BoxLayout({ style_class: 'nook-share-box', vertical: true, x_expand: true });

        let head = new St.BoxLayout({ vertical: false, x_expand: true });
        head.add_child(new St.Label({ text: 'Quick share', style_class: 'nook-share-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));

        // Right-hand hint reflects device state at a glance.
        let hintText;
        if (devices.length === 1) hintText = devices[0].name;
        else if (devices.length > 1) hintText = `${devices.length} devices`;
        else if (this._shelf.isShareServiceAvailable()) hintText = 'No device connected';
        else hintText = 'GSConnect not running';
        let hint = new St.Label({ text: hintText, style_class: 'nook-share-devlabel', y_align: Clutter.ActorAlign.CENTER });
        head.add_child(hint);
        box.add_child(head);

        // Subline: how to get a device when there isn't one.
        if (devices.length === 0) {
            let sub = new St.Label({
                text: this._shelf.isShareServiceAvailable()
                    ? 'Pair & connect a device in GSConnect to send files.'
                    : 'Install/enable the GSConnect extension to send files to your phone.',
                style_class: 'nook-share-sub', x_expand: true });
            sub.clutter_text.line_wrap = true;
            box.add_child(sub);
        }

        let status = new St.Label({ text: '', style_class: 'nook-share-status', x_expand: true });
        status.visible = false;
        box.add_child(status);
        this._shareStatus = status;

        return box;
    }

    // Popup a device menu for a file when more than one device is paired. Reuses
    // the Studio picker registry so the outside-click guard treats it as
    // "inside" and picking a device doesn't collapse the dashboard.
    _showDevicePicker(anchorBtn, f, devices) {
        let menu = new PopupMenu.PopupMenu(anchorBtn, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._studioMenus.push(menu);
        for (let d of devices) {
            let item = new PopupMenu.PopupMenuItem(d.name);
            item.connect('activate', () => {
                if (this._shelf.sendFileToDevice(d.path, f.path))
                    this._flashShareStatus(`Sending to ${d.name}…`);
                else
                    this._flashShareStatus('Send failed');
            });
            menu.addMenuItem(item);
        }
        anchorBtn.connect('destroy', () => this._destroyStudioMenu(menu));
        menu.open();
    }

    // Briefly show a confirmation line under the quick-share box, then hide it.
    _flashShareStatus(msg) {
        if (!this._shareStatus) return;
        this._shareStatus.set_text(msg);
        this._shareStatus.visible = true;
        if (this._shareStatusId)
            GLib.source_remove(this._shareStatusId);
        this._shareStatusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
            if (this._shareStatus) this._shareStatus.visible = false;
            this._shareStatusId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ============================================================
    // Interaction — open on hover/click, close only on outside click
    // or when the pointer leaves the whole widget.
    // ============================================================
    _onCrossing(event, entering) {
        // Ignore crossings that stay within our own subtree (moving between
        // child controls re-fires enter/leave on the parent).
        let related = event.get_related();
        if (related && this._isDescendant(related))
            return Clutter.EVENT_PROPAGATE;

        // A click inside the widget triggers an implicit pointer grab, which
        // fires a spurious leave-event whose `related` is null while the
        // pointer is still physically over us. Ignore those so clicking a
        // button never schedules a collapse. Verify against the real pointer
        // position rather than trusting the (grab-poisoned) crossing.
        if (!entering && related === null && this._pointerIsOverWidget())
            return Clutter.EVENT_PROPAGATE;

        this._pointerInside = entering;

        if (entering) {
            // Cancel any pending collapse and (if collapsed) schedule expand.
            if (this._collapseTimeoutId) {
                GLib.Source.remove(this._collapseTimeoutId);
                this._collapseTimeoutId = null;
            }
            if (!this.isExpanded && !this._expandTimeoutId) {
                this._expandTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                    this._expandTimeoutId = null;
                    if (this._pointerInside && !this.isExpanded)
                        this.expand();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            // Pointer truly left the widget: cancel pending expand, and if
            // open, schedule a collapse (generous delay for cursor travel).
            if (this._expandTimeoutId) {
                GLib.Source.remove(this._expandTimeoutId);
                this._expandTimeoutId = null;
            }
            if (this.isExpanded && !this._collapseTimeoutId) {
                this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._collapseTimeoutId = null;
                    if (!this._pointerInside && this.isExpanded)
                        this.collapse();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onClicked(event) {
        // Clicking the collapsed pill opens it. Clicks inside the expanded
        // dashboard are always left to propagate to their controls — the
        // dashboard never collapses from an internal click.
        if (event.get_button() === 1 && !this.isExpanded)
            this.expand();
        return Clutter.EVENT_PROPAGATE;
    }

    _onStageClicked(event) {
        if (!this.isExpanded) return Clutter.EVENT_PROPAGATE;
        // Only collapse for clicks that are genuinely outside us. Check both
        // the event source's ancestry AND the click coordinates against our
        // box — re-rendering a tab can destroy the clicked actor before this
        // handler runs, so the actor test alone is unreliable.
        let [ex, ey] = event.get_coords();
        let [ax, ay] = this.get_transformed_position();
        let inside = ex >= ax && ex <= ax + this.get_width() &&
                     ey >= ay && ey <= ay + this.get_height();
        // A Studio device picker's PopupMenu lives in Main.uiGroup, outside our
        // box and not a descendant of ours. Clicking one of its items must NOT
        // collapse the dashboard — treat any open menu (or its actor's subtree)
        // as "inside" so device selection works.
        if (!inside && this._clickInStudioMenu(event.get_source()))
            inside = true;
        if (!inside && !this._isDescendant(event.get_source()))
            this._collapseImmediately();
        return Clutter.EVENT_PROPAGATE;
    }

    // True when `source` is (a descendant of) any currently-open Studio picker
    // menu. Guards the click-outside collapse so picking a device doesn't close
    // the whole dashboard.
    _clickInStudioMenu(source) {
        if (!this._studioMenus || this._studioMenus.length === 0) return false;
        for (let menu of this._studioMenus) {
            if (!menu || !menu.actor || !menu.isOpen) continue;
            for (let a = source; a; a = a.get_parent()) {
                if (a === menu.actor) return true;
            }
        }
        return false;
    }

    _collapseImmediately() {
        this._clearTimers();
        this._pointerInside = false;
        this.collapse();
    }

    // ============================================================
    // Expand / collapse animation
    // ============================================================
    expand() {
        if (this.isExpanded) return;
        // A notification peek is a transient pill state; opening the full
        // dashboard supersedes it. Tear its state/timer down (immediate, so it
        // doesn't animate back to the pill and fight this expand).
        if (this._peekActive) this._hideNotificationPeek(true);
        this.isExpanded = true;
        this._isExpanding = true;
        this._surface.add_style_class_name('notchnux-island-expanded');
        // Never let a render error wedge us in the "expanded" state. If
        // _renderActiveTab throws, isExpanded would stay true while nothing is
        // shown, and _onCrossing's `if (!this.isExpanded)` guard would then
        // refuse to ever expand again — the pill looks collapsed but silently
        // stops opening on hover. Roll the state back and re-raise so the
        // failure is still logged.
        try {
            this._renderActiveTab();
        } catch (e) {
            this._isExpanding = false;
            this.isExpanded = false;
            this._surface.remove_style_class_name('notchnux-island-expanded');
            throw e;
        }
        this._isExpanding = false;

        // Keep the Tray tab's meters/devices/battery live while open.
        this._startSystemRefresh();
        // Refresh the Alerts tab count badge on every open (the active tab may
        // not be the notifications tab, so its own render won't run).
        this._updateTabCountBadge();

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let targetX = monitor.x + Math.floor((monitor.width - DASHBOARD_WIDTH) / 2);
        let targetY = monitor.y;

        this._dashboard.opacity = 0;
        this._dashboard.visible = true;

        // Set width first so height measurement uses the final width, then
        // measure the freshly-rendered tab to get its natural height.
        this.set_width(DASHBOARD_WIDTH);
        let targetHeight = this._measureDashboardHeight();

        // The whole open is one motion at one duration and one curve. Everything
        // (the box growing, the surface unfolding, the content fading in) shares
        // EASE_OUT_QUINT so nothing arrives early or fights another timeline —
        // that mismatch is what read as "not smooth". No BACK/overshoot, no
        // opacity dip on the surface: it stays fully opaque and simply grows
        // from the top-center pivot where the pill sits.
        const DURATION = 340;
        const CURVE = Clutter.AnimationMode.EASE_OUT_QUINT;

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.scale_y = 0.9;
        this._surface.scale_x = 0.985;
        this._surface.opacity = 255;
        this._surface.ease({
            scale_x: 1.0, scale_y: 1.0,
            duration: DURATION, mode: CURVE });

        // The pill stays pinned at the top of the surface (it never fades out) —
        // the dashboard simply unfolds below it as the box grows, so the pill's
        // time/battery/mic/cam info is continuous through the whole expand and
        // there's no jarring swap. Only the dashboard fades in.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;
        this._dashboard.ease({
            opacity: 255, duration: DURATION, mode: CURVE });
        this.ease({
            x: targetX, y: targetY, width: DASHBOARD_WIDTH, height: targetHeight,
            duration: DURATION, mode: CURVE });

        // The tab strip isn't allocated until this open lays out, so defer the
        // scroll: once sizes are real, slide the active pill into view. Without
        // this, opening straight onto a tab near the right edge (e.g. Alerts)
        // leaves its pill scrolled off-screen behind the settings button.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.isExpanded)
                this._scrollActiveTabIntoView();
            return GLib.SOURCE_REMOVE;
        });
    }

    collapse() {
        if (!this.isExpanded) return;
        this.isExpanded = false;
        this._stopMediaAnimations();
        this._stopSystemRefresh();
        this._surface.remove_style_class_name('notchnux-island-expanded');

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let pillW = this._pillWidth();
        let targetX = monitor.x + Math.floor((monitor.width - pillW) / 2);
        let targetY = monitor.y;

        // The pill stayed visible the whole time it was expanded, so there's
        // nothing to fade back in — just make sure it's fully opaque.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;

        // Collapse mirrors expand: one duration, one curve, everything settling
        // together. Retract the surface back toward the pill from the same
        // top-center pivot while the box shrinks underneath it.
        const DURATION = 280;
        const CURVE = Clutter.AnimationMode.EASE_IN_OUT_QUINT;

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.ease({
            scale_y: 0.9, scale_x: 0.985,
            duration: DURATION, mode: CURVE,
            onComplete: () => {
                // Reset transform so the collapsed pill renders at full size.
                this._surface.scale_x = 1.0;
                this._surface.scale_y = 1.0;
            } });

        this._dashboard.ease({
            opacity: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { this._dashboard.visible = false; } });
        this.ease({
            x: targetX, y: targetY, width: pillW, height: PILL_HEIGHT,
            duration: DURATION, mode: CURVE });
    }

    // ============================================================
    // Clock / battery poll
    // ============================================================
    _startClock() {
        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopClock() {
        if (this._clockTimeoutId) {
            GLib.Source.remove(this._clockTimeoutId);
            this._clockTimeoutId = null;
        }
    }

    _startWeatherRefresh() {
        this._stopWeatherRefresh();
        this._weatherRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 900, () => {
            this._weather.updateWeather();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWeatherRefresh() {
        if (this._weatherRefreshId) {
            GLib.Source.remove(this._weatherRefreshId);
            this._weatherRefreshId = null;
        }
    }

    // Live refresh for the Tray tab: while it's the visible tab, re-poll and
    // re-render every 3s so CPU/RAM/SWAP/DISK meters, connected devices and
    // battery levels stay current without the user having to reopen the panel.
    _startSystemRefresh() {
        this._stopSystemRefresh();
        this._systemRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            if (this.isExpanded) {
                // Keep the Alerts count badge live regardless of which tab is up,
                // so a notification arriving while the dashboard is open is
                // reflected immediately.
                this._updateTabCountBadge();
                // Rebuild the on-screen tab when its data changes out from under
                // it. The Tray meters/devices refresh every tick; the Alerts
                // list only rebuilds when the queue actually changed, so an open
                // scroll/expanded card isn't reset out from under the user.
                if (this._activeTab === 'system') {
                    this._renderActiveTab();
                } else if (this._activeTab === 'notifications') {
                    let sig = this._notificationsSignature(this._collectNotifications());
                    if (sig !== this._notifSignature)
                        this._renderActiveTab();
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSystemRefresh() {
        if (this._systemRefreshId) {
            GLib.Source.remove(this._systemRefreshId);
            this._systemRefreshId = null;
        }
    }

    _updateClock() {
        let date = new Date();
        this._pillClock.set_text(pillClockText(date));

        let showBattery = this._config.isFeatureEnabled('showBattery');
        this._pillBatteryBox.visible = showBattery;
        if (!showBattery)
            return;
        let bat = this._system.getBatteryInfo();
        let iconName = 'battery-good-symbolic';
        if (bat.isCharging) iconName = 'battery-caution-charging-symbolic';
        else if (bat.percentage <= 20) iconName = 'battery-caution-symbolic';
        this._pillBatteryIcon.icon_name = iconName;
        this._pillBatteryLabel.set_text(`${Math.round(bat.percentage)}%`);

        // The clock string ("16 Thu · 3:09 PM") and battery % ("9%"→"100%") both
        // change the content width, so the collapsed pill must resize to keep the
        // clock un-truncated. _applyPillWidth re-measures and re-balances, but
        // only bother easing when the target actually moved, so we don't kick off
        // a width tween on every idle second.
        if (!this.isExpanded)
            this._syncPillWidth();
    }

    // Re-apply the collapsed pill's content-sized width if it has drifted from
    // the current width (e.g. clock text or battery % changed). Cheap no-op when
    // nothing moved. Always keeps the clock centred via _applyPillWidth.
    _syncPillWidth() {
        let target = this._pillWidth();
        if (Math.abs(this.get_width() - target) > 1)
            this._applyPillWidth();
        else
            this._balancePillClock();
    }
});
