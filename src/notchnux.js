import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { SystemHelper } from './helpers/system.js';
import { MprisHelper } from './helpers/mpris.js';
import { WeatherHelper } from './helpers/weather.js';
import { MediaHelper } from './helpers/media.js';
import { ShelfHelper } from './helpers/shelf.js';
import { FileDropBridge } from './helpers/filedrop.js';
import { WallpaperHelper } from './helpers/wallpaper.js';
import { SlitDeck } from './helpers/slitdeck.js';
import { Vinyl, AlbumArtDisc, Knob, AnalogClock, EqBars, CameraView, ACCENT, setAccent, accentHex, accentRgbStr } from './helpers/widgets.js';
import { TAB_DEFS, FEATURE_DEFS, blurPreset } from './helpers/config.js';
import { fmt } from './helpers/format.js';
import { GlassBackdrop, createShoulder, SHOULDER_SIZE, PILL_HEIGHT } from './helpers/island.js';
import { springTo, stopSpring, addPressFeedback } from './helpers/motion.js';
import { installProductivity } from './tabs/productivity.js';
import { installLedge, swapContent } from './tabs/ledge.js';
import { installTray } from './tabs/tray.js';
import { logError } from './helpers/log.js';

// Configuration constants
// Minimum idle width. _pillWidth() measures the actual content (clock + battery
// + privacy dots) and grows past this when the clock string is long, so the
// time never has to ellipsize into "3:...". This is just the floor so a short
// clock still gets a comfortably wide pill.
const PILL_WIDTH = 260;
// Minimum width while a track is playing (title zone present). Same deal:
// content measurement can push wider, this is the floor.
const PILL_WIDTH_MUSIC = 340;

// 12-hour clock with an explicit AM/PM marker (e.g. "5:04 PM"). Forcing
// hour12 keeps the format stable regardless of the user's locale, so the pill
// is sized once and never clips the meridiem.
const PILL_TIME_FMT = { hour: 'numeric', minute: '2-digit', hour12: true };
// Weekday + day-of-month prefix shown before the time (e.g. "Thu, 19"). Kept
// short so the whole clock stays compact and comfortably centered in the pill.
const PILL_DATE_FMT = { weekday: 'short', day: 'numeric' };
// Compose the full pill clock text: "Thu, 19  ·  3:19 PM".
function pillClockText(date) {
    return `${fmt(date, PILL_DATE_FMT)}  ·  ${fmt(date, PILL_TIME_FMT)}`;
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
    _init(extension, config) {
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
        this._config = config;
        setAccent(this._config.accentRgb);
        this.isExpanded = false;
        this._isExpanding = false;
        this._pointerInside = false;
        this._activeTab = null;   // _buildDashboard picks the first visible tab
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
        GLib.mkdir_with_parents(this._artCacheDir.get_path(), 0o700);
        this._artCancellable = new Gio.Cancellable();
        this._artPruneId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 20, () => {
            this._artPruneId = 0;
            this._pruneArtCache();
            return GLib.SOURCE_REMOVE;
        });

        // Initialize helper modules
        this._system = new SystemHelper();
        this._mpris = new MprisHelper();
        this._weather = new WeatherHelper();
        // The shelf is scratch space for one login: wipe whatever survived the
        // last session (but not on every lock/unlock — see ShelfHelper).
        this._shelf = new ShelfHelper();
        this._shelf.clearOncePerSession();
        // Last known GSConnect state, refreshed asynchronously by the Shelf tab.
        this._shareDevices = [];
        this._shareAvailable = true;
        this._shareSig = JSON.stringify([true, []]);
        // Rotates the desktop wallpaper through a user-chosen folder. Driven
        // entirely by config; started/paused below once helpers are up.
        this._wallpaper = new WallpaperHelper();

        // Inner rounded surface — this is what the user sees.
        // Clipped: during the expand/collapse spring the box is briefly smaller
        // than the dashboard fading in or out, and unclipped content hung below
        // the rounded bottom edge for a few frames.
        this._surface = new St.BoxLayout({
            style_class: 'notchnux-island',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            vertical: true });
        this.add_child(this._surface);

        // 1. Collapsed pill
        this._buildPill();
        // 2. Expanded dashboard
        this._buildDashboard();
        // 3. Transient notification-peek banner
        this._buildNotifBanner();

        // The pill and the alert bar share one slot at the top of the island
        // and swap in place (see tabs/ledge.js swapContent).
        this._compactStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(), x_expand: true });
        this._compactStack.add_child(this._pill);
        this._surface.add_child(this._compactStack);
        this._surface.add_child(this._dashboard);
        this._surface.add_child(this._notifBanner);

        this._dashboard.visible = false;
        this._notifBanner.visible = false;
        // Tasks / notes / focus timer (+ the pill's live timer zone).
        this._initProductivity();
        // Alerts, hide-when-idle, launcher, clipboard, lyrics, keep awake…
        this._initLedge();
        // Recolour the active-state chrome to match the persisted accent.
        this._applyAccentStyles();
        // Shoulders + the (hidden unless enabled) glass backdrop.
        this._buildBlur();
        this._applyBlur();
        this.set_size(PILL_WIDTH, PILL_HEIGHT);

        this.connect('destroy', () => this._onDestroy());
        // Size the pill to its real content the first time it's on screen
        // (everything before that ran off-stage at the floor width).
        let mappedId = this.connect('notify::mapped', () => {
            if (!this.mapped) return;
            this.disconnect(mappedId);
            this._syncPillWidth();
        });

        // Hover + click on the widget
        this.connect('enter-event', (a, e) => this._onCrossing(e, true));
        this.connect('leave-event', (a, e) => this._onCrossing(e, false));
        this.connect('button-press-event', (a, e) => this._onClicked(e));

        // Click anywhere else on the stage collapses the dashboard.
        this._stageClickId = global.stage.connect('button-press-event', (s, e) => this._onStageClicked(e));
        this._keyFocusId = global.stage.connect('notify::key-focus', () => this._onStageKeyFocus());

        // Helper callbacks refresh the live tab
        // MPRIS fires metadata + playback callbacks back to back; coalesce them
        // into one in-place update per main-loop turn.
        this._mpris.onMetadataChanged = () => this._queueMediaUpdate();
        this._mpris.onPlaybackChanged = () => this._queueMediaUpdate();
        this._system.onVolumeChanged = () => this._onVolumeChanged();
        this._weather.onWeatherUpdated = () => this._onWeatherUpdated();
        // Mic mute + mic/camera in-use changes repaint the pill indicators.
        this._system.onMicChanged = () => this._updatePrivacyIndicators();
        this._system.onPrivacyChanged = () => this._updatePrivacyIndicators();
        // WiFi/NM state changes (incl. NM finishing its async startup) re-render
        // the Tray tab so the WiFi row populates and stays live.
        this._system.onWifiChanged = () => this._queueTrayCardsRefresh();

        if (this._config.isFeatureEnabled('calendarSync'))
            this._initCalendarServer();
        this._initNotificationWatch();
        this._system.setPrivacyPolling(this._config.isFeatureEnabled('showPrivacy'));
        this._startClock();
        if (this._config.isFeatureEnabled('weatherAutoRefresh'))
            this._startWeatherRefresh();
        // GNOME re-enables us on every unlock; a forecast fetched a few minutes
        // ago is restored from cache, so only hit GeoClue + the network when it
        // is actually stale — and not in the middle of the unlock animation.
        // (The cache is read asynchronously, so freshness is checked when the
        // timer fires, by which time it has loaded.)
        this._weatherKickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
            this._weatherKickId = 0;
            if (!this._weather.isFresh)
                this._weather.updateWeather();
            return GLib.SOURCE_REMOVE;
        });
        // Reflect any already-playing media in the pill right away, rather
        // than waiting for the next MPRIS property-change callback.
        this._refreshLive();
        this._updatePrivacyIndicators();

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this.reposition());
        this.reposition();
        // Files dragged from other apps open the Shelf and can be dropped on it.
        this._initFileDrop();

        // Keep the notch drawn above window content. addTopChrome with
        // trackFullscreen:false stops GNOME from *hiding* the notch on the
        // fullscreen signal, but it does NOT lift it above windows in the
        // stacking order — so maximizing ANY app (Chrome, Files, …) composites
        // that window over the top strip and the notch visually disappears.
        // The shell restacks its actors on every window map/raise/focus change,
        // so re-raise the notch to the top of its parent on each 'restacked'.
        this._restackedId = global.display.connect('restacked', () => {
            this._raiseToTop();
            // A restack means a window was raised/mapped/minimized or the
            // workspace switched — any of which can change whether a window now
            // covers the top strip. Re-evaluate the unredirect inhibit (cheap
            // no-op unless the reclaim watch is active).
            this._queueUnredirectUpdate();
        });
        this._raiseToTop();

        // Watch the config file so edits made in the separate prefs.js process
        // apply to the live notch without a shell restart.
        this._watchConfig();

        // Apply the panel hide/reclaim preference now that everything is mounted.
        this._applyPanelVisibility();

        // Bring up wallpaper rotation with the persisted settings, and start
        // watching battery/fullscreen so it can auto-pause.
        this._wallpaper.configure(this._config.wallpaper);
        this._startWallpaperPauseMonitor();
        this._system.onPowerReady = () => this._hookBatteryDevice();
        this._hookBatteryDevice();

        // Pre-warm the dashboard once the shell has settled after login /
        // unlock, so the first hover-open doesn't pay St's one-off style
        // resolution (~70 ms) in the middle of its animation.
        this._prewarmId = GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
            this._prewarmId = 0;
            this._prewarmDashboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Build the active tab and resolve its styles while nothing is animating.
    // Showing, measuring and hiding happen in one JS turn, so no frame is ever
    // painted with the dashboard visible.
    _prewarmDashboard() {
        if (this._destroyed || this.isExpanded || this._peekActive || !this.get_stage())
            return;
        let host = this._hostFor(this._activeTab);
        if (host.get_n_children() === 0)
            this._renderActiveTab();
        let wasVisible = host.visible;
        host.visible = true;
        this._dashboard.visible = true;
        this._dashboard.get_preferred_height(DASHBOARD_WIDTH);
        this._dashboard.visible = false;
        host.visible = wasVisible;
    }

    // Feed the wallpaper rotator the current battery + fullscreen state and keep
    // it updated: battery via _hookBatteryDevice(), fullscreen via the
    // display's in-fullscreen-changed signal.
    _startWallpaperPauseMonitor() {
        this._pushWallpaperPauseState();
        try {
            this._wpFullscreenId = global.display.connect('in-fullscreen-changed',
                () => this._pushWallpaperPauseState());
        } catch (e) {}
    }

    _pushWallpaperPauseState() {
        // UPower state 2 = discharging (on battery); anything else (charging,
        // full, AC with no battery) counts as not on battery.
        let onBattery = this._system.displayDevice?.state === 2;
        let inFullscreen = false;
        try {
            let n = global.display.get_n_monitors();
            for (let i = 0; i < n && !inFullscreen; i++)
                inFullscreen = global.display.get_monitor_in_fullscreen(i);
        } catch (e) {}
        this._wallpaper?.setPauseState({ onBattery, inFullscreen });
    }

    _stopWallpaperPauseMonitor() {
        if (this._wpFullscreenId) {
            try { global.display.disconnect(this._wpFullscreenId); } catch (e) {}
            this._wpFullscreenId = 0;
        }
    }

    // Follow the laptop battery (UPower display device): the pill readout and
    // the wallpaper's pause-on-battery both react to it. Called at startup and
    // again when the async UPower client comes up.
    _hookBatteryDevice() {
        this._unhookBatteryDevice();
        let dev = this._system.displayDevice;
        if (!dev) return;
        this._batteryDevice = dev;
        this._batteryIds = ['notify::percentage', 'notify::state'].map(sig =>
            dev.connect(sig, () => {
                this._updateClock();
                this._pushWallpaperPauseState();
                this._onPowerSample();
            }));
        this._updateClock();
        this._pushWallpaperPauseState();
        this._onPowerSample();
    }

    _unhookBatteryDevice() {
        for (let id of this._batteryIds ?? [])
            this._batteryDevice.disconnect(id);
        this._batteryIds = null;
        this._batteryDevice = null;
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
            wallpaperKey: JSON.stringify(this._config.wallpaper),
            blurKey: JSON.stringify(this._config.blur),
            trayMirrorKey: this._config.trayMirrorKey,
            pinnedKey: JSON.stringify(this._config.pinnedTabs),
            keepAwake: this._config.keepAwake,
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
            logError('Failed to watch config file.', e);
        }
    }

    // Re-read config from disk and apply whatever changed since the last
    // snapshot. Kept diff-based so an accent tweak doesn't needlessly rebuild
    // the whole dashboard, and a tab toggle doesn't repaint unrelated chrome.
    _onConfigFileChanged() {
        if (this._destroyed) return;
        this._configCancellable ??= new Gio.Cancellable();
        this._config.reloadAsync(this._configCancellable, () => {
            if (!this._destroyed)
                this._applyConfigChange();
        });
    }

    _applyConfigChange() {
        let prev = this._configState;
        let next = this._configSnapshot();
        this._configState = next;

        if (next.accent !== prev.accent) {
            setAccent(this._config.accentRgb);
            this._applyAccentStyles();
            // Tab content bakes the accent into inline styles.
            this._invalidateAllTabs();
        }

        // Blur/glass changed in prefs: re-apply the preset + current-state
        // radius. _applyBlur reads the new config and enables/disables the
        // effect as needed.
        if (next.blurKey !== prev.blurKey)
            this._applyBlur();

        // Feature toggles: run the same live-apply logic the in-notch panel used.
        for (let f of FEATURE_DEFS) {
            if (next.features[f.id] !== prev.features[f.id])
                this._onFeatureToggled(f.id, next.features[f.id]);
        }

        // Wallpaper settings changed in prefs: push them into the rotator (this
        // restarts its timer). If the Wallpaper tab is showing, repaint it so
        // the new folder/order is reflected.
        if (next.wallpaperKey !== prev.wallpaperKey) {
            this._wallpaper.configure(this._config.wallpaper);
            if (this._activeTab === 'wallpaper' && this.isExpanded)
                this._renderActiveTab();
        }

        // Tab order / enabled set changed: rebuild the carousel. This also
        // re-reads visibleTabs, so it must run after reload().
        if (next.tabsKey !== prev.tabsKey) {
            this._tabOrder = this._config.visibleTabs;
            this._rebuildDashboard();
            this._syncClipboardWatch();
        } else if (next.pinnedKey !== prev.pinnedKey) {
            this._syncRail();
        }
        if (next.keepAwake !== prev.keepAwake)
            this._setKeepAwake(next.keepAwake, { persist: false });

        // Which indicators the Tray tab mirrors changed in prefs: repaint the
        // Tray tab so the row reflects the new selection. Only meaningful while
        // it's the visible tab; otherwise the next render picks it up. Guarded on
        // the user's enable map (trayMirrorKey), not the published catalog, so
        // our own catalog writes don't re-enter here.
        if (next.trayMirrorKey !== prev.trayMirrorKey && this._invalidateTab('system'))
            this._renderActiveTab();
    }

    // Runs from the actor's 'destroy' signal, so it also fires when the shell
    // tears the stage down from C at logout/shutdown (which never calls a JS
    // destroy() override). Everything async below checks _destroyed.
    _onDestroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        // Destroyed by the shell itself (logout/shutdown) rather than by
        // disable(): MessageTray, the panel and popup menus are already
        // disposed then, and touching them only spams "already disposed".
        // The process is exiting, so stop our own sources and skip those.
        let shellGone = !this._disabling;
        this._releaseKeyboard();
        if (!shellGone)
            this._closeScanOverlay();
        this._destroyLedge();
        this._destroyProductivity();
        stopSpring(this);
        this._railTimeline?.stop();
        this._stopClock();
        this._stopWeatherRefresh();
        this._stopSystemRefresh();
        this._stopMediaAnimations();
        this._stopPillMarquee();
        if (this._pillEq) this._pillEq.stop();
        this._destroyCalendarServer();
        this._teardownStudio();
        if (this._media) { this._media.destroy(); this._media = null; }
        // Stop the wallpaper rotator and its pause monitor before tearing down
        // SystemHelper, since the monitor is connected to its UPower device.
        this._stopWallpaperPauseMonitor();
        this._unhookBatteryDevice();
        if (this._wallpaper) { this._wallpaper.destroy(); this._wallpaper = null; }
        this._system.destroy();
        this._mpris.destroy();
        this._fileDrop?.destroy();
        this._fileDrop = null;
        this._shelf.destroy();
        this._weather.destroy();
        this._artCancellable.cancel();
        if (this._artPruneId) {
            GLib.Source.remove(this._artPruneId);
            this._artPruneId = 0;
        }
        if (this._artSession) {
            this._artSession.abort();
            this._artSession = null;
        }
        this._artPending.clear();
        this._artCache.clear();

        if (!shellGone) {
            this._teardownNotificationWatch();
            this._destroyMoreMenu();
            this._restorePanel();
        }
        this._configCancellable?.cancel();
        this._configCancellable = null;
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
        if (this._keyFocusId) {
            global.stage.disconnect(this._keyFocusId);
            this._keyFocusId = 0;
        }
        this._clearTimers();
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
        }
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = 0;
        }
        this._monitorsChangedId = 0;
    }

    // Pending hover expand/collapse. Cleared on an explicit collapse so a
    // stale timer can't reopen or re-close the notch.
    _clearHoverTimers() {
        if (this._collapseTimeoutId) {
            GLib.Source.remove(this._collapseTimeoutId);
            this._collapseTimeoutId = null;
        }
        if (this._expandTimeoutId) {
            GLib.Source.remove(this._expandTimeoutId);
            this._expandTimeoutId = null;
        }
    }

    // Every timer we own — teardown only.
    _clearTimers() {
        this._clearHoverTimers();
        if (this._afterCollapseId) {
            GLib.Source.remove(this._afterCollapseId);
            this._afterCollapseId = 0;
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
        if (this._weatherKickId) {
            GLib.Source.remove(this._weatherKickId);
            this._weatherKickId = 0;
        }
        if (this._prewarmId) {
            GLib.Source.remove(this._prewarmId);
            this._prewarmId = 0;
        }
        if (this._trayToggleRefreshId) {
            GLib.Source.remove(this._trayToggleRefreshId);
            this._trayToggleRefreshId = 0;
        }
        if (this._trayReRenderId) {
            GLib.Source.remove(this._trayReRenderId);
            this._trayReRenderId = 0;
        }
        if (this._wpApplyId) {
            GLib.Source.remove(this._wpApplyId);
            this._wpApplyId = 0;
        }
        if (this._trayCardsId) {
            GLib.Source.remove(this._trayCardsId);
            this._trayCardsId = 0;
        }
        if (this._clipResetId) {
            GLib.Source.remove(this._clipResetId);
            this._clipResetId = 0;
        }
        if (this._railLaterId) {
            if (this._railLaterUsesLaters)
                global.compositor?.get_laters?.()?.remove(this._railLaterId);
            else
                GLib.Source.remove(this._railLaterId);
            this._railLaterId = 0;
        }
        if (this._mediaUpdateId) {
            GLib.Source.remove(this._mediaUpdateId);
            this._mediaUpdateId = 0;
        }
    }

    // Lift the notch to the top of its parent so no window (maximized or
    // fullscreen) is composited over it. Cheap: a single actor sibling move.
    // Guarded so a mid-teardown call (parent gone) can't throw.
    _raiseToTop() {
        let parent = this.get_parent();
        if (!parent) return;
        try { parent.set_child_above_sibling(this, null); } catch (e) {}
    }

    reposition() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        if (!this.isExpanded && this.get_stage()) {
            let g = this._restGeometry();
            this.set_position(g.x, g.y);
        } else {
            let width = this.isExpanded ? DASHBOARD_WIDTH : this._pillWidth();
            this.set_position(monitor.x + Math.floor((monitor.width - width) / 2), monitor.y);
        }
        // Keep the top-edge scroll strip aligned to the (possibly new) primary
        // monitor geometry.
        this._positionTopScroll();
    }

    // Measure how tall the currently-rendered dashboard wants to be at the
    // fixed dashboard width, so each tab animates to its own natural height.
    _measureDashboardHeight() {
        // A tab that is still sliding out overlaps the incoming one in the
        // content stack; it must not count toward the target height.
        let leaving = [...(this._leavingHosts ?? [])].filter(h => h.visible);
        for (let h of leaving) h.visible = false;
        // Measure at exactly the dashboard width. (The rail can want to be
        // wider than the card, so don't let its preferred width inflate the
        // measuring width — that would under-report the content height.)
        let [, natHeight] = this._dashboard.get_preferred_height(DASHBOARD_WIDTH);
        for (let h of leaving) h.visible = true;
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
        if (this._destroyed) return;
        if (!this.isExpanded) return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let targetHeight = this._measureDashboardHeight();
        let targetX = monitor.x + Math.floor((monitor.width - DASHBOARD_WIDTH) / 2);
        // Barely-underdamped: content-size changes settle with a hint of give.
        springTo(this, { x: targetX, y: monitor.y, width: DASHBOARD_WIDTH, height: targetHeight },
            { duration: 440, damping: 0.86 });
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
            logError('notification activate failed', e);
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
                    logError('notification action failed', e);
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
        // Not a configurable tab: the grid behind the header's grid button.
        this._tabs.launcher = { label: 'All', icon: 'view-app-grid-symbolic' };
        // Ordered list of *visible* tab ids (config order, enabled only).
        this._tabOrder = this._config.visibleTabs;
        if (this._tabOrder.length === 0)
            this._tabOrder = ['home'];

        let headerWrap = new St.BoxLayout({
            style_class: 'notchnux-dashboard-header-wrap',
            vertical: false,
            x_expand: true });

        // Tab rail: icon buttons over one travelling accent indicator. Only the
        // active tab reveals its label (its clip's width animates open), so all
        // twelve tabs fit the dashboard width — no carousel hiding half of them.
        let rail = new St.BoxLayout({
            style_class: 'notchnux-tab-rail',
            reactive: true,
            clip_to_allocation: true,
            x_expand: true });
        // Inner layer with absolute positioning: the strip sits at (0,0) and
        // the indicator is placed exactly under the active button.
        let railLayer = new St.Widget({ layout_manager: new Clutter.FixedLayout() });
        this._tabIndicator = new St.Widget({ style_class: 'notchnux-tab-indicator', opacity: 0 });
        this._tabStrip = new St.BoxLayout({ style_class: 'notchnux-tab-strip' });
        railLayer.add_child(this._tabIndicator);
        railLayer.add_child(this._tabStrip);
        rail.add_child(railLayer);
        // Wheel/trackpad over the rail steps through tabs.
        rail.connect('scroll-event', (actor, event) => {
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
        // The indicator and label widths need real allocations; place them
        // (without animation) once the strip has been laid out.
        this._railPlaced = false;
        this._tabStrip.connect('notify::allocation', () => {
            if (!this._railPlaced)
                this._queueRailPlacement();
        });

        this._fillRail();


        // One "more" button holds settings and the session actions (the old
        // separate power + gear buttons cost the rail ~80 px).
        this._moreButton = new St.Button({
            style_class: 'notchnux-more-btn', reactive: true, can_focus: true,
            accessible_name: 'More', y_align: Clutter.ActorAlign.CENTER });
        this._moreButton.set_child(new St.Icon({ icon_name: 'view-more-symbolic', icon_size: 16 }));
        addPressFeedback(this._moreButton);
        this._buildMoreMenu();
        this._moreButton.connect('clicked', () => this._moreMenu.toggle());

        // Content: one host per visited tab, stacked in a BinLayout with only
        // the active one visible. Kept hosts make switching back instant and
        // let the outgoing and incoming tab cross-slide.
        this._contentContainer = new St.Widget({
            style_class: 'notchnux-content-container',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true });
        this._tabHosts = new Map();
        this._leavingHosts = new Set();

        // Grid: every tab and toggle, and where header shortcuts are picked.
        this._gridButton = new St.Button({
            style_class: 'notchnux-more-btn nn-grid-btn', reactive: true, can_focus: true,
            accessible_name: 'All', y_align: Clutter.ActorAlign.CENTER });
        this._gridButton.set_child(new St.Icon({ icon_name: 'view-app-grid-symbolic', icon_size: 16 }));
        addPressFeedback(this._gridButton);
        this._gridButton.connect('clicked', () => this._toggleLauncher());
        this._attachTrayTooltip(this._gridButton, 'All', () => this._activeTab !== 'launcher');

        headerWrap.add_child(rail);
        headerWrap.add_child(this._gridButton);
        headerWrap.add_child(this._moreButton);
        this._dashboard.add_child(headerWrap);
        this._dashboard.add_child(this._contentContainer);

        // Keep the current tab across rebuilds; otherwise start on the first.
        if (!this._tabOrder.includes(this._activeTab) && this._activeTab !== 'launcher')
            this._activeTab = this._tabOrder[0];
        this._tabButtons[this._activeTab]?.add_style_class_name('notchnux-tab-btn-active');
        this._tintTabButton(this._activeTab, true);
        this._syncRail();
    }

    // The header shows Home, up to pinnedMax shortcuts, and — while one is
    // open — the tab you reached through the grid. Everything else lives in
    // the grid (the launcher), one click away.
    _railIds() {
        let visible = this._tabOrder;
        let ids = visible.includes('home') ? ['home'] : [];
        for (let id of this._config.pinnedTabs) {
            if (visible.includes(id) && !ids.includes(id))
                ids.push(id);
        }
        let active = this._activeTab;
        if (active && active !== 'launcher' && this._tabs[active] && !ids.includes(active))
            ids.push(active);
        return ids;
    }

    _fillRail() {
        // The Alerts badge lives on its rail button; forget it before the
        // buttons go away.
        this._tabCountBadge = null;
        this._tabCountLabel = null;
        this._tabStrip.destroy_all_children();
        this._tabButtons = {};
        this._tabLabels = {};
        for (let id of this._railIds()) {
            let tab = this._tabs[id];
            if (!tab) continue;
            let btn = new St.Button({
                style_class: 'notchnux-tab-btn', reactive: true, can_focus: true,
                accessible_name: tab.label });
            let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
            row.add_child(new St.Icon({
                icon_name: tab.icon, style_class: 'notchnux-tab-icon', icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER }));
            let clip = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true, width: 0,
                y_align: Clutter.ActorAlign.CENTER });
            let label = new St.Label({
                text: tab.label, style_class: 'notchnux-tab-label',
                x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            clip.add_child(label);
            row.add_child(clip);
            // Alerts carries a live count badge so pending notifications show
            // without opening the tab.
            if (id === 'notifications') {
                this._tabCountBadge = new St.Bin({ style_class: 'notchnux-tab-count', y_align: Clutter.ActorAlign.CENTER });
                this._tabCountLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
                this._tabCountBadge.set_child(this._tabCountLabel);
                this._tabCountBadge.visible = false;
                row.add_child(this._tabCountBadge);
            }
            btn.set_child(row);
            btn.connect('clicked', () => this._switchTab(id));
            addPressFeedback(btn, 0.92);
            this._attachTrayTooltip(btn, tab.label, () => id !== this._activeTab);
            this._tabStrip.add_child(btn);
            this._tabButtons[id] = btn;
            this._tabLabels[id] = { clip, label };
        }
        this._railKey = this._railIds().join(',');
        this._updateTabCountBadge();
    }

    // Re-fill the rail if its set of buttons changed (pins edited, or a tab
    // opened from the grid), then put the indicator under the active one.
    _syncRail() {
        if (!this._tabStrip)
            return;
        if (this._railIds().join(',') !== this._railKey) {
            this._railTimeline?.stop();
            this._fillRail();
            this._railPlaced = false;
            this._queueRailPlacement();
        }
        this._gridButton?.set_style(this._activeTab === 'launcher'
            ? `color: ${accentHex()}; background-color: rgba(${accentRgbStr()}, 0.16);` : null);
    }

    // The "more" menu: NotchNux settings, then GNOME's own session actions
    // (SystemActions owns the confirm dialogs and availability checks).
    _buildMoreMenu() {
        this._destroyMoreMenu();
        if (!this._systemActions)
            this._systemActions = SystemActions.getDefault();  // module fn, not a class

        this._moreMenuManager = new PopupMenu.PopupMenuManager(this._moreButton);
        this._moreMenu = new PopupMenu.PopupMenu(this._moreButton, 0.5, St.Side.TOP);
        this._moreMenu.actor.add_style_class_name('notchnux-power-menu');
        Main.uiGroup.add_child(this._moreMenu.actor);
        this._moreMenu.close();
        this._moreMenuManager.addMenu(this._moreMenu);

        let settings = new PopupMenu.PopupImageMenuItem('NotchNux Settings…', 'preferences-system-symbolic');
        settings.connect('activate', () => {
            this.collapse();
            try {
                this.extension.openPreferences();
            } catch (e) {
                logError('Failed to open preferences.', e);
            }
        });
        this._moreMenu.addMenuItem(settings);

        if (!this._config.isFeatureEnabled('showPowerButton'))
            return;
        this._moreMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const addAction = (label, iconName, actionName) => {
            let item = new PopupMenu.PopupImageMenuItem(label, iconName);
            item.connect('activate', () => {
                // Collapse first so the confirm dialog isn't behind the notch.
                this.collapse();
                try {
                    this._systemActions.activateAction(actionName);
                } catch (e) {
                    logError(`system action '${actionName}' failed.`, e);
                }
            });
            this._moreMenu.addMenuItem(item);
        };
        addAction('Lock', 'system-lock-screen-symbolic', 'lock-screen');
        addAction('Suspend', 'media-playback-pause-symbolic', 'suspend');
        addAction('Log Out…', 'system-log-out-symbolic', 'logout');
        addAction('Restart…', 'view-refresh-symbolic', 'restart');
        addAction('Power Off…', 'system-shutdown-symbolic', 'power-off');
    }

    _destroyMoreMenu() {
        if (this._moreMenu) {
            this._moreMenu.destroy();
            this._moreMenu = null;
        }
        this._moreMenuManager = null;
    }

    // Apply the current hidePanel / reclaimSpace config to the GNOME top panel.
    //
    // Two independent effects:
    //   - hidePanel     : hide the panelBox so the bar isn't drawn.
    //   - reclaimSpace  : also stop the panelBox from reserving work-area space,
    //                     so maximized windows extend up into the top strip.
    //
    // reclaimSpace only makes sense while the panel is hidden; a visible panel
    // that doesn't reserve space would overlap windows. Everything here is
    // reversible — _restorePanel() undoes it exactly.
    _applyPanelVisibility() {
        let hide = this._config.isFeatureEnabled('hidePanel');
        let reclaim = hide && this._config.isFeatureEnabled('reclaimSpace');

        let lm = Main.layoutManager;
        let panelBox = lm?.panelBox;
        if (!panelBox) return;

        // Visibility: hide/show the whole panel box.
        panelBox.visible = !hide;

        // GNOME re-shows panelBox during its own region/visibility recomputes
        // (opening or maximizing a window, workspace switches, leaving the
        // overview). Our single assignment above would be undone, so while the
        // panel is meant to be hidden we watch notify::visible and immediately
        // re-hide it. The guard is torn down when hide turns off or on teardown.
        if (hide) {
            if (!this._panelVisibleWatchId) {
                this._panelVisibleWatchId = panelBox.connect('notify::visible', () => {
                    // Re-assert only while still configured to hide; setting
                    // .visible here re-enters this handler, so bail if already false.
                    if (this._config.isFeatureEnabled('hidePanel') && panelBox.visible)
                        panelBox.visible = false;
                });
            }
        } else if (this._panelVisibleWatchId) {
            panelBox.disconnect(this._panelVisibleWatchId);
            this._panelVisibleWatchId = 0;
        }

        // Struts: flip the panelBox's affectsStruts flag in the layout manager's
        // tracked-actor list, then recompute regions so the work area updates.
        // We remember the original value the first time we touch it so we can
        // restore it verbatim on teardown / toggle-off.
        try {
            let tracked = lm._findActor
                ? lm._trackedActors?.[lm._findActor(panelBox)]
                : (lm._trackedActors ?? []).find(a => a.actor === panelBox);
            if (tracked) {
                if (this._panelStrutsOriginal === undefined)
                    this._panelStrutsOriginal = tracked.affectsStruts;
                tracked.affectsStruts = reclaim ? false : this._panelStrutsOriginal;
                if (typeof lm._queueUpdateRegions === 'function')
                    lm._queueUpdateRegions();
            }
        } catch (e) {
            logError('Failed to adjust panel struts.', e);
        }

        // Unredirection: with reclaimSpace on, the panel no longer reserves the
        // top strip, so a *maximized* window (not just true fullscreen) grows to
        // cover y=0 — the exact rows the notch occupies. When a window covers a
        // whole monitor Mutter "unredirects" it (scans it out directly, bypassing
        // the compositor), and nothing drawn above it in the scene graph — our
        // top-chrome notch included — is composited. The notch then vanishes and
        // only flickers back on repaints (scrolling, a screenshot forcing
        // redirection). Inhibiting unredirection keeps every frame composited so
        // the notch stays drawn over the covering window.
        //
        // We only inhibit when a window is *actually* covering the top strip
        // (evaluated in _updateUnredirect), so direct scanout for fullscreen
        // video keeps working the rest of the time. The watch is wired up only
        // while reclaim is on — the only combo that lets a window reach y=0.
        if (reclaim) {
            this._startUnredirectWatch();
            this._updateUnredirect();
        } else {
            this._stopUnredirectWatch();
            this._uninhibitUnredirect();
        }

        // The top-edge scroll strip only exists while the panel is hidden, so
        // its lifecycle is tied to this same recompute.
        this._applyTopScroll();
    }

    // Start watching for window geometry/stacking changes so we can flip the
    // unredirect inhibit on/off as a window covers or uncovers the top strip.
    // Idempotent. `restacked` (already tracked in _init for the raise-to-top)
    // covers maximize/minimize/raise/map/workspace-switch; window_manager's
    // `size-change` covers maximize/unmaximize/tile/fullscreen transitions.
    _startUnredirectWatch() {
        if (this._unredirectWatchStarted)
            return;
        this._unredirectWatchStarted = true;
        try {
            let wm = global.window_manager;
            if (wm)
                this._wmSizeChangeId = wm.connect('size-change',
                    () => this._queueUnredirectUpdate());
        } catch (e) {
            logError('Failed to start unredirect watch.', e);
        }
    }

    _stopUnredirectWatch() {
        if (!this._unredirectWatchStarted)
            return;
        this._unredirectWatchStarted = false;
        if (this._wmSizeChangeId) {
            try { global.window_manager.disconnect(this._wmSizeChangeId); } catch (e) {}
            this._wmSizeChangeId = 0;
        }
        if (this._unredirectUpdateId) {
            GLib.Source.remove(this._unredirectUpdateId);
            this._unredirectUpdateId = 0;
        }
    }

    // Coalesce a burst of window signals into a single re-evaluation on the next
    // idle, so a maximize (which fires several signals) checks the geometry once.
    _queueUnredirectUpdate() {
        if (!this._unredirectWatchStarted)
            return;
        if (this._unredirectUpdateId)
            return;
        this._unredirectUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._unredirectUpdateId = 0;
            this._updateUnredirect();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Inhibit unredirection iff some ordinary window currently overlaps the
    // notch's top strip on the primary monitor + active workspace. Cheap enough
    // to run on every relevant window change.
    _updateUnredirect() {
        // Only meaningful while we're reclaiming the strip; a defensive re-check
        // in case this is reached after the feature was toggled off.
        let reclaim = this._config.isFeatureEnabled('hidePanel') &&
                      this._config.isFeatureEnabled('reclaimSpace');
        if (!reclaim) {
            this._uninhibitUnredirect();
            return;
        }
        if (this._windowCoversTopStrip())
            this._inhibitUnredirect();
        else
            this._uninhibitUnredirect();
    }

    // True if any normal, shown window on the primary monitor's active workspace
    // has a frame rect that reaches into the top strip the notch occupies. We
    // test overlap against the collapsed pill's band at the top of the monitor
    // (a window merely touching y=0 is enough to cover the notch), which is what
    // triggers Mutter's unredirect in the first place.
    _windowCoversTopStrip() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        // The band the notch draws in: the top PILL_HEIGHT rows of the monitor.
        let stripTop = monitor.y;
        let stripBottom = monitor.y + PILL_HEIGHT;
        let primaryIndex = Main.layoutManager.primaryIndex;

        let wsm = global.workspace_manager;
        let activeWs = wsm ? wsm.get_active_workspace() : null;

        let actors = global.get_window_actors();
        for (let actor of actors) {
            let win = actor.meta_window ?? actor.get_meta_window?.();
            if (!win)
                continue;
            // Skip anything that isn't a real, currently-visible top-level.
            if (win.is_override_redirect && win.is_override_redirect())
                continue;
            if (win.minimized)
                continue;
            if (win.showing_on_its_workspace && !win.showing_on_its_workspace())
                continue;
            // Only windows on the primary monitor can cover the notch.
            if (typeof win.get_monitor === 'function' && win.get_monitor() !== primaryIndex)
                continue;
            // Restrict to the active workspace (unless the window is on all).
            if (activeWs && win.located_on_workspace &&
                !win.located_on_workspace(activeWs) &&
                !(win.is_on_all_workspaces && win.is_on_all_workspaces()))
                continue;
            // Ignore desktop/dock-type surfaces — they legitimately sit under us.
            let t = win.get_window_type ? win.get_window_type() : null;
            if (t === Meta.WindowType.DESKTOP || t === Meta.WindowType.DOCK)
                continue;

            let r = win.get_frame_rect ? win.get_frame_rect() : null;
            if (!r)
                continue;
            // Vertical overlap with the notch band + horizontal overlap with the
            // monitor is enough — the window is drawing where the notch is.
            let rTop = r.y;
            let rBottom = r.y + r.height;
            if (rTop < stripBottom && rBottom > stripTop)
                return true;
        }
        return false;
    }

    // Disable Mutter's direct-scanout optimization so top chrome stays composited
    // over a monitor-covering window. disable/enable_unredirect are ref-counted,
    // so a bool flag keeps this one-shot (never disable twice, never leave a
    // dangling disable). No-op if already inhibited.
    _inhibitUnredirect() {
        if (this._unredirectInhibited)
            return;
        try {
            let compositor = global.compositor ?? global.get_compositor?.();
            if (compositor && typeof compositor.disable_unredirect === 'function') {
                compositor.disable_unredirect();
                this._unredirectInhibited = true;
            }
        } catch (e) {
            logError('Failed to inhibit unredirect.', e);
        }
    }

    // Release the inhibition set by _inhibitUnredirect (restoring direct scanout
    // for fullscreen video etc.). No-op if we weren't inhibiting.
    _uninhibitUnredirect() {
        if (!this._unredirectInhibited)
            return;
        try {
            let compositor = global.compositor ?? global.get_compositor?.();
            if (compositor && typeof compositor.enable_unredirect === 'function')
                compositor.enable_unredirect();
        } catch (e) {
            logError('Failed to release unredirect inhibit.', e);
        } finally {
            // Clear the flag even if the call threw, so we don't get wedged
            // permanently inhibited.
            this._unredirectInhibited = false;
        }
    }

    // Undo everything _applyPanelVisibility changed: show the panel again and
    // restore its original strut behaviour. Safe to call when nothing was hidden.
    _restorePanel() {
        // The scroll strip only makes sense with the panel hidden, so drop it
        // whenever we restore the panel (also covers teardown).
        this._destroyTopScroll();
        // Stop watching windows and restore direct scanout — we're no longer
        // reclaiming the top strip.
        this._stopUnredirectWatch();
        this._uninhibitUnredirect();
        let lm = Main.layoutManager;
        let panelBox = lm?.panelBox;
        if (!panelBox) return;
        // Stop re-asserting hidden-ness before showing the panel again.
        if (this._panelVisibleWatchId) {
            panelBox.disconnect(this._panelVisibleWatchId);
            this._panelVisibleWatchId = 0;
        }
        panelBox.visible = true;
        try {
            if (this._panelStrutsOriginal !== undefined) {
                let tracked = lm._findActor
                    ? lm._trackedActors?.[lm._findActor(panelBox)]
                    : (lm._trackedActors ?? []).find(a => a.actor === panelBox);
                if (tracked)
                    tracked.affectsStruts = this._panelStrutsOriginal;
                this._panelStrutsOriginal = undefined;
                if (typeof lm._queueUpdateRegions === 'function')
                    lm._queueUpdateRegions();
            }
        } catch (e) {
            logError('Failed to restore panel struts.', e);
        }
    }

    // --- Top-edge workspace scroll ------------------------------------------
    //
    // Several third-party extensions let you scroll over the GNOME top bar to
    // switch workspaces. Hiding the panel (hidePanel) removes the bar's actor,
    // so that scroll region disappears with it. To keep the gesture working we
    // mount a thin, transparent, full-width strip pinned to the very top edge of
    // the primary monitor that captures scroll events and switches workspaces
    // itself. It only reacts to scroll — clicks pass through — and never
    // reserves work-area space, so it's invisible in every way except that
    // scrolling along the top edge still moves between workspaces.
    //
    // Enabled only when BOTH hidePanel and topScroll are on: with the panel
    // visible the real bar (or the user's extension) already owns that region.
    _applyTopScroll() {
        let want = this._config.isFeatureEnabled('hidePanel')
                && this._config.isFeatureEnabled('topScroll');
        if (want) this._ensureTopScroll();
        else this._destroyTopScroll();
    }

    _ensureTopScroll() {
        if (this._topScroll) {
            this._positionTopScroll();
            return;
        }
        // ~6px is enough to catch a scroll aimed at the screen's top edge while
        // staying out of the way. Reactive for scroll only; clicks are let
        // through so it doesn't swallow interaction with whatever is beneath.
        let strip = new St.Widget({
            reactive: true,
            can_focus: false,
            track_hover: false,
            style_class: 'nook-topscroll',
        });
        strip.connect('scroll-event', (actor, event) =>
            this._onTopScroll(event));
        // addChrome (not addTopChrome) so it isn't hidden with fullscreen top
        // chrome; affectsStruts/affectsInputRegion default such that it takes
        // input but reserves no space.
        Main.layoutManager.addChrome(strip, { affectsStruts: false });
        this._topScroll = strip;
        this._positionTopScroll();
    }

    _positionTopScroll() {
        if (!this._topScroll) return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const STRIP_H = 6;
        this._topScroll.set_position(monitor.x, monitor.y);
        this._topScroll.set_size(monitor.width, STRIP_H);
    }

    _destroyTopScroll() {
        if (!this._topScroll) return;
        try { Main.layoutManager.removeChrome(this._topScroll); } catch (e) {}
        this._topScroll.destroy();
        this._topScroll = null;
    }

    // Switch workspace in response to a scroll over the top-edge strip. Scroll
    // up → previous workspace, down → next; horizontal/smooth deltas are mapped
    // the same way. Debounced lightly so a single flick doesn't skip several.
    _onTopScroll(event) {
        let dir = event.get_scroll_direction();
        let step = 0;
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            step = -1;
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            step = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH && event.get_scroll_delta) {
            let [, dy] = event.get_scroll_delta();
            if (dy > 0.01) step = 1;
            else if (dy < -0.01) step = -1;
        }
        if (!step) return Clutter.EVENT_PROPAGATE;

        // Coalesce a burst of smooth-scroll events so one physical flick moves a
        // single workspace rather than racing through several.
        let now = GLib.get_monotonic_time();
        if (this._topScrollLast && now - this._topScrollLast < 180000)
            return Clutter.EVENT_STOP;
        this._topScrollLast = now;

        let wm = global.workspace_manager;
        let active = wm.get_active_workspace_index();
        let target = active + step;
        if (target < 0 || target >= wm.get_n_workspaces())
            return Clutter.EVENT_STOP;
        // Plain activate() switches the workspace without dragging the currently
        // focused window along — the same call the overview and scroll-to-switch
        // extensions use.
        wm.get_workspace_by_index(target).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }

    // Tear down and rebuild the entire dashboard from current config. Called
    // after the user changes tab order / enabled tabs in settings so the
    // carousel reflects the change without needing a shell restart.
    _rebuildDashboard() {
        let wasExpanded = this.isExpanded;
        // Tear down everything the old tab hosts own before they're destroyed
        // (_buildDashboard keeps the current tab if it's still visible).
        for (let tab of this._tabHosts?.keys() ?? [])
            this._teardownTabContent(tab);
        this._railTimeline?.stop();
        this._surface.remove_child(this._dashboard);
        this._dashboard.destroy();
        this._buildDashboard();
        this._surface.add_child(this._dashboard);
        this._dashboard.visible = wasExpanded;
        this._applyAccentStyles();
        if (wasExpanded) {
            this._showActiveTab();
            this._resizeToContent();
        }
    }

    // The stylesheet paints selected/active chrome in a fixed blue. To honour
    // the user's accent we override just that spot with an inline style built
    // from the current ACCENT. Inline style wins over the style class, so this
    // recolours the active tab pill without touching the CSS. Called on
    // startup, after a rebuild, and whenever accent changes.
    // The active tab's icon and label take the accent (inline, since the
    // accent is user-chosen); the others fall back to the stylesheet.
    _tintTabButton(id, active) {
        this._tabButtons?.[id]?.set_style(active ? `color: ${accentHex()};` : null);
    }

    _applyAccentStyles() {
        let rgb = accentRgbStr();
        // The travelling indicator under the active tab carries the accent.
        this._tabIndicator?.set_style(`background-color: rgba(${rgb}, 0.16);`);
        this._tintTabButton(this._activeTab, true);
        // The collapsed pill's EQ bars are built once, so recolour them live.
        if (this._pillEq)
            this._pillEq.setAccentColor();
        // Keep the Alerts tab count pill in sync with the new accent.
        this._updateTabCountBadge();
    }

    // ============================================================
    // Island silhouette + glass appearance
    // ============================================================
    //
    // Solid by default: a near-black island flush with the top edge, flared
    // into it by two concave shoulders, with no rim and no drop shadow (a
    // shadow on a box that springs every frame is what used to smear). Glass
    // swaps the solid fill for a tinted, translucent one over a GlassBackdrop
    // (see helpers/island.js for why that is not a BACKGROUND blur any more).
    _buildBlur() {
        this._shoulders = [createShoulder(-1), createShoulder(1)];
        for (let sh of this._shoulders)
            this.add_child(sh);
        this._glass = new GlassBackdrop();
        this.insert_child_below(this._glass.actor, this._surface);
        this._blurActive = false;

        let sync = () => this._syncIslandShape();
        for (let prop of ['x', 'y', 'width', 'height'])
            this.connect(`notify::${prop}`, sync);
        // Corner radius comes from the island's CSS class (pill/peek/open).
        this._surface.connect('style-changed', () => {
            this._islandRadiusCache = null;
            sync();
        });
        // The hover swell scales the surface; keep the shoulders and the glass
        // glued to its edges.
        this._surface.connect('notify::scale-x', sync);
        this._surface.connect('notify::scale-y', sync);
    }

    _islandRadius() {
        if (this._islandRadiusCache != null)
            return this._islandRadiusCache;
        try {
            this._islandRadiusCache = this._surface.get_theme_node().get_border_radius(St.Corner.BOTTOMLEFT);
        } catch (e) {
            return 20;
        }
        return this._islandRadiusCache;
    }

    // motion.js hooks: hold the glass buffers at one size covering the whole
    // spring (with room for the overshoot) instead of resizing every frame.
    _onSpringStart(from, target) {
        if (!this._blurActive || !this._glass)
            return;
        let w = Math.max(from.width ?? this.width, target.width ?? this.width);
        let h = Math.max(from.height ?? this.height, target.height ?? this.height);
        this._glass.setEnvelope(w * 1.05, h * 1.05);
        this._syncIslandShape();
    }

    _onSpringSettled() {
        if (!this._glass)
            return;
        this._glass.setEnvelope(0, 0);
        this._syncIslandShape();
    }

    _syncIslandShape() {
        // Off-stage (during construction) St has no theme node to read.
        if (this._destroyed || !this._glass || !this.get_stage())
            return;
        let sx = this._surface.scale_x;
        let grow = (sx - 1) * this.width / 2;
        this._shoulders[0].translation_x = -SHOULDER_SIZE - grow;
        this._shoulders[1].translation_x = SHOULDER_SIZE + grow;
        if (!this._blurActive)
            return;
        this._glass.sync(this.x, this.y, this.width, this.height, this._islandRadius(),
            sx, this._surface.scale_y);
    }

    // Re-read the persisted glass config and apply it. Safe to call any time.
    _applyBlur() {
        if (!this._glass)
            return;
        let cfg = this._config.blur;
        this._blurCfg = cfg;
        this._blurActive = cfg.enabled;

        if (!cfg.enabled) {
            this._glass.actor.visible = false;
            this._glass.setBlur(0);
            this._surface.set_style(null);
            for (let sh of this._shoulders)
                sh.visible = true;
            this._syncIslandShape();
            return;
        }

        let p = blurPreset(cfg.preset);
        this._glass.setBlur(this.isExpanded ? cfg.expandedRadius : cfg.collapsedRadius, p.brightness);
        this._surface.set_style(
            `background-color: rgba(${p.tint}, ${p.alpha});`);
        // The shoulders are solid; on glass they would read as two dark tabs.
        for (let sh of this._shoulders)
            sh.visible = false;
        this._glass.actor.visible = true;
        this._syncIslandShape();
    }

    // Glass strength follows the open/closed state. Applied in one step: the
    // blur re-allocates its buffers on every radius change.
    _animateBlurRadius(target) {
        if (this._blurActive)
            this._glass.setBlur(target);
    }

    _switchTab(tabId) {
        if (!this._tabs[tabId] || tabId === this._activeTab)
            return;
        let prev = this._activeTab;
        let order = [...this._tabOrder, 'launcher'];
        let dir = Math.sign(order.indexOf(tabId) - order.indexOf(prev)) || 1;
        this._leaveTab(prev);
        this._tabButtons[prev]?.remove_style_class_name('notchnux-tab-btn-active');
        this._tintTabButton(prev, false);
        if (prev !== 'launcher')
            this._lastTab = prev;
        this._activeTab = tabId;
        this._syncRail();
        this._tabButtons[tabId]?.add_style_class_name('notchnux-tab-btn-active');
        this._tintTabButton(tabId, true);
        this._updateTabCountBadge();
        this._animateRail(tabId);
        if (this.isExpanded)
            this._showActiveTab({ animate: true, dir });
    }

    // Wheel over the header steps through the header's own buttons.
    _switchTabRelative(delta) {
        let ids = this._railIds();
        if (ids.length === 0)
            return;
        let idx = ids.indexOf(this._activeTab);
        if (idx < 0)
            idx = delta > 0 ? -1 : 0;
        let next = (idx + delta + ids.length) % ids.length;
        this._switchTab(ids[next]);
    }

    // Natural width of a tab's label (incl. its CSS margin), once staged.
    _tabLabelWidth(id) {
        let l = this._tabLabels[id]?.label;
        return l && l.get_stage() ? Math.ceil(l.get_preferred_width(-1)[1]) : 0;
    }

    // Place the indicator + label reveal instantly (first layout, rebuilds).
    // Runs from a "later" so it never resizes actors inside a layout pass.
    _queueRailPlacement() {
        if (this._railLaterId)
            return;
        let laters = global.compositor?.get_laters?.();
        let run = () => {
            this._railLaterId = 0;
            this._placeRail();
            return GLib.SOURCE_REMOVE;
        };
        this._railLaterId = laters
            ? laters.add(Meta.LaterType.BEFORE_REDRAW, run)
            : GLib.idle_add(GLib.PRIORITY_DEFAULT, run);
        this._railLaterUsesLaters = !!laters;
    }

    _placeRail() {
        if (this._destroyed || !this._tabStrip?.get_stage())
            return;
        this._railPlaced = true;
        if (!this._tabButtons[this._activeTab]) {
            // The grid is open: no header button is active.
            for (let { clip } of Object.values(this._tabLabels))
                clip.width = 0;
            this._tabIndicator.opacity = 0;
            return;
        }
        this._animateRail(this._activeTab, { instant: true });
        this._tabIndicator.ease({ opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    // Where every rail button sits for a given set of label widths: each
    // button's width is its icon/padding base plus its label clip, packed left
    // to right with the strip's spacing. Pure arithmetic on preferred sizes —
    // never reads allocations, which lag a frame behind width changes.
    _railGeometry(labelWidths) {
        let spacing = this._tabStrip.get_layout_manager()?.spacing ?? 0;
        let geo = {};
        let x = 0;
        for (let id of this._railIds()) {
            let btn = this._tabButtons[id];
            if (!btn) continue;
            let clip = this._tabLabels[id].clip;
            let base = btn.get_preferred_width(-1)[1] - clip.width;
            let w = base + labelWidths[id];
            geo[id] = { x, w, h: btn.get_preferred_height(-1)[1] };
            x += w + spacing;
        }
        return geo;
    }

    // Travel the indicator to `next` while its label opens and the previous
    // one closes — one timeline drives all of it, so the indicator lands
    // exactly as the buttons settle.
    _animateRail(next, { instant = false } = {}) {
        // No header button for `next` (the grid is open): fold every label
        // and fade the indicator away.
        let none = !this._tabButtons[next];
        if (this._railPlaced)
            this._tabIndicator.ease({ opacity: none ? 0 : 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        if (!this._railPlaced || !this._tabStrip.get_stage()) {
            this._railPlaced = false;
            this._queueRailPlacement();
            return;
        }
        this._railTimeline?.stop();
        let from = {}, to = {};
        for (let [id, { clip }] of Object.entries(this._tabLabels)) {
            from[id] = clip.width;
            to[id] = id === next ? this._tabLabelWidth(id) : 0;
        }
        let ind = this._tabIndicator;
        let ix0 = ind.x, iw0 = ind.width;
        let target = none ? { x: ix0, w: iw0 } : this._railGeometry(to)[next];
        ind.y = 0;
        if (!none)
            ind.height = target.h;
        let lerp = (a, b, p) => a + (b - a) * p;
        let apply = p => {
            for (let [id, { clip }] of Object.entries(this._tabLabels))
                clip.width = lerp(from[id], to[id], p);
            ind.x = lerp(ix0, target.x, p);
            ind.width = lerp(iw0, target.w, p);
        };
        let duration = Math.round(360 * (St.Settings.get().slow_down_factor || 1));
        if (instant || !St.Settings.get().enable_animations) {
            apply(1);
            return;
        }
        let tl = new Clutter.Timeline({ actor: this._tabStrip, duration });
        tl.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUINT);
        tl.connect('new-frame', () => apply(tl.get_progress()));
        tl.connect('completed', () => {
            apply(1);
            if (this._railTimeline === tl)
                this._railTimeline = null;
        });
        this._railTimeline = tl;
        tl.start();
    }

    // The host actor a tab renders into (created hidden on first use).
    _hostFor(tab) {
        let host = this._tabHosts.get(tab);
        if (!host) {
            host = new St.BoxLayout({
                style_class: 'notchnux-tab-host', vertical: true,
                x_expand: true, y_expand: true, visible: false });
            this._contentContainer.add_child(host);
            this._tabHosts.set(tab, host);
        }
        return host;
    }

    // Tab renderers add their panel through this, into the tab's own host.
    _mount(panel) {
        (this._mountTarget ?? this._hostFor(this._activeTab)).add_child(panel);
    }

    // Leaving `tab` (switch or collapse): stop whatever it was running. Its
    // actors stay alive (hidden) for a fast switch back.
    _leaveTab(tab) {
        if (tab === 'media') {
            this._pauseMediaAnimations();
            this._stopLyricsTick();
        }
        if (tab === 'studio') {
            // Camera off whenever Studio isn't on screen; re-render on return.
            this._teardownStudio();
            this._markTabDirty('studio');
        }
        if (tab === 'system') {
            this._closeScanOverlay();
            this._system.stopSysPolling();
        }
        if (tab === 'launcher')
            this._launcherEdit = false;
        this._releaseKeyboard?.();
    }

    // Stop timers/animations owned by `tab`'s content and forget its actor
    // references, right before that content is destroyed.
    _teardownTabContent(tab) {
        if (tab === 'media') this._stopMediaAnimations();
        if (tab === 'studio') this._teardownStudio();
        if (tab === 'system') this._closeScanOverlay();
        this._dropTabRefs(tab);
    }

    _markTabDirty(tab) {
        let host = this._tabHosts?.get(tab);
        if (host)
            host._dirty = true;
    }

    // (Re)build the active tab into its host.
    _renderActiveTab() {
        if (this._destroyed) return;
        let tab = this._activeTab;
        let host = this._hostFor(tab);
        this._teardownTabContent(tab);
        host.destroy_all_children();
        if (tab === 'system')
            this._system.startSysPolling();
        this._mountTarget = host;
        try {
            switch (tab) {
            case 'home': this._renderHomeTab(); break;
            case 'tasks': this._renderTasksTab(); break;
            case 'focus':
                if (this._focusMode === 'stopwatch') this._renderStopwatchPanel();
                else this._renderFocusTab();
                break;
            case 'launcher': this._renderLauncherTab(); break;
            case 'clipboard': this._renderClipboardTab(); break;
            case 'notes': this._renderNotesTab(); break;
            case 'media': this._renderMediaTab(); break;
            case 'system': this._renderSystemTab(); break;
            case 'weather': this._renderWeatherTab(); break;
            case 'studio': this._renderStudioTab(); break;
            case 'calendar': this._renderCalendarTab(); break;
            case 'notifications': this._renderNotificationsTab(); break;
            case 'shelf': this._renderShelfTab(); break;
            case 'wallpaper': this._renderWallpaperTab(); break;
            }
        } finally {
            this._mountTarget = null;
        }
        host._dirty = false;
        host._renderedDay = this._dayKey(new Date());
        // A file drag is falling through to the drop catcher: the fresh
        // actors must not eat the pointer either.
        if (this._dropPassThrough)
            this._walkDropPassThrough(true);
        // Re-fit to the new content height, unless expand() or a tab switch
        // is driving its own animation (they measure after showing the host).
        if (this.isExpanded && !this._isExpanding && !this._presenting)
            this._resizeToContent();
    }

    // Make the active tab's host the visible one — cross-sliding from the
    // previous tab when `animate` — rendering or refreshing it as needed.
    _showActiveTab({ animate = false, dir = 1 } = {}) {
        let tab = this._activeTab;
        let host = this._hostFor(tab);
        this._presenting = true;
        try {
            if (host.get_n_children() === 0 || host._dirty ||
                host._renderedDay !== this._dayKey(new Date()))
                this._renderActiveTab();
            else
                this._refreshTabInPlace(tab);
        } finally {
            this._presenting = false;
        }
        this._presentHost(host, animate, dir);
    }

    // Refresh a kept tab without rebuilding it.
    _refreshTabInPlace(tab) {
        switch (tab) {
        case 'media':
            this._updateMediaTab(this._mpris.getActiveTrackInfo());
            break;
        case 'system':
            this._system.startSysPolling();
            this._updateSystemTabMeters();
            this._queueTrayCardsRefresh();
            break;
        case 'notifications':
            if (this._notificationsSignature(this._collectNotifications()) !== this._notifSignature)
                this._renderActiveTab();
            break;
        case 'home':
            this._refreshHomeTab?.();
            break;
        case 'focus':
            if (this._swUi) this._swUi.update();
            else this._refreshFocusTab?.();
            break;
        case 'launcher':
            this._launcherUi?.update();
            break;
        case 'clipboard':
            this._clipUi?.fill();
            break;
        case 'calendar':
        case 'weather':
        case 'tasks':
        case 'notes':
            // Kept current by their change handlers (or marked dirty).
            break;
        default:
            // Shelf, wallpaper, studio: cheap, and their state lives outside us.
            this._renderActiveTab();
        }
    }

    // Tab change: the outgoing view shrinks a touch and fades fast, the new
    // one grows in from the top edge (the same swap the pill and its alerts
    // use). Transforms and opacity only — never a relayout per frame.
    _presentHost(host, animate, dir) {
        let swap = St.Settings.get().enable_animations && animate;
        for (let h of this._tabHosts.values()) {
            if (h === host || !h.visible)
                continue;
            h.remove_all_transitions();
            if (!swap) {
                h.visible = false;
                continue;
            }
            this._leavingHosts.add(h);
            h.set_pivot_point(0.5, 0);
            h.ease({
                opacity: 0, scale_x: 0.97, scale_y: 0.97,
                duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    h.visible = false;
                    h.opacity = 255;
                    h.scale_x = h.scale_y = 1;
                    this._leavingHosts.delete(h);
                },
            });
        }
        host.remove_all_transitions();
        host.translation_x = 0;
        if (swap) {
            swapContent(null, host);
            // Hosts overlap during the swap; clip them to the content area.
            this._contentContainer.clip_to_allocation = true;
            if (this._clipResetId) GLib.Source.remove(this._clipResetId);
            this._clipResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 420, () => {
                this._clipResetId = 0;
                if (this._contentContainer)
                    this._contentContainer.clip_to_allocation = false;
                return GLib.SOURCE_REMOVE;
            });
        } else {
            host.visible = true;
            host.opacity = 255;
            host.scale_x = host.scale_y = 1;
        }
        if (this.isExpanded && !this._isExpanding)
            this._resizeToContent();
    }

    // Data for `tabs` changed: refresh now if one is on screen, otherwise make
    // sure the next open re-renders instead of reusing the kept content.
    _invalidateTab(...tabs) {
        let refreshNow = false;
        for (let tab of tabs) {
            if (tab === this._activeTab && this.isExpanded)
                refreshNow = true;
            else
                this._markTabDirty(tab);
        }
        return refreshNow;
    }

    // Accent / feature changes bake into every tab: re-render the visible one
    // and let the others rebuild when next shown.
    _invalidateAllTabs() {
        for (let tab of this._tabHosts?.keys() ?? [])
            this._markTabDirty(tab);
        if (this.isExpanded)
            this._showActiveTab();
    }

    // Forget every actor reference a tab render stashed on `this`. Called just
    // before the tab content is destroyed, so a late idle/timeout/async reply
    // finds null instead of touching a disposed actor (each of these used to
    // produce "already disposed" criticals after a quick tab switch).
    _dropTabRefs(tab) {
        const REFS = {
            system: ['_trayMeters', '_trayUi'],
            wallpaper: ['_wpDeck', '_wpItems', '_wpSubtitle', '_wpCounter'],
            calendar: ['_calPanel', '_calAgenda', '_calDateStrip', '_calDateStripRow',
                '_calSummaryDay', '_calSummaryDate'],
            shelf: ['_shareStatus'],
            media: ['_knobValue', '_mediaUi', '_lyricsUi'],
            home: ['_homeUi'],
            tasks: ['_tasksUi'],
            focus: ['_focusUi', '_swUi'],
            launcher: ['_launcherUi'],
            clipboard: ['_clipUi'],
            notes: ['_notesUi'],
        };
        for (let ref of REFS[tab] ?? [])
            this[ref] = null;
    }

    // Collapsing keeps the Music tab's actors for a fast re-open, but nothing
    // should animate or tick behind a closed notch.
    _pauseMediaAnimations() {
        this._mediaUi?.vinyl.stopSpin();
        this._mediaUi?.eq.stop();
        this._stopTimelineTick();
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
        this._timelineTotal = null;
        this._timelineTrack = null;
        this._mediaUi = null;
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
                logError('Failed to apply album art', e);
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
        this._downloadAlbumArt(url, target);
    }

    // Album-art URLs come from whatever app owns an MPRIS name, so treat them
    // as untrusted: only accept an image/* response, and stream it with a hard
    // size cap instead of buffering an arbitrarily large body in the shell.
    _downloadAlbumArt(url, target) {
        const MAX_BYTES = 5 * 1024 * 1024;
        let fail = () => this._finishAlbumArtResolve(url, null);
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (e) {
            fail();
            return;
        }
        if (!msg) { fail(); return; }
        this._artSession.send_async(msg, GLib.PRIORITY_LOW, this._artCancellable, (session, res) => {
            let stream;
            try {
                stream = session.send_finish(res);
            } catch (e) {
                fail();
                return;
            }
            let type = msg.response_headers.get_content_type()[0] ?? '';
            let declared = msg.response_headers.get_content_length();
            if (msg.get_status() !== Soup.Status.OK || !type.startsWith('image/') || declared > MAX_BYTES) {
                stream.close_async(GLib.PRIORITY_LOW, null, null);
                fail();
                return;
            }
            let chunks = [];
            let total = 0;
            let readMore = () => stream.read_bytes_async(64 * 1024, GLib.PRIORITY_LOW, this._artCancellable, (s2, r2) => {
                let bytes;
                try {
                    bytes = s2.read_bytes_finish(r2);
                } catch (e) {
                    fail();
                    return;
                }
                let n = bytes.get_size();
                if (n > 0) {
                    total += n;
                    if (total > MAX_BYTES) {
                        stream.close_async(GLib.PRIORITY_LOW, null, null);
                        fail();
                        return;
                    }
                    chunks.push(bytes.toArray());
                    readMore();
                    return;
                }
                stream.close_async(GLib.PRIORITY_LOW, null, null);
                if (total === 0) { fail(); return; }
                let all = new Uint8Array(total);
                let off = 0;
                for (let c of chunks) { all.set(c, off); off += c.length; }
                target.replace_contents_bytes_async(new GLib.Bytes(all), null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                    this._artCancellable, (file, wres) => {
                        try {
                            file.replace_contents_finish(wres);
                            this._finishAlbumArtResolve(url, file.get_path());
                        } catch (e) {
                            fail();
                        }
                    });
            });
            readMore();
        });
    }

    // Keep the on-disk art cache bounded (newest 200 files).
    _pruneArtCache() {
        try {
            let en = this._artCacheDir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let files = [];
            let info;
            while ((info = en.next_file(null)) !== null)
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            en.close(null);
            files.sort((a, b) => b[1] - a[1]);
            for (let [n] of files.slice(200)) {
                try { this._artCacheDir.get_child(n).delete(null); } catch (e) {}
            }
        } catch (e) {}
    }

    _finishAlbumArtResolve(url, path) {
        if (this._destroyed) return;
        if (path) {
            this._artCache.set(url, path);
            // Bounded memo: drop the oldest entry (Map keeps insertion order).
            if (this._artCache.size > 200)
                this._artCache.delete(this._artCache.keys().next().value);
        }

        let callbacks = this._artPending.get(url) || [];
        this._artPending.delete(url);
        for (let cb of callbacks)
            cb(path);
    }

    _refreshLive() {
        if (this._destroyed) return;
        let info = this._mpris.getActiveTrackInfo();
        // Show the pill music zone whenever a player has media loaded (playing
        // OR paused) — a paused Spotify track is still "the media you're on".
        // One live activity at a time: a running focus timer takes the zone.
        let showMusic = info.hasMedia && !this._prod?.focusActive && !this._prod?.stopwatch.running &&
            (info.status === 'Playing' || info.status === 'Paused');
        this._musicPlaying = showMusic && info.status === 'Playing';
        let wasVisible = this._pillMusicBox.visible;
        this._pillMusicBox.visible = showMusic;

        if (showMusic) {
            let label = info.artist && info.artist !== 'Unknown Artist'
                ? `${info.title} — ${info.artist}` : info.title;
            if (this._pillTitle.text !== label) {
                this._pillTitle.set_text(label);
                this._startPillMarquee();
            }
            // Bars only bounce while actually playing (and visible); a paused
            // track sits still.
            if (info.status === 'Playing' && !this._alertShowing && !this._tucked) this._pillEq.start();
            else this._pillEq.stop();
        } else {
            this._pillEq.stop();
            this._stopPillMarquee();
            this._pillTitle.set_text('');
        }

        // Grow/shrink the pill smoothly to make room for (or reclaim) the title.
        if (showMusic !== wasVisible) {
            if (showMusic) {
                this._pillMusicBox.opacity = 0;
                this._pillMusicBox.ease({
                    opacity: 255,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
            if (!this.isExpanded)
                this._applyPillWidth();
        }

        if (this.isExpanded && this._activeTab === 'media')
            this._updateMediaTab(info);
        else if (this.isExpanded && this._activeTab === 'home')
            this._homeUi?.updateMedia(info);
        this._syncPillStats?.();
        this._updateTuck?.();
    }

    _queueMediaUpdate() {
        if (this._mediaUpdateId || this._destroyed)
            return;
        this._mediaUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._mediaUpdateId = 0;
            this._refreshLive();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Volume moved (knob scroll, keyboard keys, another app): only the knob
    // and the Tray sound tile care, so never rebuild a whole tab for it.
    _onVolumeChanged() {
        if (this._destroyed) return;
        let ui = this._mediaUi;
        if (ui && this._activeTab === 'media') {
            ui.knob.setValue(this._system.volume / 100);
            ui.knobValue.set_text(String(this._system.volume));
        }
        if (this._activeTab === 'system')
            this._syncTraySliders?.();
    }

    _onWeatherUpdated() {
        if (this._destroyed) return;
        if (this._invalidateTab('weather', 'home'))
            this._renderActiveTab();
    }

    // Calendar server pushed new/removed events: refresh just the agenda when
    // the Calendar tab is on screen (Home picks it up on its next render).
    _onCalendarEventsChanged() {
        if (this._destroyed) return;
        if (!this._invalidateTab('calendar', 'home'))
            return;
        if (this._activeTab === 'calendar' && this._refreshCalendarAgenda())
            this._resizeToContent();
        else
            this._renderActiveTab();
    }

    // Repaint the mic / camera privacy dots on the pill.
    //   Mic:    muted → red, in use → green, otherwise hidden (idle).
    //   Camera: in use → green, otherwise hidden (idle).
    // We only surface an indicator when it has something to say, so an idle
    // machine keeps a clean pill.
    _updatePrivacyIndicators() {
        if (this._destroyed) return;
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
        if (after !== before)
            this._updateTuck?.();
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
        let floor = this._pillMusicBox.visible || this._pillFocusBox?.visible || this._pillSwBox?.visible
            ? PILL_WIDTH_MUSIC : PILL_WIDTH;
        // Measuring preferred widths queries the theme node, which is only valid
        // once the actor is on the stage. Before then (early setup / reposition)
        // fall back to the floor; the real width is applied once staged.
        if (!this._pillClock || !this._pillClock.get_stage()) return floor;

        // Collect the widths of the zones that are actually visible, in flow
        // order. The clock is always present; music/battery/priv are optional.
        let zones = [];
        if (this._pillFocusBox?.visible)
            zones.push(this._pillFocusBox.get_preferred_width(-1)[1]);
        if (this._pillSwBox?.visible)
            zones.push(this._pillSwBox.get_preferred_width(-1)[1]);
        if (this._pillStatsBox?.visible)
            zones.push(this._pillStatsBox.get_preferred_width(-1)[1]);
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
        if (this._destroyed) return;
        // Before addTopChrome stages us, sizes can't be measured (St logs
        // "not in the stage"); the first map syncs the width instead.
        if (!this.get_stage()) return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        this._balancePillClock();
        // An alert or the tucked strip owns the geometry right now; the pill
        // gets its width back when they let go.
        if (this.isExpanded || this._peekActive || this._alertShowing || this._tucked)
            return;
        let width = this._pillWidth();
        let targetX = monitor.x + Math.floor((monitor.width - width) / 2);
        springTo(this, { x: targetX, width }, { duration: 380, damping: 1 });
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
    // Music: one tab, two views. "Player" is the vinyl + volume knob; the
    // lyrics button in the transport swaps them for a cover tile and synced
    // lyrics (Apple Music's layout). The title, transport and timeline are
    // the same actors in both views, so switching never rebuilds the tab.
    _renderMediaTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-music', vertical: true, x_expand: true, y_expand: true });
        let info = this._mpris.getActiveTrackInfo();

        let body = new St.BoxLayout({ style_class: 'nook-media-body', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });

        // --- Player view: spinning vinyl (Cairo) with the art pressed in ---
        let vinyl = new Vinyl(140);
        this._vinyl = vinyl;
        let vinylWrap = new St.Bin({ y_align: Clutter.ActorAlign.CENTER });
        let vinylStack = new St.Widget({ layout_manager: new Clutter.BinLayout(), width: 140, height: 140 });
        vinylStack.add_child(vinyl);
        let artDisc = new AlbumArtDisc(52);
        artDisc.x_align = Clutter.ActorAlign.CENTER;
        artDisc.y_align = Clutter.ActorAlign.CENTER;
        let artFrame = new St.Bin({
            style_class: 'nook-vinyl-art-frame',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        artFrame.set_child(artDisc);
        vinylStack.add_child(artFrame);
        vinylWrap.set_child(vinylStack);
        body.add_child(vinylWrap);

        // --- Lyrics view: a square cover tile (placeholder note underneath) ---
        let coverWrap = new St.Widget({ style_class: 'nook-cover', layout_manager: new Clutter.BinLayout(),
            width: 92, height: 92, y_align: Clutter.ActorAlign.START, visible: false });
        coverWrap.add_child(new St.Icon({ icon_name: 'audio-x-generic-symbolic', icon_size: 30,
            style_class: 'nook-cover-placeholder', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER }));
        let cover = new AlbumArtDisc(92);
        cover.add_style_class_name('nook-cover-art');
        coverWrap.add_child(cover);
        body.add_child(coverWrap);

        // --- Info + transport (shared by both views) ---
        let mid = new St.BoxLayout({ style_class: 'nook-media-mid', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let eyebrow = new St.BoxLayout({ style_class: 'nook-eyebrow-row', vertical: false, x_expand: true });
        let eyebrowLabel = new St.Label({ style_class: 'nook-eyebrow', y_align: Clutter.ActorAlign.CENTER });
        eyebrowLabel.set_style(`color: ${accentHex()};`);
        eyebrowLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        eyebrow.add_child(eyebrowLabel);
        let eq = new EqBars();
        this._eq = eq;
        eyebrow.add_child(eq);
        eyebrow.add_child(new St.Widget({ x_expand: true }));
        let lyricsBadge = new St.Label({ style_class: 'nn-lyrics-badge', y_align: Clutter.ActorAlign.CENTER, visible: false });
        lyricsBadge.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        eyebrow.add_child(lyricsBadge);
        mid.add_child(eyebrow);

        let titleLabel = new St.Label({ style_class: 'nook-track-title' });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        let artistLabel = new St.Label({ style_class: 'nook-track-artist' });
        artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        mid.add_child(titleLabel);
        mid.add_child(artistLabel);

        // Transport controls. Each returns { btn, icon } so updates can retint
        // and re-enable them in place.
        let controls = new St.BoxLayout({ style_class: 'nook-transport', vertical: false, x_expand: true });
        let mkBtn = (cb, primary = false, parent = controls) => {
            let btn = new St.Button({ style_class: primary ? 'nook-transport-btn nook-transport-primary' : 'nook-transport-btn',
                can_focus: true });
            // The CSS paints the primary (play/pause) button a fixed blue; follow
            // the user's accent instead.
            if (primary) {
                let rgb = accentRgbStr();
                btn.set_style(`background-color: rgba(${rgb}, 1);`);
            }
            let icon = new St.Icon({ icon_size: primary ? 18 : 16, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            btn.set_child(icon);
            btn.connect('clicked', cb);
            addPressFeedback(btn, primary ? 0.9 : 0.86);
            parent.add_child(btn);
            return { btn, icon };
        };
        let prev = mkBtn(() => this._mpris.previous());
        prev.icon.icon_name = 'media-skip-backward-symbolic';
        let play = mkBtn(() => this._mpris.playPause(), true);
        let next = mkBtn(() => this._mpris.next());
        next.icon.icon_name = 'media-skip-forward-symbolic';
        let shuffle = mkBtn(() => this._mpris.toggleShuffle());
        shuffle.icon.icon_name = 'media-playlist-shuffle-symbolic';
        let loop = mkBtn(() => this._mpris.cycleLoop());
        controls.add_child(new St.Widget({ x_expand: true }));
        let lyricsBtn = mkBtn(() => this._setMusicLyrics(!this._mediaUi?.lyricsOn));
        lyricsBtn.icon.icon_name = 'media-view-subtitles-symbolic';
        lyricsBtn.btn.accessible_name = 'Lyrics';
        this._attachTrayTooltip?.(lyricsBtn.btn, 'Lyrics');
        mid.add_child(controls);
        body.add_child(mid);

        // --- Player view: volume knob (Cairo, scroll to change) ---
        let knobCol = new St.BoxLayout({ style_class: 'nook-knob-col', vertical: true, y_align: Clutter.ActorAlign.CENTER });
        let knob = new Knob(74);
        knob.setValue(this._system.volume / 100);
        let knobBtn = new St.Button({ style_class: 'nook-knob-btn', reactive: true, can_focus: false });
        knobBtn.set_child(knob);
        let knobOverlay = new St.Bin({ style_class: 'nook-knob-value', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        let knobValue = new St.Label({ text: String(this._system.volume), style_class: 'nook-knob-num' });
        knobOverlay.set_child(knobValue);
        this._knobValue = knobValue;
        // Scroll over the knob nudges the volume ±4%. The knob repaints right
        // away; the mixer's notify then lands in _onVolumeChanged, which only
        // touches these two actors.
        knobBtn.connect('scroll-event', (a, e) => {
            let dir = e.get_scroll_direction();
            let delta = 0;
            if (dir === Clutter.ScrollDirection.UP) delta = 4;
            else if (dir === Clutter.ScrollDirection.DOWN) delta = -4;
            else if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [, dy] = e.get_scroll_delta();
                delta = Math.round(-dy * 4);
            }
            if (delta) {
                let v = Math.max(0, Math.min(100, this._system.volume + delta));
                this._system.setVolume(v);
                knob.setValue(v / 100);
                knobValue.set_text(String(v));
            }
            return Clutter.EVENT_STOP;
        });
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

        // --- Lyrics view: the synced-lyrics window ---
        let lyrics = this._buildLyricsBlock(lyricsBadge);
        lyrics.visible = false;
        panel.add_child(lyrics);

        // --- Timeline scrubber. In the player view it's indented to line up
        // with the title: 156 = 140 (vinyl) + 20 (body spacing) − 4 (padding).
        let timelineRow = new St.BoxLayout({ vertical: false, x_expand: true });
        let timelineIndent = new St.Widget({ width: 156 });
        timelineRow.add_child(timelineIndent);
        let timeline = this._buildMediaTimeline();
        timeline.x_expand = true;
        timelineRow.add_child(timeline);
        panel.add_child(timelineRow);

        this._mount(panel);

        this._mediaUi = {
            vinyl, eq, artDisc, cover, artUrl: null,
            eyebrow: eyebrowLabel, title: titleLabel, artist: artistLabel,
            prev, play, next, shuffle, loop, lyricsBtn, knob, knobValue,
            vinylWrap, coverWrap, knobCol, lyrics, lyricsBadge, timelineIndent,
            lyricsOn: false, lyricsKey: undefined,
        };
        lyricsBtn.btn.visible = false;
        this._applyMusicView(this._config.musicLyrics, false);
        this._updateMediaTab(info);
    }

    // Switch the Music tab between the player and lyrics views, remembering
    // the choice. The swap is a short cross-fade plus the usual height spring.
    _setMusicLyrics(on) {
        if (!this._mediaUi || this._mediaUi.lyricsOn === on)
            return;
        this._writeConfig(c => c.setMusicLyrics(on));
        this._applyMusicView(on, true);
        this._updateMediaTab(this._mpris.getActiveTrackInfo());
        if (!on)
            this._stopLyricsTick();
    }

    _applyMusicView(on, animate) {
        let ui = this._mediaUi;
        ui.lyricsOn = on;
        ui.vinylWrap.visible = !on;
        ui.knobCol.visible = !on;
        ui.coverWrap.visible = on;
        ui.lyrics.visible = on;
        ui.timelineIndent.visible = !on;
        if (!on)
            ui.lyricsBadge.visible = false;
        ui.lyricsBtn.icon.set_style(on ? `color: ${accentHex()};` : null);
        ui.lyricsBtn.btn.set_style(on ? `background-color: rgba(${accentRgbStr()}, 0.16);` : null);
        if (on) ui.vinyl.stopSpin();
        if (!animate || !St.Settings.get().enable_animations)
            return;
        // New view arrives from slightly below and fades in; the outgoing one
        // is simply hidden (the notch's own height spring carries the change).
        for (let a of on ? [ui.coverWrap, ui.lyrics] : [ui.vinylWrap, ui.knobCol]) {
            a.remove_all_transitions();
            a.opacity = 0;
            a.translation_y = 6;
            a.ease({ opacity: 255, translation_y: 0, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        }
        this._resizeToContent();
    }

    // Re-stamp the Music tab from fresh track info without rebuilding it. The
    // old code tore down the vinyl, knob, timeline and art on every MPRIS,
    // volume, weather and calendar event — scrolling the volume knob destroyed
    // the knob under the cursor on each tick.
    _updateMediaTab(info) {
        let ui = this._mediaUi;
        if (!ui)
            return;
        this._mediaInfo = info;
        let playing = info.status === 'Playing';
        ui.eyebrow.set_text(playing ? 'NOW PLAYING' : (info.hasMedia ? 'PAUSED' : 'NO MEDIA'));
        if (playing) {
            if (!ui.lyricsOn) ui.vinyl.startSpin();
            ui.eq.start();
        } else {
            ui.vinyl.stopSpin();
            ui.eq.stop();
        }

        // Coerce defensively: an un-unwrapped GLib.Variant would throw in set_text.
        ui.title.set_text(String(info.hasMedia ? info.title : 'Nothing playing'));
        ui.artist.set_text(String(info.hasMedia ? info.artist : 'Start something in your player'));

        ui.play.icon.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        ui.play.btn.reactive = info.hasMedia && info.canPlay !== false;
        ui.prev.btn.reactive = info.hasMedia && info.canPrev !== false;
        ui.next.btn.reactive = info.hasMedia && info.canNext !== false;
        // Shuffle / repeat: lit (accent) when engaged, dimmed when unsupported.
        let lit = on => (on ? `color: ${accentHex()};` : null);
        ui.shuffle.btn.reactive = !!info.hasShuffle;
        ui.shuffle.icon.set_style(lit(info.shuffle));
        ui.loop.btn.reactive = !!info.hasLoop;
        ui.loop.icon.icon_name = info.loopStatus === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        ui.loop.icon.set_style(lit(info.hasLoop && info.loopStatus !== 'None'));
        ui.knob.setValue(this._system.volume / 100);
        ui.knobValue.set_text(String(this._system.volume));

        if (info.albumArt !== ui.artUrl) {
            ui.artUrl = info.albumArt;
            ui.artDisc.setArtPath(null);
            ui.cover.setArtPath(null);
            this._loadAlbumArt(info.albumArt, ui.artDisc);
            this._loadAlbumArt(info.albumArt, ui.cover);
        }
        this._syncTimeline(info);
        // Show the lyrics button only when this song has lyrics (may switch
        // the view back to the player), then feed the lyrics view if it's up.
        this._syncLyricsAvailability(info);
        if (ui.lyricsOn)
            this._lyricsUi?.onTrack(info);
    }

    // Full-width playback timeline placed below the media body. Shows elapsed /
    // total time with an accent-filled progress bar, and seeks on scroll. Built
    // empty; _syncTimeline() fills it from the current track.
    _buildMediaTimeline() {
        this._timelineKey = null;
        this._timelinePosUs = 0;
        this._timelineLenUs = 0;
        this._timelineTrackId = null;

        let wrap = new St.BoxLayout({ style_class: 'nook-timeline', vertical: true, x_expand: true });

        // The track is a reactive button so it captures scroll events across the
        // whole width. The accent fill spans the whole base and shows progress
        // through scale_x anchored at the left edge: a transform needs no
        // relayout, so per-second updates never dirty the allocation (resizing
        // the fill from a notify::allocation handler re-queued layout mid-pass
        // and spammed "needs an allocation"), and the bar can glide smoothly.
        let trackBtn = new St.Button({ style_class: 'nook-timeline-track', can_focus: false, x_expand: true });
        let base = new St.Widget({
            style_class: 'nook-timeline-base',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout() });
        let fill = new St.Widget({ style_class: 'nook-timeline-fill', x_expand: true, y_expand: true });
        fill.set_style(`background-color: ${accentHex()};`);
        fill.set_pivot_point(0, 0.5);
        fill.scale_x = 0;
        base.add_child(fill);
        trackBtn.set_child(base);
        this._timelineFill = fill;
        this._timelineBase = base;
        this._timelineTrack = trackBtn;

        let labels = new St.BoxLayout({ style_class: 'nook-timeline-labels', vertical: false, x_expand: true });
        let elapsed = new St.Label({ text: '0:00', style_class: 'nook-timeline-elapsed' });
        let total = new St.Label({ text: '--:--', style_class: 'nook-timeline-total', x_align: Clutter.ActorAlign.END, x_expand: true });
        labels.add_child(elapsed);
        labels.add_child(total);
        this._timelineElapsed = elapsed;
        this._timelineTotal = total;

        wrap.add_child(trackBtn);
        wrap.add_child(labels);

        // Scroll to scrub: one notch = ±5s, throttled so a spin doesn't spam
        // D-Bus. Only meaningful when we know the track length and can seek.
        trackBtn.connect('scroll-event', (actor, event) => {
            if (!this._mediaInfo?.hasMedia || this._timelineLenUs <= 0)
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
        return wrap;
    }

    // Point the timeline at `info`'s track: reset on a track change, resync the
    // position from the player, and run the 1 s tick only while playing.
    _syncTimeline(info) {
        if (!this._timelineBase)
            return;
        let key = `${info.trackId}|${info.title}|${info.length}`;
        if (key !== this._timelineKey) {
            this._timelineKey = key;
            this._timelinePosUs = 0;
        }
        this._timelineLenUs = Number(info.length) || 0;
        this._timelineTrackId = info.trackId ?? null;
        this._timelineTotal.set_text(this._timelineLenUs > 0 ? this._fmtTime(this._timelineLenUs) : '--:--');
        this._timelineTrack.reactive = !!info.hasMedia;
        if (info.hasMedia) {
            this._mpris.getPositionAsync(pos => {
                if (this._timelineKey !== key || !this._timelineBase)
                    return;
                this._timelinePosUs = pos;
                this._updateTimelineFill();
            });
        }
        this._updateTimelineFill();
        if (info.status === 'Playing' && this._timelineLenUs > 0) {
            if (!this._timelineTickId)
                this._startTimelineTick();
        } else {
            this._stopTimelineTick();
        }
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

    // Repaint the progress fill and elapsed label from the cached position.
    // `glideMs` > 0 eases the bar there linearly (the 1 s tick), so playback
    // reads as continuous motion instead of a once-a-second jump.
    _updateTimelineFill(glideMs = 0) {
        let len = this._timelineLenUs;
        let frac = len > 0 ? Math.max(0, Math.min(1, this._timelinePosUs / len)) : 0;
        let fill = this._timelineFill;
        if (fill) {
            fill.remove_transition('scale-x');
            if (glideMs > 0)
                fill.ease({ scale_x: frac, duration: glideMs, mode: Clutter.AnimationMode.LINEAR });
            else
                fill.scale_x = frac;
        }
        this._timelineElapsed?.set_text(this._fmtTime(this._timelinePosUs));
    }

    _startTimelineTick() {
        this._stopTimelineTick();
        let ticks = 0;
        this._timelineTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            // Advance locally by 1 s and glide the bar; every 10 s resync from
            // the player to correct drift and catch external seeks.
            this._timelinePosUs = Math.min(this._timelinePosUs + 1000000,
                this._timelineLenUs > 0 ? this._timelineLenUs : Infinity);
            this._updateTimelineFill(1000);
            if (++ticks % 10 === 0) {
                let key = this._timelineKey;
                this._mpris.getPositionAsync(pos => {
                    if (this._timelineKey === key && this._timelineFill && pos > 0)
                        this._timelinePosUs = pos;
                });
            }
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
    // A muted "+N more…" row that reveals the full list in an overlay. Used to
    // cap the DEVICES / WIFI cards at a few rows without a (collapsing)
    // ScrollView.
    _buildMoreRow(label, onClick) {
        let row = new St.Button({ style_class: 'nook-more-row', reactive: true, x_expand: true, can_focus: true });
        row.set_child(new St.Label({ text: label, style_class: 'nook-more-label',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        row.connect('clicked', onClick);
        return row;
    }

    // Build one DEVICES-card row from a descriptor. Paired Bluetooth devices
    // (those carrying a dbusPath) become buttons whose whole row toggles the
    // connection on click; everything else is a plain, non-reactive row.
    _buildDeviceRow(d) {
        let clickable = d.bluetooth && d.dbusPath;
        let row = clickable
            ? new St.Button({ style_class: 'nook-device-row nook-device-row-btn', reactive: true, x_expand: true, can_focus: true })
            : new St.BoxLayout({ style_class: 'nook-device-row', vertical: false, x_expand: true });
        let inner = clickable
            ? new St.BoxLayout({ style_class: 'nook-device-row-inner', vertical: false, x_expand: true })
            : row;
        inner.add_child(new St.Icon({ icon_name: d.icon, icon_size: 16, style_class: 'nook-device-icon', y_align: Clutter.ActorAlign.CENTER }));
        inner.add_child(new St.Label({ text: d.name, style_class: 'nook-device-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        // A connected device with a known battery level shows its gauge; a
        // paired-but-disconnected device shows its "Paired" badge (tap to
        // connect) even if it reported a stale battery reading.
        let showPct = Number.isFinite(d.pct) && !(clickable && !d.connected);
        if (showPct) {
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
            // "Connected" / "Paired" badge. Paired-but-disconnected rows are
            // tappable to connect; the hover highlight on the row signals that.
            let badgeCls = 'nook-device-pct'
                + (clickable && !d.connected ? ' nook-device-badge-paired'
                    : d.connected ? ' nook-device-badge-connected' : '');
            inner.add_child(new St.Label({ text: d.status,
                style_class: badgeCls, y_align: Clutter.ActorAlign.CENTER }));
        }
        if (clickable) {
            row.set_child(inner);
            let want = !d.connected;
            row.connect('clicked', () => {
                row.reactive = false;
                this._system.setBluetoothConnected(d.dbusPath, want, () => {
                    this._queueTrayCardsRefresh();
                });
            });
        }
        return row;
    }

    // ============================================================
    // Scan overlays (Bluetooth pair / WiFi connect)
    // ============================================================

    // Open a modal-style overlay over the dashboard: a dimming scrim plus a
    // centered card with a title, close (X) button and a caller-populated body.
    // Returns { overlay, body, setStatus } so the caller can fill/refresh the
    // body and show a status line. Only one overlay exists at a time; opening a
    // new one closes the previous. Escape or a scrim click closes it.
    //
    // `onClose` (optional) runs on teardown so callers can stop discovery/scans.
    _openScanOverlay({ title, onClose }) {
        this._closeScanOverlay();

        let overlay = new St.Widget({
            style_class: 'nook-scan-overlay',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });
        // Pin the overlay exactly over the dashboard (position + size), even as
        // it resizes. It's parented to the top-level BinLayout actor — NOT to the
        // vertical `_dashboard` BoxLayout, where it would be laid out *below* the
        // content instead of floating on top of it.
        overlay.add_constraint(new Clutter.BindConstraint({
            source: this._dashboard, coordinate: Clutter.BindCoordinate.POSITION }));
        overlay.add_constraint(new Clutter.BindConstraint({
            source: this._dashboard, coordinate: Clutter.BindCoordinate.SIZE }));

        // Card floats near the top of the dashboard (just under the header) so
        // it reads as a sheet dropping from the notch, not a box centered in the
        // tall dashboard allocation.
        let card = new St.BoxLayout({ style_class: 'nook-scan-card', vertical: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START });

        let header = new St.BoxLayout({ style_class: 'nook-scan-header', vertical: false, x_expand: true });
        header.add_child(new St.Label({ text: title, style_class: 'nook-scan-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        let closeBtn = new St.Button({ style_class: 'nook-scan-close', reactive: true, can_focus: true });
        closeBtn.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }));
        closeBtn.connect('clicked', () => this._closeScanOverlay(true));
        header.add_child(closeBtn);
        card.add_child(header);

        let status = new St.Label({ text: '', style_class: 'nook-scan-status' });
        status.visible = false;
        card.add_child(status);

        let scroll = new St.ScrollView({ style_class: 'nook-scan-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        let body = new St.BoxLayout({ style_class: 'nook-scan-body', vertical: true, x_expand: true });
        scroll.set_child(body);
        card.add_child(scroll);

        overlay.add_child(card);
        // A click on the scrim (outside the card) closes; clicks on the card are
        // swallowed so they don't bubble up to the scrim handler.
        //
        // NOTE: never return EVENT_STOP from a press handler on an ancestor of
        // St.Buttons — on GNOME 50 St.Button is driven by a ClutterClickGesture
        // and a stopped press cancels it, so the close (X) and every row went
        // dead. Decide by the event source instead and let presses inside the
        // card propagate untouched.
        card.reactive = true;
        overlay.connect('button-press-event', (a, ev) => {
            if (this._isDescendantOf(global.stage.get_event_actor(ev), card))
                return Clutter.EVENT_PROPAGATE;
            this._closeScanOverlay(true);
            return Clutter.EVENT_STOP;
        });
        // Escape closes the overlay.
        overlay.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) { this._closeScanOverlay(true); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });

        // Parent to the top-level BinLayout actor so the overlay stacks *over*
        // the dashboard (BinLayout overlays children) rather than being appended
        // below it as another vertical box row.
        this.add_child(overlay);
        overlay.grab_key_focus();
        // Materialize: the scrim fades in while the sheet drops a few px from
        // the header and settles — it reads as coming out of the notch.
        if (St.Settings.get().enable_animations) {
            overlay.opacity = 0;
            card.set_pivot_point(0.5, 0);
            card.translation_y = -10;
            card.scale_x = card.scale_y = 0.97;
            overlay.ease({ opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            card.ease({ translation_y: 0, scale_x: 1, scale_y: 1, duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO });
        }

        this._scanOverlay = { overlay, body, onClose, timerId: 0,
            setStatus: (text) => {
                if (!text) { status.visible = false; return; }
                status.text = text; status.visible = true;
            } };
        return this._scanOverlay;
    }

    // Tear down the current scan overlay, running its onClose (stop discovery /
    // scan timers) and removing the actor. Safe to call when none is open.
    _closeScanOverlay(animate = false) {
        let ov = this._scanOverlay;
        if (!ov) return;
        this._scanOverlay = null;
        if (ov.timerId) { GLib.Source.remove(ov.timerId); ov.timerId = 0; }
        try { if (ov.onClose) ov.onClose(); } catch (e) { /* ignore */ }
        // A user dismissal fades out quickly (exit faster than enter); a
        // teardown (tab re-render, collapse) removes it at once.
        if (animate && St.Settings.get().enable_animations) {
            ov.overlay.reactive = false;
            ov.overlay.ease({ opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => ov.overlay.destroy() });
        } else {
            try { ov.overlay.destroy(); } catch (e) { /* ignore */ }
        }
        // Pick up any Wi-Fi / Bluetooth change made from the overlay.
        if (!this._destroyed)
            this._queueTrayCardsRefresh();
    }

    // Bluetooth: power the radio on (if needed), start discovery, and list
    // nearby devices, refreshing on a timer. Tapping a device pairs+connects it.
    _openBluetoothScanOverlay() {
        let ov = this._openScanOverlay({
            title: 'Bluetooth',
            onClose: () => this._system.stopBluetoothDiscovery(),
        });
        ov.setStatus('Scanning…');

        // Ensure the adapter is on, then begin discovery.
        this._system.setBluetoothRadio(true, () => {
            this._system.startBluetoothDiscovery(() => {});
        });

        // Track in-flight pair attempts so their rows show a spinner label and
        // don't get rebuilt out from under the user mid-pair.
        let pairing = new Set();

        // Rows are only rebuilt when the list actually changed, so hover and
        // focus survive the periodic refresh.
        let lastSig = null;
        let refresh = () => {
            if (this._scanOverlay !== ov) return; // closed since scheduled
            let devices = this._system.getDiscoveredBluetoothDevices();
            let sig = JSON.stringify([devices.map(d => [d.dbusPath, d.name, d.paired, d.connected]), [...pairing]]);
            if (sig === lastSig) return;
            lastSig = sig;
            ov.body.destroy_all_children();
            if (devices.length === 0) {
                ov.body.add_child(new St.Label({ text: 'Searching for nearby devices…',
                    style_class: 'nook-scan-empty' }));
                return;
            }
            for (let d of devices) {
                let busy = pairing.has(d.dbusPath);
                let row = new St.Button({ style_class: 'nook-scan-row', reactive: !busy,
                    can_focus: !busy, x_expand: true });
                let inner = new St.BoxLayout({ vertical: false, x_expand: true });
                inner.add_child(new St.Icon({ icon_name: d.icon, icon_size: 16,
                    style_class: 'nook-scan-row-icon', y_align: Clutter.ActorAlign.CENTER }));
                inner.add_child(new St.Label({ text: d.name, style_class: 'nook-scan-row-name',
                    x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
                let sub = busy ? 'Pairing…'
                    : d.connected ? 'Connected'
                    : d.paired ? 'Paired' : '';
                inner.add_child(new St.Label({ text: sub, style_class: 'nook-scan-row-sub',
                    y_align: Clutter.ActorAlign.CENTER }));
                row.set_child(inner);
                if (!busy && !d.connected) {
                    row.connect('clicked', () => {
                        pairing.add(d.dbusPath);
                        refresh();
                        this._system.pairBluetoothDevice(d.dbusPath, (ok, err) => {
                            pairing.delete(d.dbusPath);
                            if (!ok)
                                Main.notify('NotchNux Bluetooth',
                                    `Could not pair ${d.name}` + (err ? `: ${err}` : ''));
                            if (this._scanOverlay === ov) refresh();
                            // Reflect the new connection in the card behind.
                            this._scheduleTrayReRender();
                        });
                    });
                }
                ov.body.add_child(row);
            }
        };

        refresh();
        ov.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (this._scanOverlay !== ov) return GLib.SOURCE_REMOVE;
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // WiFi: request a scan and list visible access points, refreshing on a
    // timer. Secure APs reveal an inline password field; open APs connect on
    // tap. A saved profile for the SSID is reused rather than duplicated.
    _openWifiScanOverlay() {
        let ov = this._openScanOverlay({ title: 'Wi-Fi' });
        ov.setStatus('Scanning…');
        this._system.requestWifiScan(() => {});

        // Which SSID currently has its password field expanded (only one at a
        // time), and any in-flight connect attempts.
        let expanded = null;
        let connecting = new Set();

        // The periodic refresh skips unchanged lists and never rebuilds while
        // a password field is open (that used to wipe what you were typing).
        let lastSig = null;
        let refresh = (force = true) => {
            if (this._scanOverlay !== ov) return;
            if (!force && expanded) return;
            let aps = this._system.getWifiAccessPoints();
            let sig = JSON.stringify([aps.map(a => [a.ssid, a.active, a.secure, a.signal >= 75 ? 3 : a.signal >= 50 ? 2 : a.signal >= 25 ? 1 : 0]),
                expanded, [...connecting]]);
            if (!force && sig === lastSig) return;
            lastSig = sig;
            ov.body.destroy_all_children();
            if (aps.length === 0) {
                ov.body.add_child(new St.Label({ text: 'Looking for networks…',
                    style_class: 'nook-scan-empty' }));
                return;
            }
            for (let ap of aps) {
                let busy = connecting.has(ap.ssid);
                let sig = ap.signal;
                let sigIcon = sig >= 75 ? 'network-wireless-signal-excellent-symbolic'
                    : sig >= 50 ? 'network-wireless-signal-good-symbolic'
                    : sig >= 25 ? 'network-wireless-signal-ok-symbolic'
                    : 'network-wireless-signal-weak-symbolic';

                let row = new St.Button({ style_class: 'nook-scan-row', reactive: !busy && !ap.active,
                    can_focus: !busy && !ap.active, x_expand: true });
                let inner = new St.BoxLayout({ vertical: false, x_expand: true });
                inner.add_child(new St.Icon({ icon_name: sigIcon, icon_size: 16,
                    style_class: 'nook-scan-row-icon', y_align: Clutter.ActorAlign.CENTER }));
                inner.add_child(new St.Label({ text: ap.ssid, style_class: 'nook-scan-row-name',
                    x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
                if (ap.secure)
                    inner.add_child(new St.Icon({ icon_name: 'channel-secure-symbolic', icon_size: 12,
                        style_class: 'nook-scan-row-lock', y_align: Clutter.ActorAlign.CENTER }));
                let sub = busy ? 'Connecting…' : ap.active ? 'Connected' : '';
                if (sub)
                    inner.add_child(new St.Label({ text: sub, style_class: 'nook-scan-row-sub',
                        y_align: Clutter.ActorAlign.CENTER }));
                row.set_child(inner);

                let connect = (password) => {
                    connecting.add(ap.ssid);
                    expanded = null;
                    refresh();
                    this._system.connectWifi(ap.ssid, password, (ok, err) => {
                        connecting.delete(ap.ssid);
                        if (!ok)
                            Main.notify('NotchNux Wi-Fi',
                                err === 'not in range'
                                    ? `${ap.ssid} is not in range`
                                    : `Could not connect to ${ap.ssid}` + (err ? `: ${err}` : ''));
                        if (ok) this._closeScanOverlay();
                        else if (this._scanOverlay === ov) refresh();
                        this._scheduleTrayReRender();
                    });
                };

                if (!busy && !ap.active) {
                    row.connect('clicked', () => {
                        if (!ap.secure) { connect(''); return; }
                        // Secure: toggle an inline password field for this SSID.
                        expanded = (expanded === ap.ssid) ? null : ap.ssid;
                        refresh();
                    });
                }
                ov.body.add_child(row);

                // Inline password entry for the expanded secure network.
                if (ap.secure && expanded === ap.ssid && !busy) {
                    let pwRow = new St.BoxLayout({ style_class: 'nook-scan-pw', vertical: false, x_expand: true });
                    let entry = new St.Entry({ style_class: 'nook-scan-entry',
                        hint_text: 'Password', can_focus: true, x_expand: true });
                    entry.clutter_text.set_password_char('●');
                    this._makeTypable(entry);
                    entry.clutter_text.connect('activate', () => connect(entry.get_text()));
                    let go = new St.Button({ style_class: 'nook-scan-connect', reactive: true, can_focus: true });
                    go.set_child(new St.Label({ text: 'Connect' }));
                    go.connect('clicked', () => connect(entry.get_text()));
                    pwRow.add_child(entry);
                    pwRow.add_child(go);
                    ov.body.add_child(pwRow);
                    entry.clutter_text.grab_key_focus();
                    this._grabKeyboard(entry.clutter_text);
                }
            }
        };

        // Give NM a moment to populate scan results, then refresh periodically.
        refresh();
        ov.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            if (this._scanOverlay !== ov) return GLib.SOURCE_REMOVE;
            this._system.requestWifiScan(() => {});
            refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Re-render the Tray tab after a short delay, so NetworkManager state
    // (WiFi enable, hotspot activation) has time to settle before we read it
    // back. Coalesces multiple calls into one pending timeout.
    // After a Wi-Fi / Bluetooth action, refresh the Tray cards once
    // NetworkManager / BlueZ have had a moment to settle. Only the cards are
    // rebuilt (the scan overlay floats above them and survives).
    _scheduleTrayReRender() {
        if (this._destroyed) return;
        if (this._trayReRenderId)
            GLib.Source.remove(this._trayReRenderId);
        this._trayReRenderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._trayReRenderId = 0;
            this._queueTrayCardsRefresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Build the mirrored status-area row, or null if there's nothing to show.
    // Reads Main.panel.statusArea, skips our own indicator and anything hidden
    // or icon-less, and turns each remaining indicator into a button that opens
    // that indicator's real PopupMenu anchored under the button.
    _buildTrayMirror() {
        let statusArea = Main.panel?.statusArea;
        if (!statusArea) return null;

        // One strip: "TOP BAR" then the icons, wrapping only when there are
        // more than fit on a line.
        let card = new St.BoxLayout({ style_class: 'nook-tray-mirror nn-cc-mirror', vertical: false, x_expand: true });
        let mirrorLabel = new St.Label({ text: 'TOP BAR', style_class: 'nook-card-eyebrow nn-cc-mirror-label',
            y_align: Clutter.ActorAlign.CENTER });
        mirrorLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        card.add_child(mirrorLabel);
        const PER_ROW = 11;
        let iconRow = new St.BoxLayout({ style_class: 'nook-tray-mirror-grid', vertical: true, x_expand: true });
        let addIcon = btn => {
            let line = iconRow.get_last_child();
            if (!line || line.get_n_children() >= PER_ROW) {
                line = new St.BoxLayout({ style_class: 'nook-tray-mirror-row', x_align: Clutter.ActorAlign.START });
                iconRow.add_child(line);
            }
            line.add_child(btn);
        };

        // Every indicator we *can* mirror is collected here as { id, label }
        // (whether or not the user has it enabled) so we can publish the catalog
        // to the prefs picker afterwards. `shown` counts only the ones actually
        // rendered into the row.
        let catalog = [];
        let shown = 0;
        for (let name in statusArea) {
            if (!Object.prototype.hasOwnProperty.call(statusArea, name)) continue;
            let indicator = statusArea[name];
            // Skip our own hidden date menu and anything not currently visible
            // in the panel (extensions hide their indicator when they've nothing
            // to show). `dateMenu` is force-hidden by us, so it'd never qualify.
            if (!indicator || indicator === this) continue;
            // The aggregate Quick Settings button is handled specially below: we
            // mirror each of ITS toggles individually (Caffeine, GSConnect, …)
            // rather than surfacing one button that pops the whole QS panel.
            if (indicator === statusArea.quickSettings) continue;
            let container = indicator.container ?? indicator;
            // Respect the indicator's own visibility (its container is what the
            // panel actually shows/hides).
            if (container && container.visible === false) continue;

            // This indicator is mirrorable — record it in the catalog, then skip
            // rendering if the user has toggled it off in settings.
            let id = this._trayMirrorId(indicator, name, false);
            catalog.push({ id, label: this._trayDisplayName(indicator, name) });
            if (!this._config.isTrayMirrorEnabled(id)) continue;

            // Find a representative icon: most PanelMenu.Buttons hold an St.Icon
            // (or a label) as their first child. We clone the gicon/icon-name so
            // reparenting never steals the real one out of the panel.
            let btn = this._mkTrayMirrorButton(indicator, name);
            if (!btn) continue;
            addIcon(btn);
            shown++;
        }

        // Quick Settings extensions (Caffeine, GSConnect, …) don't register a
        // top-level statusArea key — their SystemIndicators live inside the
        // aggregate quickSettings menu's _indicators box, each exposing a
        // QuickMenuToggle in `.quickSettingsItems`. Mirror those individually so
        // the notch can toggle them directly instead of opening the whole panel.
        shown += this._buildQuickSettingsMirror(statusArea.quickSettings, addIcon, catalog);

        // Publish the discovered catalog so the prefs window can offer a picker
        // for these (it runs in a separate process and can't read statusArea).
        this._config.publishTrayMirrorItems(catalog);

        if (!shown) {
            iconRow.add_child(new St.Label({ text: 'No indicators',
                style_class: 'nook-tray-mirror-empty', y_align: Clutter.ActorAlign.CENTER }));
        }
        // Let the icon row take the vertical space the card gains from
        // y_expand, keeping the icons centered in a taller TOP BAR.
        iconRow.y_expand = true;
        iconRow.y_align = Clutter.ActorAlign.CENTER;
        card.add_child(iconRow);
        return card;
    }

    // A stable id for a mirrorable indicator, used as the settings key + catalog
    // id. Top-level status-area indicators are keyed by their statusArea name
    // (stable across sessions). Quick Settings extension toggles have no
    // statusArea key, so they're keyed by their toggle/indicator class name
    // (e.g. 'CaffeineToggle', GSConnect's 'ServiceToggle') under a `qs:` prefix
    // to avoid colliding with a same-named status-area key.
    _trayMirrorId(indicator, name, isQuickSettings) {
        if (isQuickSettings) {
            let toggle = this._primaryQuickToggle(indicator);
            let cls = toggle?.constructor?.name ?? indicator?.constructor?.name ?? name;
            return 'qs:' + cls;
        }
        return 'sa:' + String(name);
    }

    // Mirror the Quick Settings *extension* toggles (Caffeine, GSConnect, …) as
    // individual buttons via `addIcon`. Returns how many were added.
    //
    // These live in `quickSettings._indicators` as SystemIndicator actors, each
    // with a `.quickSettingsItems` array of QuickMenuToggles and (usually) a
    // panel icon added via `_addIndicator()`. The same box also holds all the
    // built-in GNOME toggles (network, bluetooth, volume, night light, power
    // mode, …) — those already have first-class treatment in the shell and would
    // just clutter the row with duplicates, so we skip them by their well-known
    // Shell toggle class names and only surface third-party extension toggles.
    _buildQuickSettingsMirror(quickSettings, addIcon, catalog) {
        let box = quickSettings?._indicators;
        let children = box?.get_children?.() ?? [];
        let added = 0;
        for (let ind of children) {
            if (!ind || ind === this) continue;
            let items = ind.quickSettingsItems;
            if (!items || !items.length) continue;
            // Skip built-in GNOME QS indicators/toggles — keep only extensions.
            if (this._isBuiltinQuickSettings(ind)) continue;
            // Must expose a panel icon to be worth mirroring (that's how an
            // extension signals it has a status to surface). We deliberately do
            // NOT gate on `ind.visible`: an extension like Caffeine hides its
            // panel icon while idle, but we still want to offer its toggle so the
            // user can turn it ON from the notch.
            if (!this._findFirstIcon(ind)) continue;
            let clsName = ind.constructor?.name ?? 'qs';
            // Record in the catalog, then honour the user's per-indicator toggle.
            let id = this._trayMirrorId(ind, clsName, true);
            if (catalog)
                catalog.push({ id, label: this._trayDisplayName(ind, clsName) });
            if (!this._config.isTrayMirrorEnabled(id)) continue;
            let btn = this._mkTrayMirrorButton(ind, clsName);
            if (!btn) continue;
            addIcon(btn);
            added++;
        }
        return added;
    }

    // True for GNOME's own Quick Settings indicators/toggles, which we don't
    // mirror (they're duplicated shell chrome, not third-party extensions).
    // Matched by the Shell-internal class names of the indicator and its first
    // toggle — extension toggles use their own bespoke class names instead.
    _isBuiltinQuickSettings(indicator) {
        const BUILTIN = new Set([
            // stream sliders + the system row (battery/settings/lock/power)
            'OutputStreamSlider', 'InputStreamSlider', 'StreamSlider', 'SystemItem',
            // network
            'NMWiredToggle', 'NMWirelessToggle', 'NMModemToggle', 'NMVpnToggle',
            'NMBluetoothToggle', 'NMWireguardToggle',
            // radios / power / a11y / display
            'BluetoothToggle', 'RfkillToggle', 'PowerProfilesToggle',
            'NightLightToggle', 'DarkModeToggle', 'DoNotDisturbToggle',
            'RotationToggle', 'KeyboardBrightnessToggle', 'BacklightToggle',
            'A11yToggle', 'InputStreamSlider', 'AutoRotateToggle',
            'RemoteAccessApplet', 'UnsafeModeIndicator', 'ScreenshotToggle',
        ]);
        // indicator class (some builtins are anonymous `Indicator`, so also
        // check the first toggle's class, which is always the specific type).
        let indName = indicator?.constructor?.name;
        if (indName && BUILTIN.has(indName)) return true;
        let t = this._primaryQuickToggle(indicator);
        let tName = t?.constructor?.name;
        if (tName && BUILTIN.has(tName)) return true;
        return false;
    }

    // Build one mirror button for a status-area indicator. Returns null if we
    // can't derive any visual for it. Clicking opens the indicator's own menu
    // re-anchored under our button (falls back to a plain toggle if that fails).
    _mkTrayMirrorButton(indicator, name) {
        let btn = new St.Button({ style_class: 'nook-tray-mirror-btn', reactive: true, can_focus: true });

        // Derive a symbolic icon from the indicator's first icon child, cloning
        // by gicon/icon-name so we never remove the real actor from the panel.
        let visual = null;
        let firstIcon = this._findFirstIcon(indicator.container ?? indicator);
        if (firstIcon) {
            let clone = new St.Icon({ style_class: 'nook-tray-mirror-icon', icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER });
            if (firstIcon.gicon) clone.gicon = firstIcon.gicon;
            else if (firstIcon.icon_name) clone.icon_name = firstIcon.icon_name;
            else clone.icon_name = 'application-x-executable-symbolic';
            visual = clone;
        } else {
            // No icon (e.g. a text-only indicator) — fall back to a short label
            // from the indicator's accessible/role name.
            visual = new St.Label({ text: this._trayLabel(name),
                style_class: 'nook-tray-mirror-text', y_align: Clutter.ActorAlign.CENTER });
        }
        btn.set_child(visual);

        // The icons alone don't say which extension is which (Caffeine's cup,
        // etc.), so attach a hover tooltip with a human-readable name.
        this._attachTrayTooltip(btn, this._trayDisplayName(indicator, name));

        // Clicking triggers the indicator's primary action. For old-style
        // PanelMenu indicators that's opening their .menu under our button;
        // for Quick Settings extensions (Caffeine, GSConnect) it's activating
        // their toggle directly. _activateTrayItem picks the right path.
        btn.connect('clicked', () => this._activateTrayItem(indicator, btn));
        return btn;
    }

    // Route a mirror-button click to the indicator's primary action.
    //
    // Modern extensions (Caffeine, GSConnect on GNOME 43+) are Quick Settings
    // SystemIndicators: they have NO `.menu` on the indicator itself. Their real
    // control is a QuickMenuToggle in `indicator.quickSettingsItems`, and the
    // extension wires that toggle's 'clicked' signal to its action (Caffeine's
    // inhibitor toggle, GSConnect's service toggle). So the "open the menu"
    // path can't reach them — clicking it used to fall through to toggling the
    // whole aggregate Quick Settings panel. Instead, emit 'clicked' on the
    // toggle, exactly as clicking the real Quick Settings tile would.
    //
    // Old-style PanelMenu.Button indicators (with a real `.menu`) keep the
    // existing behaviour: open that menu re-anchored under the notch.
    _activateTrayItem(indicator, sourceBtn) {
        let toggle = this._primaryQuickToggle(indicator);
        if (toggle) {
            // A QuickMenuToggle's own submenu (GSConnect's device list, Caffeine's
            // timer options) is a QuickToggleMenu — which, unlike an old-style
            // PanelMenu.Button menu, has NO boxpointer and is designed to expand
            // *inside* the Quick Settings panel grid. It can't be re-anchored to
            // pop up under the notch. Emitting 'clicked' to open it (the previous
            // behaviour) therefore popped GSConnect's menu open at the top-left,
            // over the system-menu area — the reported bug.
            //
            // Since we can't relocate that submenu, a mirror-button click performs
            // the toggle's PRIMARY on/off action instead. For `toggleMode` toggles
            // (GSConnect's service, Caffeine's inhibitor) we flip `checked`
            // directly — the same bound action a user click runs, but without the
            // menu side effect. Non-toggleMode QuickToggles have no bound state to
            // flip, so we emit 'clicked' for them as before.
            try {
                if (toggle.toggleMode === true && typeof toggle.checked === 'boolean')
                    toggle.checked = !toggle.checked;
                else
                    toggle.emit('clicked', Clutter.BUTTON_PRIMARY);
                // The mirrored icon is a static clone taken at render time, and
                // the extension may swap its indicator gicon to reflect the new
                // state (Caffeine's full/empty cup, GSConnect's on/off). Re-render
                // the tab shortly after so the notch tile updates. The dashboard
                // stays open so the user sees the toggle take effect. State flips
                // can be async (D-Bus), so give it a beat before re-cloning.
                if (this._trayToggleRefreshId)
                    GLib.Source.remove(this._trayToggleRefreshId);
                this._trayToggleRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._trayToggleRefreshId = 0;
                    if (this.isExpanded && this._activeTab === 'system')
                        this._renderActiveTab();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            } catch (e) {
                logError('failed to activate quick-settings toggle', e);
                // fall through to the menu path below
            }
        }
        this._openMirroredMenu(indicator, sourceBtn);
    }

    // Return the QuickMenuToggle that represents this indicator's primary
    // action, or null if it's not a Quick Settings indicator. We take the first
    // toggle that carries a 'clicked' handler (the primary tile); its .menu, if
    // any, is the secondary submenu we deliberately don't open here.
    _primaryQuickToggle(indicator) {
        let items = indicator?.quickSettingsItems;
        if (!items || !items.length) return null;
        // Prefer a real QuickMenuToggle/QuickToggle (has an emittable 'clicked'
        // signal). Guard everything: some items are plain menu sections.
        for (let it of items) {
            if (it && typeof it.emit === 'function' && typeof it.connect === 'function')
                return it;
        }
        return null;
    }

    // Best human-readable name for an indicator, for its hover tooltip. Prefers
    // the indicator's accessible name (extensions set this, e.g. "Caffeine"),
    // then a title/accessible-name on its first icon, then a de-camel-cased
    // version of the status-area key ("nightLight" -> "Night Light").
    _trayDisplayName(indicator, name) {
        let candidates = [];
        try { candidates.push(indicator?.get_accessible?.()?.get_name?.()); } catch (e) {}
        try { candidates.push((indicator.container ?? indicator)?.accessible_name); } catch (e) {}
        // Quick Settings toggles carry their own display title (Caffeine's
        // "Caffeine", GSConnect's "GSConnect") — a reliable name for QS mirrors.
        try {
            let t = this._primaryQuickToggle(indicator);
            if (t?.title) candidates.push(t.title);
        } catch (e) {}
        for (let c of candidates) {
            if (c && String(c).trim() && String(c).toLowerCase() !== 'panel')
                return String(c).trim();
        }
        // Fall back to a prettified status-area key.
        let s = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
        s = s.replace(/\bmenu\b/i, '').trim();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // Attach a lightweight hover tooltip to a tray-mirror button. The tooltip is
    // a floating label parented to the shell's uiGroup (so it draws above the
    // dashboard), shown after a short hover delay and hidden on leave/destroy.
    // `shouldShow()` (optional) can veto the tooltip, e.g. for the active tab
    // whose label is already visible.
    _attachTrayTooltip(btn, text, shouldShow = null) {
        if (!text) return;
        btn.track_hover = true;
        let tip = null;
        let showId = 0;

        let hide = () => {
            if (showId) { GLib.Source.remove(showId); showId = 0; }
            if (tip) { tip.destroy(); tip = null; }
        };
        let show = () => {
            if (tip) return;
            tip = new St.Label({ text, style_class: 'nook-tray-tooltip' });
            tip.opacity = 0;
            Main.layoutManager.uiGroup.add_child(tip);
            // Center the tooltip under the button.
            let [bx, by] = btn.get_transformed_position();
            let tw = tip.get_preferred_width(-1)[1];
            tip.set_position(
                Math.round(bx + (btn.width - tw) / 2),
                Math.round(by + btn.height + 6));
            tip.ease({ opacity: 255, duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        };

        btn.connect('notify::hover', () => {
            if (btn.hover && (!shouldShow || shouldShow())) {
                if (!showId && !tip)
                    showId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                        showId = 0; show(); return GLib.SOURCE_REMOVE;
                    });
            } else {
                hide();
            }
        });
        // Clean up if the button (i.e. the whole tray card) is torn down.
        btn.connect('destroy', hide);
    }

    // Depth-first search for the first St.Icon under an actor (the panel button's
    // representative icon). Returns null if none.
    _findFirstIcon(actor) {
        if (!actor) return null;
        if (actor instanceof St.Icon) return actor;
        let kids = actor.get_children ? actor.get_children() : [];
        for (let k of kids) {
            let found = this._findFirstIcon(k);
            if (found) return found;
        }
        return null;
    }

    // A short human label for an indicator that has no icon, from its status-area
    // key ("aggregateMenu" -> "Menu", "keyboard" -> "Keyboard").
    _trayLabel(name) {
        let s = String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
        s = s.charAt(0).toUpperCase() + s.slice(1);
        // Keep it short so the row stays tidy.
        return s.length > 10 ? s.slice(0, 9) + '…' : s;
    }

    // Open a mirrored indicator's real PopupMenu anchored under `sourceBtn`.
    // Retargets the menu's boxpointer to our button for the duration so it pops
    // up by the notch instead of at the (often hidden) panel. Falls back to the
    // indicator's default menu.toggle() if retargeting isn't possible.
    _openMirroredMenu(indicator, sourceBtn) {
        let menu = indicator?.menu;
        if (!menu) return;
        try {
            // Retarget the boxpointer + sourceActor to our button so the menu
            // appears under the notch. We restore them after the menu closes so
            // the real panel indicator keeps working normally.
            let bp = menu._boxPointer;
            let prevSource = menu.sourceActor;
            let prevBpSource = bp?._sourceActor;
            if (bp && sourceBtn) {
                menu.sourceActor = sourceBtn;
                bp._sourceActor = sourceBtn;
                // Point the arrow up toward the notch.
                if (bp.setPosition) {
                    try { bp.setPosition(sourceBtn, 0.5); } catch (e) {}
                }
            }
            // Collapse the dashboard first so the menu isn't drawn behind it.
            this._collapseImmediately();
            menu.open(BoxPointer.PopupAnimation.FULL);
            // Restore the original anchoring once the menu closes so we don't
            // permanently hijack the panel indicator's own placement.
            let closeId = menu.connect('open-state-changed', (m, isOpen) => {
                if (isOpen) return;
                menu.sourceActor = prevSource;
                if (bp) bp._sourceActor = prevBpSource;
                menu.disconnect(closeId);
            });
        } catch (e) {
            logError(`failed to open mirrored menu for tray item.`, e);
            try { menu.toggle(); } catch (e2) {}
        }
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
            text: fmt(now, { hour: 'numeric', minute: '2-digit' }),
            style_class: 'nook-clock-digital' }));
        clockCol.add_child(new St.Label({
            text: fmt(now, { weekday: 'short', month: 'short', day: 'numeric' }),
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

        // Next hours: the forecast was always fetched but never shown.
        if (w.hourly?.length) {
            let strip = new St.BoxLayout({ style_class: 'nook-wx-hourly', x_expand: true });
            for (let [i, h] of w.hourly.entries()) {
                let col = new St.BoxLayout({ style_class: 'nook-wx-hour' + (i === 0 ? ' nook-wx-hour-now' : ''),
                    vertical: true, x_expand: true });
                if (i === 0)
                    col.set_style(`background-color: rgba(${accentRgbStr()}, 0.14); border-color: rgba(${accentRgbStr()}, 0.32);`);
                col.add_child(new St.Label({ text: h.label, style_class: 'nook-wx-hour-label', x_align: Clutter.ActorAlign.CENTER }));
                col.add_child(new St.Icon({ icon_name: h.icon, icon_size: 18, style_class: 'nook-wx-hour-icon', x_align: Clutter.ActorAlign.CENTER }));
                col.add_child(new St.Label({ text: h.temp, style_class: 'nook-wx-hour-temp', x_align: Clutter.ActorAlign.CENTER }));
                strip.add_child(col);
            }
            panel.add_child(strip);
        }
        if (w.stale)
            panel.add_child(new St.Label({ text: 'Offline — showing the last forecast', style_class: 'nook-card-meta' }));

        this._mount(panel);
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
            this._mount(panel);
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
        this._mount(panel);

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
            text: fmt(selected, { weekday: 'long' }),
            style_class: 'nook-calendar-summary-day'
        });
        text.add_child(this._calSummaryDay);
        this._calSummaryDate = new St.Label({
            text: fmt(selected, { month: 'long', day: 'numeric', year: 'numeric' }),
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

        this._mount(panel);
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
                this._system.setPrivacyPolling(on);
                this._updatePrivacyIndicators();
                break;
            case 'pillMarquee':
                // Re-run the live refresh so the marquee starts/stops.
                this._refreshLive();
                break;
            case 'showPowerButton':
                if (this._moreButton)
                    this._buildMoreMenu();
                break;
            case 'hidePanel':
                this._applyPanelVisibility();
                break;
            case 'reclaimSpace':
                this._applyPanelVisibility();
                break;
            case 'mirrorTray':
                // The mirror lives in the Tray tab.
                if (this._invalidateTab('system'))
                    this._renderActiveTab();
                break;
            case 'topScroll':
                this._applyTopScroll();
                break;
            default:
                this._onLedgeFeatureToggled(id, on);
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
                this._onCalendarEventsChanged();
            };
            let onRemoved = (connection, sender, path, iface, signal, params) => {
                let ids = params.deep_unpack()?.[0] ?? [];
                for (let id of ids)
                    this._calendarServerEvents.delete(id);
                this._onCalendarEventsChanged();
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
            logError('Failed to initialize calendar server.', e);
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
                        logError('Failed to request calendar range.', e);
                    }
                });
        } catch (e) {
            logError('Failed to request calendar range.', e);
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
            logError('Failed to parse calendar server event.', e);
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

            pill.weekday.set_text(fmt(date, { weekday: 'narrow' }).toUpperCase());
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
            this._calSummaryDay.set_text(fmt(selected, { weekday: 'long' }));
        if (this._calSummaryDate)
            this._calSummaryDate.set_text(fmt(selected, { month: 'long', day: 'numeric', year: 'numeric' }));
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
            if (this._activeTab !== 'calendar')
                return GLib.SOURCE_REMOVE;
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
            logError('Failed to open GNOME Settings.', e);
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
            text: fmt(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' }),
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
        // Events come from our own CalendarServer subscription. (Reading the
        // shell's dateMenu event source as well was a duplicate of the same
        // data, and its requestRange() makes the shell re-render its hidden
        // calendar synchronously — 17–35 ms per call, on every render.)
        let out = Array.from(this._calendarServerEvents.values());

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
                    fmt(ev.start, { weekday: 'short', month: 'short', day: 'numeric' });
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
        return fmt(date, { hour: 'numeric', minute: '2-digit' });
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

        this._mount(panel);
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
        if (this._destroyed) return;
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
            logError('notification watch init failed', e);
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
                // Fall through to the real banner when we shouldn't suppress —
                // and always for critical alerts (low battery, etc.), which
                // must get the shell's own sticky banner.
                let next = this._notificationQueue?.[0];
                if (!self._shouldSuppressShellBanner() ||
                    next?.urgency === MessageTray.Urgency.CRITICAL) {
                    return self._origShowNotification.apply(this, args);
                }
                // Suppress: the pill peek (driven by `notification-added`) is
                // showing this notification instead. Take it off the queue and
                // finish the show cycle right away — state back to HIDDEN, as
                // GNOME does after a banner hides. (Marking it SHOWN without a
                // banner, as this used to, left the tray waiting forever for a
                // banner that never expired: every later shell banner,
                // including critical ones, was stuck behind it.)
                try {
                    this._notificationQueue.shift();
                    this._notification = null;
                    this._notificationState = MessageTray.State.HIDDEN;
                    this.emit('queue-changed');
                    // _updateState() is mid-run (re-entrancy guarded): let the
                    // rest of the queue flow on the next idle.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._updateState();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (e) {
                    // If our short-circuit ever fails, don't wedge the tray —
                    // fall back to the real implementation.
                    return self._origShowNotification.apply(this, args);
                }
            };
        } catch (e) {
            logError('banner suppression install failed', e);
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
            // If the user has DND on, we don't peek — and we also shouldn't eat
            // the shell's banner (which respects DND itself). Return false so the
            // real path runs and honours DND.
            if (!this._notificationSettings().get_boolean('show-banners')) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    // A notification that is shown once and not kept in the history — used for
    // secrets like the hotspot password. Falls back to Main.notify on shells
    // without the GNOME 46+ notification constructor.
    _notifyTransient(title, body) {
        try {
            let source = MessageTray.getSystemSource();
            let n = new MessageTray.Notification({ source, title, body, isTransient: true });
            source.addNotification(n);
        } catch (e) {
            Main.notify(title, body);
        }
    }

    // org.gnome.desktop.notifications, created once (show-banners = DND off).
    _notificationSettings() {
        this._dndSettings ??= Gio.Settings.new('org.gnome.desktop.notifications');
        return this._dndSettings;
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
            if (!this._notificationSettings().get_boolean('show-banners')) return;
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
            logError('notification peek error', e);
        }
    }

    // Morph pill → banner and start the auto-dismiss countdown. If a peek is
    // already showing, just swap its content and restart the timer (so a burst
    // of notifications keeps the banner up and current rather than flickering).
    _showNotificationPeek(title, body, gicon, notification = null, actions = []) {
        if (this._destroyed) return;
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

        if (!this._peekActive) {
            this._suspendAlert();
            this._untuckForExpand();
        }
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
        this._notifBanner.translation_y = -8;
        this._notifBanner.visible = true;

        let targetHeight = this._measurePeekHeight();
        let targetX = monitor.x + Math.floor((monitor.width - PEEK_WIDTH) / 2);

        this._surface.ease({
            scale_x: 1.0, scale_y: 1.0, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        // Pill stays put — only the banner fades and slides in beneath it.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;
        this._notifBanner.ease({
            opacity: 255, translation_y: 0,
            delay: 60, duration: PEEK_ENTER_MS, mode: Clutter.AnimationMode.EASE_OUT_QUINT });
        springTo(this, { x: targetX, y: monitor.y, width: PEEK_WIDTH, height: targetHeight },
            { duration: 520, damping: 0.78 });

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
        springTo(this, { x: targetX, width: PEEK_WIDTH, height: targetHeight },
            { duration: 360, damping: 0.9 });
    }

    // Collapse the banner back to the pill. `immediate` skips the timer clear
    // path used when a click is handing off to the full expand.
    _hideNotificationPeek(immediate = false) {
        if (!this._peekActive) return;
        this._peekActive = false;
        // The shell expires transient notifications when their banner hides;
        // the peek replaced that banner, so do the same here.
        let shown = this._peekNotification;
        if (shown?.isTransient && !immediate) {
            try { shown.destroy(MessageTray.NotificationDestroyedReason.EXPIRED); } catch (e) {}
        }
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

        // Pill stayed visible the whole peek — nothing to fade in, just keep it
        // opaque while the banner shrinks away beneath it.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.remove_all_transitions();
        this._surface.scale_x = 1.0;
        this._surface.scale_y = 1.0;

        this._notifBanner.ease({
            opacity: 0, translation_y: -6, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._notifBanner.visible = false;
                this._notifBanner.translation_y = 0;
                this._surface.remove_style_class_name('notchnux-island-peek');
            } });
        springTo(this, this._restGeometry(), { duration: 400, damping: 1 });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 360, () => {
            if (!this._destroyed && !this._peekActive && !this.isExpanded) {
                this._promoteAlert();
                this._updateTuck();
            }
            return GLib.SOURCE_REMOVE;
        });
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

        // Paired GSConnect devices: render from the last snapshot and refresh
        // it asynchronously, so a slow GSConnect never stalls the render. A
        // changed snapshot re-renders the tab once.
        let devices = this._shareDevices;
        this._refreshShareDevices();

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

        this._mount(panel);
    }

    _refreshShareDevices() {
        if (this._shareRefreshing)
            return;
        this._shareRefreshing = true;
        this._shelf.getShareDevicesAsync(({ available, devices }) => {
            this._shareRefreshing = false;
            let sig = JSON.stringify([available, devices.map(d => `${d.path}|${d.name}`)]);
            let changed = sig !== this._shareSig;
            this._shareSig = sig;
            this._shareDevices = devices;
            this._shareAvailable = available;
            if (changed && this.isExpanded && this._activeTab === 'shelf')
                this._renderActiveTab();
        });
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
        let title = new St.Label({ text: 'Drop files here',
            style_class: 'nook-shelf-drop-title', x_align: Clutter.ActorAlign.CENTER });
        inner.add_child(title);
        inner.add_child(new St.Label({ text: 'Drag from Files · click to browse · or paste',
            style_class: 'nook-shelf-drop-sub', x_align: Clutter.ActorAlign.CENTER }));
        this._shelfDropZone = { zone, title };
        zone.connect('destroy', () => {
            if (this._shelfDropZone?.zone === zone)
                this._shelfDropZone = null;
        });

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
        this._syncDropZoneState();
        zone.connect('clicked', () => {
            this._shelf.pickFilesIntoShelf((added) => {
                if (added > 0 && this._activeTab === 'shelf')
                    this._renderActiveTab();
            });
        });
        return zone;
    }

    // ------------------------------------------------------------ file drag & drop
    // See helpers/filedrop.js for why this needs a helper window on Wayland.
    _initFileDrop() {
        try {
            this._fileDrop = new FileDropBridge({
                hitTest: (x, y) => this._fileDragHits(x, y),
                onArm: () => this._onFileDragArm(),
                targetRect: () => this._fileDropRect(),
                setPassThrough: on => this._setDropPassThrough(on),
                onOver: inside => this._setDropHover(inside),
                onFiles: uris => this._onFilesDropped(uris),
                onDragEnd: dropped => this._onFileDragEnd(dropped),
            });
        } catch (e) {
            logError('file drag & drop unavailable', e);
            this._fileDrop = null;
        }
    }

    // A drag "reaches" the notch when it comes within a short distance of its
    // current box (the pill, or the open dashboard).
    _fileDragHits(x, y) {
        if (this._destroyed || !this._tabs.shelf || !this.mapped || Main.overview.visible)
            return false;
        const MARGIN = 28;
        let [ax, ay] = this.get_transformed_position();
        let w = this.get_width();
        let h = this.get_height();
        return x >= ax - MARGIN && x <= ax + w + MARGIN &&
               y >= ay - MARGIN && y <= ay + h + MARGIN;
    }

    _onFileDragArm() {
        this._dropHold = true;
        this._dropUi = { armed: true, over: false };
        this._clearHoverTimers();
        if (this._activeTab !== 'shelf')
            this._switchTab('shelf');
        if (!this.isExpanded) {
            this._untuckForExpand();
            this.expand();
        }
        this._syncDropZoneState();
    }

    // Where the open dashboard will sit once its spring settles.
    _fileDropRect() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
        let height = this.isExpanded ? this._measureDashboardHeight() : this.get_height();
        return {
            x: monitor.x + Math.floor((monitor.width - DASHBOARD_WIDTH) / 2),
            y: monitor.y,
            width: DASHBOARD_WIDTH,
            height: Math.max(height, PILL_HEIGHT),
        };
    }

    _setDropPassThrough(on) {
        if (this._destroyed || on === !!this._dropPassThrough)
            return;
        this._dropPassThrough = on;
        this._walkDropPassThrough(on);
    }

    // Toggle reactivity of our whole subtree. Actors we switched off are
    // marked, so restoring touches only those still alive in the tree.
    _walkDropPassThrough(off) {
        let stack = [this];
        while (stack.length) {
            let a = stack.pop();
            if (off) {
                if (a.reactive) {
                    a._nnDropRestore = true;
                    a.reactive = false;
                }
            } else if (a._nnDropRestore) {
                delete a._nnDropRestore;
                a.reactive = true;
            }
            for (let c of a.get_children())
                stack.push(c);
        }
    }

    _setDropHover(inside) {
        if (!this._dropUi)
            return;
        this._dropUi.over = inside;
        this._syncDropZoneState();
    }

    _syncDropZoneState() {
        let dz = this._shelfDropZone;
        if (!dz)
            return;
        let armed = !!this._dropUi?.armed;
        let over = armed && !!this._dropUi?.over;
        dz.zone[armed ? 'add_style_class_name' : 'remove_style_class_name']('nook-shelf-drop-armed');
        dz.zone[over ? 'add_style_class_name' : 'remove_style_class_name']('nook-shelf-drop-over');
        dz.zone.set_style(armed ? `border-color: ${accentHex()};` : null);
        dz.title.text = over ? 'Release to add' : 'Drop files here';
    }

    _onFilesDropped(uris) {
        this._shelf.addFilesAsync(uris, added => {
            if (this._destroyed)
                return;
            if (added > 0 && this.isExpanded && this._activeTab === 'shelf')
                this._renderActiveTab();
            if (added > 0)
                this._flashShareStatus(added === 1 ? 'Added 1 file' : `Added ${added} files`);
            else
                this._flashShareStatus('Only local files can be added');
        });
    }

    _onFileDragEnd(dropped) {
        this._dropHold = false;
        this._dropUi = null;
        this._syncDropZoneState();
        if (!this.isExpanded)
            return;
        this._pointerInside = this._pointerIsOverWidget();
        if (this._pointerInside || this._collapseTimeoutId)
            return;
        // Linger a little after a drop so the new file is seen landing.
        this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, dropped ? 1600 : 400, () => {
            this._collapseTimeoutId = null;
            if (!this._pointerInside && this.isExpanded && !this._anyOwnedMenuOpen() && !this._dropHold && !this._kbGrab)
                this.collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    // One file row: icon + name/size, then Send / Copy / Open / Reveal / Remove.
    _buildShelfRow(f, devices) {
        let row = new St.BoxLayout({ style_class: 'nook-shelf-row', vertical: false, x_expand: true });
        let rowIcon = new St.Icon({ icon_size: 20, style_class: 'nook-shelf-row-icon', y_align: Clutter.ActorAlign.CENTER });
        if (f.gicon) rowIcon.gicon = f.gicon;
        else rowIcon.icon_name = 'text-x-generic-symbolic';
        row.add_child(rowIcon);

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
        let serviceAvailable = this._shareAvailable;
        if (devices.length === 1)
            hintText = devices[0].name;
        else if (devices.length > 1)
            hintText = `${devices.length} devices`;
        else
            hintText = serviceAvailable ? 'No device connected' : 'GSConnect not running';
        let hint = new St.Label({ text: hintText, style_class: 'nook-share-devlabel', y_align: Clutter.ActorAlign.CENTER });
        head.add_child(hint);
        box.add_child(head);

        // Subline: how to get a device when there isn't one.
        if (devices.length === 0) {
            let sub = new St.Label({
                text: serviceAvailable
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
    // Tab: Wallpaper — a visual switcher over the folder configured in prefs.
    // GNOME/Wayland only draws still images behind the desktop, so this rotates
    // JPG/PNG/WebP/etc. The rotation timer, folder, interval, order and
    // auto-pause all live in the prefs window (see _addWallpaperGroup); this tab
    // is purely the picker: scroll the strip (or click a thumbnail) to switch,
    // and whichever image you land on becomes current and restarts the timer.
    // ============================================================
    _renderWallpaperTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-wp-panel', vertical: true, x_expand: true, y_expand: true });

        let wpCfg = this._config.wallpaper;
        let items = this._wallpaper.getWallpapers();

        // Header: title + current filename. Rotation is configured from the
        // dashboard's own settings gear (this tab is purely the picker), so we
        // deliberately don't repeat a settings shortcut here.
        let header = new St.BoxLayout({ style_class: 'nook-wp-header', vertical: false, x_expand: true });
        let titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        titleBox.add_child(new St.Label({ text: 'Wallpaper', style_class: 'nook-wp-title' }));
        let currentItem = items.find(w => w.current);
        this._wpSubtitle = new St.Label({
            text: currentItem ? currentItem.name
                : (items.length ? 'Scroll to pick a wallpaper' : ''),
            style_class: 'nook-wp-subtitle',
        });
        titleBox.add_child(this._wpSubtitle);
        header.add_child(titleBox);
        panel.add_child(header);

        // Empty states: no folder configured, or a folder with no images.
        if (!wpCfg.folder) {
            panel.add_child(this._buildWallpaperEmpty(
                'preferences-desktop-wallpaper-symbolic',
                'No wallpaper folder set',
                'Choose a folder in settings to rotate through your images.'));
            this._mount(panel);
            return;
        }
        if (items.length === 0) {
            panel.add_child(this._buildWallpaperEmpty(
                'image-missing-symbolic',
                'No images in this folder',
                'Add JPG, PNG or WebP images to the folder you picked.'));
            this._mount(panel);
            return;
        }

        // Slit deck: every image is a slanted slit, the current one opens out
        // full width and the row slides to keep it centred (see slitdeck.js).
        // Scrolling moves the selection right away; the wallpaper itself is
        // applied once you stop, so the desktop reveal plays once per landing.
        let activeIdx = Math.max(0, items.findIndex(w => w.current));
        this._wpItems = items;
        this._wpActivePath = currentItem ? currentItem.path : null;
        let deck = new SlitDeck({
            items,
            activeIndex: activeIdx,
            thumbFor: it => this._wallpaper.thumbFor(it),
            accent: accentHex(),
            onPick: idx => this._selectWallpaper(idx, { applyNow: true }),
        });
        this._wpDeck = deck;
        this._wpCounter = new St.Label({ style_class: 'nook-wp-counter', y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._wpCounter);
        this._updateWallpaperCounter(activeIdx);

        // Thumbnails come from an on-disk cache; missing ones are generated
        // by the out-of-process image worker and pop in as each batch lands.
        let missing = items.filter(it => !this._wallpaper.thumbFor(it));
        if (missing.length) {
            let alive = true;
            let indexOf = new Map(items.map((it, i) => [it.path, i]));
            deck.actor.connect('destroy', () => { alive = false; });
            this._wallpaper.requestThumbs(missing, (src, thumbPath) => {
                if (alive && indexOf.has(src))
                    deck.setThumb(indexOf.get(src), thumbPath);
            });
        }

        // Wheel = one step per notch (lightly throttled so a flick still
        // reads as discrete steps); trackpads accumulate smooth deltas.
        deck.actor.connect('scroll-event', (actor, event) => {
            let dir = event.get_scroll_direction();
            let step = 0;
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [dx, dy] = event.get_scroll_delta();
                this._wpSmoothAcc = (this._wpSmoothAcc || 0) + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
                if (Math.abs(this._wpSmoothAcc) >= 1.2) {
                    step = Math.sign(this._wpSmoothAcc);
                    this._wpSmoothAcc = 0;
                }
            } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
                step = -1;
            } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
                step = 1;
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
            if (step === 0)
                return Clutter.EVENT_STOP;
            let now = GLib.get_monotonic_time();
            if (dir !== Clutter.ScrollDirection.SMOOTH && now - (this._lastWpScrollAt || 0) < 70000)
                return Clutter.EVENT_STOP;
            this._lastWpScrollAt = now;
            this._stepWallpaper(step);
            return Clutter.EVENT_STOP;
        });

        panel.add_child(deck.actor);
        this._mount(panel);
    }

    _buildWallpaperEmpty(icon, title, sub) {
        let box = new St.BoxLayout({ style_class: 'nook-wp-empty', vertical: true, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        box.add_child(new St.Icon({ icon_name: icon, icon_size: 32, style_class: 'nook-wp-empty-icon', x_align: Clutter.ActorAlign.CENTER }));
        box.add_child(new St.Label({ text: title, style_class: 'nook-wp-empty-title', x_align: Clutter.ActorAlign.CENTER }));
        box.add_child(new St.Label({ text: sub, style_class: 'nook-wp-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
        return box;
    }

    // Move the selection by dir (±1), wrapping at the ends. The deck slides
    // at once; the desktop follows after a short pause (see below).
    _stepWallpaper(dir) {
        if (!this._wpDeck || !this._wpItems?.length)
            return;
        let n = this._wpItems.length;
        this._selectWallpaper((this._wpDeck.index + dir + n) % n);
    }

    // Select item `idx` in the deck. Wheel steps wait for 380 ms of quiet
    // before writing the wallpaper, so a fast scroll through ten images plays
    // one desktop reveal (and one gsettings write) instead of ten.
    _selectWallpaper(idx, { applyNow = false } = {}) {
        let item = this._wpItems?.[idx];
        if (!item || !this._wpDeck)
            return;
        this._wpDeck.slideTo(idx);
        this._wpSubtitle?.set_text(item.name);
        this._updateWallpaperCounter(idx);
        if (this._wpApplyId) {
            GLib.Source.remove(this._wpApplyId);
            this._wpApplyId = 0;
        }
        if (applyNow) {
            this._applyWallpaper(item.path);
            return;
        }
        this._wpApplyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 380, () => {
            this._wpApplyId = 0;
            this._applyWallpaper(item.path);
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateWallpaperCounter(idx) {
        this._wpCounter?.set_text(`${idx + 1} / ${this._wpItems?.length ?? 0}`);
    }

    _applyWallpaper(path) {
        if (this._wallpaper.setWallpaper(path))
            this._wpActivePath = path;
    }

    // ============================================================
    // Typing into the notch
    // ============================================================
    // Chrome actors never get key events on their own — the focused window
    // does. While one of our text fields has focus we take a modal grab on the
    // whole notch (so its buttons keep working) and hand focus straight back
    // to the field. The grab is released as soon as focus leaves our fields,
    // on Escape, on tab switch, collapse and teardown.
    _makeTypable(entry) {
        let text = entry.clutter_text;
        // Focus changes are followed on the stage's key-focus property (see
        // _onStageKeyFocus); ClutterText no longer emits key-focus-in/out.
        this._typables ??= new Set();
        this._typables.add(text);
        text.connect('destroy', () => this._typables?.delete(text));
        entry.connect('button-press-event', () => {
            text.grab_key_focus();
            this._grabKeyboard(text);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._releaseKeyboard();
            return Clutter.EVENT_STOP;
        });
    }

    // Key focus moved somewhere on the stage: grab when it lands in one of our
    // text fields, release once it has left them all.
    _onStageKeyFocus() {
        let focus = global.stage.get_key_focus();
        if (focus && this._typables?.has(focus))
            this._grabKeyboard(focus);
        else
            this._queueKeyboardRelease();
    }

    _grabKeyboard(focusTarget = null) {
        if (this._destroyed)
            return;
        if (!this._kbGrab) {
            this._grabbingKeyboard = true;
            try {
                this._kbGrab = Main.pushModal(this, { actionMode: Shell.ActionMode.POPUP });
            } catch (e) {
                logError('could not take keyboard focus', e);
                this._kbGrab = null;
            }
            this._grabbingKeyboard = false;
        }
        // pushModal moves key focus to the notch itself; give it back.
        if (focusTarget && global.stage.get_key_focus() !== focusTarget)
            focusTarget.grab_key_focus();
    }

    _queueKeyboardRelease() {
        if (!this._kbGrab || this._grabbingKeyboard || this._kbReleaseId)
            return;
        this._kbReleaseId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._kbReleaseId = 0;
            let focus = global.stage.get_key_focus();
            if (!focus || !this._typables?.has(focus))
                this._releaseKeyboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _releaseKeyboard() {
        if (this._kbReleaseId) {
            GLib.Source.remove(this._kbReleaseId);
            this._kbReleaseId = 0;
        }
        if (!this._kbGrab)
            return;
        let grab = this._kbGrab;
        this._kbGrab = null;
        try {
            Main.popModal(grab);
        } catch (e) {
            logError('failed to release keyboard', e);
        }
        global.stage.set_key_focus(null);
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

        // Tucked away: resting on the top-centre strip reveals the pill; a
        // click (or another hover once it's out) opens it.
        if (!this.isExpanded && this._tuckCrossing(entering))
            return Clutter.EVENT_PROPAGATE;

        // A gentle swell on hover says "this opens" before it does.
        if (!this.isExpanded && !this._peekActive && !this._tucked) {
            this._surface.set_pivot_point(0.5, 0.0);
            this._surface.ease({
                scale_x: entering ? 1.03 : 1.0, scale_y: entering ? 1.06 : 1.0,
                duration: entering ? 220 : 260,
                mode: entering ? Clutter.AnimationMode.EASE_OUT_QUINT : Clutter.AnimationMode.EASE_OUT_QUAD });
        }

        if (entering) {
            // Cancel any pending collapse and (if collapsed) schedule expand.
            if (this._collapseTimeoutId) {
                GLib.Source.remove(this._collapseTimeoutId);
                this._collapseTimeoutId = null;
            }
            if (!this.isExpanded && !this._expandTimeoutId) {
                this._expandTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                    this._expandTimeoutId = null;
                    if (this._pointerInside && !this.isExpanded && !this._anyOwnedMenuOpen())
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
            // Don't collapse while one of our popup menus is open — the pointer
            // has merely moved onto the menu (which lives in Main.uiGroup, not
            // our subtree, so it reads as "left"). The menu's own click handling
            // or a click-outside will close things.
            // Typing in one of our fields: only an outside click (or Escape)
            // closes the notch, never a stray pointer move.
            // Mid file-drag the notch stays open until the drag ends.
            if (this.isExpanded && !this._collapseTimeoutId && !this._anyOwnedMenuOpen() && !this._kbGrab && !this._dropHold) {
                this._collapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._collapseTimeoutId = null;
                    if (!this._pointerInside && this.isExpanded && !this._anyOwnedMenuOpen() && !this._dropHold)
                        this.collapse();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onClicked(event) {
        // While a text field holds the keyboard we have a modal grab, so every
        // click — even one over a window or the desktop — is delivered to us.
        // Sort those out first: outside our box closes the notch, inside but
        // off the field just drops focus.
        if (this._kbGrab && this._handleClickWhileTyping(event))
            return Clutter.EVENT_STOP;
        // Clicking the collapsed pill opens it. Clicks inside the expanded
        // dashboard are always left to propagate to their controls — the
        // dashboard never collapses from an internal click.
        if (event.get_button() === 3 &&
            (!this.isExpanded || this._isDescendantOf(global.stage.get_event_actor(event), this._compactStack))) {
            this._openPillMenu();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() === 1 && !this.isExpanded && !this._anyOwnedMenuOpen()) {
            this._untuckForExpand();
            this.expand();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onStageClicked(event) {
        if (!this.isExpanded) return Clutter.EVENT_PROPAGATE;
        if (this._kbGrab) {
            this._handleClickWhileTyping(event);
            return Clutter.EVENT_PROPAGATE;
        }
        // Only collapse for clicks that are genuinely outside us. Check both
        // the event source's ancestry AND the click coordinates against our
        // box — re-rendering a tab can destroy the clicked actor before this
        // handler runs, so the actor test alone is unreliable.
        let [ex, ey] = event.get_coords();
        let inside = this._clickInsideBox(event);
        // Our PopupMenus (Studio device pickers, the power menu) live in
        // Main.uiGroup, outside our box and not descendants of ours. Clicking one
        // of their items must NOT collapse the dashboard — treat a click in any
        // owned menu as "inside" so selection works.
        if (!inside && this._clickInOwnedMenu(global.stage.get_event_actor(event), ex, ey))
            inside = true;
        if (!inside && !this._isDescendant(global.stage.get_event_actor(event)))
            this._collapseImmediately();
        return Clutter.EVENT_PROPAGATE;
    }

    _clickInsideBox(event) {
        let [ex, ey] = event.get_coords();
        let [ax, ay] = this.get_transformed_position();
        return ex >= ax && ex <= ax + this.get_width() &&
               ey >= ay && ey <= ay + this.get_height();
    }

    // A click arrived while one of our fields holds the keyboard grab. The
    // grab reroutes outside clicks to us, so judge by coordinates, not by
    // the event actor. Returns true when the click was consumed (outside).
    _handleClickWhileTyping(event) {
        let [ex, ey] = event.get_coords();
        let source = global.stage.get_event_actor(event);
        if (!this._clickInsideBox(event) && !this._clickInOwnedMenu(source, ex, ey)) {
            this._releaseKeyboard();
            if (this.isExpanded)
                this._collapseImmediately();
            return true;
        }
        // Inside, but not on a text field: drop the field's focus so the
        // notch can close normally again (hover-out / outside click).
        let onField = false;
        for (let a = source; a && !onField; a = a.get_parent())
            onField = this._typables?.has(a) || this._typables?.has(a.clutter_text);
        if (!onField)
            this._releaseKeyboard();
        return false;
    }

    // All PopupMenus this widget owns and mounts in Main.uiGroup — the Studio
    // device pickers plus the header power menu. Used by the click-outside guard.
    _ownedMenus() {
        let menus = (this._studioMenus ?? []).slice();
        if (this._moreMenu)
            menus.push(this._moreMenu);
        if (this._pillMenu)
            menus.push(this._pillMenu);
        return menus;
    }

    // True if any owned popup menu is currently open. Used to suspend the
    // hover-out collapse while a menu is up.
    _anyOwnedMenuOpen() {
        return this._ownedMenus().some(m => m?.isOpen);
    }

    // True when a stage click at (source / ex,ey) landed in one of our owned
    // menus. We check BOTH the source's ancestry AND the click coordinates
    // against the menu actor's box, and deliberately do NOT gate on isOpen:
    // activating a menu item closes the menu (isOpen flips to false) before this
    // stage handler runs, so an isOpen check would wrongly treat the selecting
    // click as "outside" and collapse the dashboard.
    _clickInOwnedMenu(source, ex, ey) {
        for (let menu of this._ownedMenus()) {
            let actor = menu?.actor;
            if (!actor) continue;
            // Ancestry test.
            for (let a = source; a; a = a.get_parent()) {
                if (a === actor) return true;
            }
            // Geometry test — the menu still occupies its region during the
            // click even if it just closed. Only meaningful when mapped.
            if (actor.mapped && ex !== undefined) {
                let [mx, my] = actor.get_transformed_position();
                let mw = actor.get_width();
                let mh = actor.get_height();
                if (ex >= mx && ex <= mx + mw && ey >= my && ey <= my + mh)
                    return true;
            }
        }
        return false;
    }

    _collapseImmediately() {
        this._clearHoverTimers();
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
        this._suspendAlert();
        this._untuckForExpand();
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
            this._showActiveTab();
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

        this._dashboard.remove_all_transitions();
        this._dashboard.opacity = 0;
        this._dashboard.translation_y = -10;
        this._dashboard.visible = true;

        // Measure natural height of the active tab at dashboard width.
        let targetHeight = this._measureDashboardHeight();

        // Blur deepens alongside the unfold (no-op when blur is disabled).
        if (this._blurActive)
            this._animateBlurRadius(this._blurCfg.expandedRadius);

        // Settle any hover swell; the bloom itself is the size change.
        this._surface.ease({
            scale_x: 1.0, scale_y: 1.0, duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        // Pill stays pinned at the top; the dashboard fades in just behind
        // the box's growth so it never pokes outside the surface.
        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;
        this._dashboard.ease({
            opacity: 255, translation_y: 0,
            delay: 70, duration: 340, mode: Clutter.AnimationMode.EASE_OUT_QUINT });
        // One spring from wherever the box is now (pill, peek, or a collapse
        // still in flight) to the dashboard: a quick bloom with ~2.5 % give.
        springTo(this, { x: targetX, y: targetY, width: DASHBOARD_WIDTH, height: targetHeight },
            { duration: 560, damping: 0.76 });

        if (!this._railPlaced)
            this._queueRailPlacement();
    }

    collapse() {
        if (!this.isExpanded) return;
        this.isExpanded = false;
        this._closeScanOverlay();
        this._pauseMediaAnimations();
        this._leaveTab(this._activeTab);
        this._stopSystemRefresh();
        this._surface.remove_style_class_name('notchnux-island-expanded');

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        this._pill.remove_all_transitions();
        this._pill.visible = true;
        this._pill.opacity = 255;

        if (this._blurActive)
            this._animateBlurRadius(this._blurCfg.collapsedRadius);

        this._surface.set_pivot_point(0.5, 0.0);
        this._surface.remove_all_transitions();
        this._surface.scale_x = 1.0;
        this._surface.scale_y = 1.0;

        // Content leaves first and fast; the box then folds back into the
        // pill on a critically damped spring (no bounce on close).
        this._dashboard.ease({
            opacity: 0, translation_y: -6, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._dashboard.visible = false;
                this._dashboard.translation_y = 0;
            } });
        // Always fold back into the visible pill: idle-hide tucks it away only
        // after it has sat untouched for a while (see _updateTuck), never the
        // moment the pointer drifts off the dashboard.
        this._tucked = false;
        springTo(this, this._restGeometry(), { duration: 420, damping: 1 });
        if (this._afterCollapseId) GLib.Source.remove(this._afterCollapseId);
        this._afterCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 380, () => {
            this._afterCollapseId = 0;
            if (!this.isExpanded) {
                this._promoteAlert();
                this._updateTuck();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ============================================================
    // Clock / battery poll
    // ============================================================
    // The pill shows minutes, so wake once per minute, just after the minute
    // turns (re-aligned every tick so it never drifts), instead of every
    // second. Battery changes arrive as UPower notifications in between.
    _startClock() {
        this._stopClock();
        this._updateClock();
        let schedule = () => {
            let now = new Date();
            let ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
            this._clockTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._clockTimeoutId = null;
                this._updateClock();
                schedule();
                return GLib.SOURCE_REMOVE;
            });
        };
        schedule();
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
                // Rebuild on-screen tab only when data changes structurally.
                // The Tray meters are updated in-place without destroying actors;
                // the Alerts list only rebuilds when the queue actually changed.
                if (this._activeTab === 'system') {
                    this._updateSystemTabMeters();
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
        if (this._destroyed) return;
        let date = new Date();
        this._checkEventHeadsUp?.();
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
        if (!this.get_stage()) return;
        if (this._alertShowing || this._tucked || this._peekActive) return;
        let target = this._pillWidth();
        if (Math.abs(this.get_width() - target) > 1)
            this._applyPillWidth();
        else
            this._balancePillClock();
    }
});

installProductivity(NotchNux.prototype);
installLedge(NotchNux.prototype);
installTray(NotchNux.prototype);
