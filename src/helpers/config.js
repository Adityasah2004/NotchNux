// Persistent user configuration for NotchNux.
//
// The extension ships no GSettings schema (adding one means a compiled
// gschema and a heavier install), so preferences that must survive a shell
// restart are stored as a small JSON document under the user's config dir:
//
//     ~/.config/notchnux/config.json
//
// ConfigStore owns loading, validating, and atomically saving that document,
// and exposes the three things the settings UI lets the user change:
//   - accent   : the accent colour, as a "#rrggbb" hex string
//   - tabOrder : the order dashboard tabs appear in the carousel
//   - tabs     : which tabs are shown at all (per-tab enable toggle)
//   - features : per-feature on/off toggles (weather, calendar sync, etc.)
//
// Callers read via the typed getters and mutate via the setters, each of
// which persists immediately. Unknown keys in a stored file are preserved on
// save so a downgrade doesn't silently drop a newer version's settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { logError } from './log.js';

// The canonical set of dashboard tabs and their default order. The settings
// UI reconciles the stored order/enabled maps against this list so tabs added
// in a future version appear (enabled, at the end) without a migration step,
// and stale ids in an old config file are ignored.
export const TAB_DEFS = [
    { id: 'home',          label: 'Home',     icon: 'go-home-symbolic' },
    { id: 'tasks',         label: 'Tasks',    icon: 'checkbox-checked-symbolic' },
    { id: 'focus',         label: 'Focus',    icon: 'alarm-symbolic' },
    { id: 'media',         label: 'Music',    icon: 'audio-x-generic-symbolic' },
    { id: 'calendar',      label: 'Calendar', icon: 'x-office-calendar-symbolic' },
    { id: 'weather',       label: 'Weather',  icon: 'weather-few-clouds-symbolic' },
    { id: 'notifications', label: 'Alerts',   icon: 'preferences-system-notifications-symbolic' },
    { id: 'system',        label: 'Tray',     icon: 'emblem-system-symbolic' },
    { id: 'shelf',         label: 'Shelf',    icon: 'view-list-symbolic' },
    { id: 'notes',         label: 'Notes',    icon: 'document-edit-symbolic' },
    { id: 'clipboard',     label: 'Clipboard', icon: 'edit-paste-symbolic' },
    { id: 'studio',        label: 'Studio',   icon: 'camera-web-symbolic' },
    { id: 'wallpaper',     label: 'Wallpaper', icon: 'preferences-desktop-wallpaper-symbolic' }
];

// Auto-enhancement strengths — the tuned defaults used when the user leaves
// enhancement in 'auto' mode. Kept here (rather than only in wallpaper.js) so
// that 'manual' sliders can start from the exact same numbers, and so config
// validation can clamp manual values to a sane range around them.
//   sharpen    — unsharp-mask amount (0 = none, higher = crisper/haloed)
//   contrast   — >1 pushes darks down / lights up around mid-grey
//   saturation — >1 deepens colour
export const ENHANCE_AUTO = {
    sharpen: 0.6,
    contrast: 1.06,
    saturation: 1.08,
};
// Allowed slider ranges for manual enhancement.
export const ENHANCE_RANGE = {
    sharpen: { min: 0, max: 2 },
    contrast: { min: 1, max: 1.5 },
    saturation: { min: 1, max: 1.5 },
};

// Wallpaper-rotation defaults. The heavy config (folder, interval, order,
// auto-pause) lives in the prefs window; the dashboard's Wallpaper tab is just
// the visual switcher. `folder` empty means "not configured yet".
export const WALLPAPER_DEFAULTS = {
    folder: '',
    intervalSec: 300,
    order: 'sequential',     // 'sequential' | 'random'
    rotationEnabled: false,
    autoLandscape: false,    // rotate portrait images 90° into landscape
    enhance: false,          // sharpen + contrast/saturation for a crisper look
    // Enhancement tuning. In 'auto' the ENHANCE_AUTO values are used; in
    // 'manual' the user's own sharpen/contrast/saturation below apply.
    enhanceMode: 'auto',     // 'auto' | 'manual'
    enhanceSharpen: ENHANCE_AUTO.sharpen,
    enhanceContrast: ENHANCE_AUTO.contrast,
    enhanceSaturation: ENHANCE_AUTO.saturation,
    pauseOnBattery: true,
    pauseOnFullscreen: true,
    // Desktop reveal when the wallpaper changes: 'grow' | 'wipe' | 'fade' | 'none'
    transition: 'grow'
};

// ---- Blur / "glass" appearance ----
//
// GNOME Shell can composite a real gaussian backdrop blur under an actor via
// Shell.BlurEffect(mode = BACKGROUND): it samples whatever is drawn behind the
// surface (wallpaper, windows) and blurs it live. For that to be visible the
// surface's own background must be *semi-transparent* — an opaque fill would
// just cover the blurred backdrop. So each "glass" preset is really a bundle of
//   - tint      : the surface fill colour (its RGB), applied at `alpha`
//   - alpha     : how opaque that fill is (lower = more of the blur shows)
//   - rimTop    : the bright hairline along the top edge (the "light frame")
//   - rim       : the surrounding hairline
//   - brightness: BlurEffect brightness (1 = neutral; <1 darkens the blur)
//   - saturate  : extra colour lift applied to the tint for the "liquid" look
// The blur *radius* is not part of the preset — it's controlled per pill state
// (collapsed vs expanded) by the user's own sliders, so the same glass style
// can be subtle on the pill and deep on the open dashboard.
// Each preset also carries its own recommended collapsed/expanded blur radius,
// so picking a "Glass style" applies a complete look (tint + rim + strength)
// rather than only the frost colour. The prefs UI moves the strength sliders to
// these values on a preset switch; the user can still fine-tune afterwards.
export const BLUR_PRESETS = [
    {
        id: 'liquid',
        label: 'Liquid Glass',
        description: 'Apple-style vivid frosted glass — light tint, bright rim, colour lift.',
        tint: '250,250,252', alpha: 0.28, rimTop: 0.55, rim: 0.16,
        brightness: 1.06,
        collapsedRadius: 18, expandedRadius: 36,
    },
    {
        id: 'frosted',
        label: 'Frosted',
        description: 'Neutral Samsung-style frosted panel — balanced tint and rim.',
        tint: '18,18,22', alpha: 0.55, rimTop: 0.20, rim: 0.10,
        brightness: 0.94,
        collapsedRadius: 22, expandedRadius: 44,
    },
    {
        id: 'clear',
        label: 'Clear',
        description: 'Barely-there glass — mostly the blurred backdrop, faint rim.',
        tint: '13,13,16', alpha: 0.18, rimTop: 0.14, rim: 0.06,
        brightness: 1.0,
        collapsedRadius: 12, expandedRadius: 24,
    },
    {
        id: 'acrylic',
        label: 'Acrylic',
        description: 'Windows-style acrylic — darker tint with a soft rim over the blur.',
        tint: '10,10,14', alpha: 0.66, rimTop: 0.16, rim: 0.08,
        brightness: 0.9,
        collapsedRadius: 28, expandedRadius: 52,
    },
];

// Range for the per-state blur radius sliders (in the same units Shell's
// BlurEffect uses). 0 disables the blur for that state; the ceiling keeps the
// compositor cost bounded on lower-end GPUs.
export const BLUR_RADIUS_RANGE = { min: 0, max: 64 };

// Blur defaults: off, so nothing changes until the user opts in. `preset` names
// one of BLUR_PRESETS above; the two radii are the collapsed/expanded strengths.
export const BLUR_DEFAULTS = {
    enabled: false,
    preset: 'liquid',
    collapsedRadius: 18,
    expandedRadius: 36,
};

// Look up a blur preset by id, falling back to the first (default) preset so a
// stale/unknown id from an old or hand-edited config never breaks rendering.
export function blurPreset(id) {
    return BLUR_PRESETS.find(p => p.id === id) ?? BLUR_PRESETS[0];
}

// Feature toggles exposed in settings. `id` is the stored key; `default`
// is used when the config file has no opinion yet.
export const FEATURE_DEFS = [
    { id: 'showBattery',       label: 'Battery on pill',      description: 'Show the battery indicator on the collapsed pill.',        default: true },
    { id: 'showPrivacy',       label: 'Privacy indicators',   description: 'Show mic/camera in-use dots on the collapsed pill.',        default: true },
    { id: 'pillMarquee',       label: 'Scrolling track title', description: 'Scroll long track titles across the pill while playing.',  default: true },
    { id: 'weatherAutoRefresh', label: 'Auto-refresh weather', description: 'Periodically refresh weather in the background.',           default: true },
    { id: 'calendarSync',      label: 'Calendar sync',        description: 'Pull events from GNOME Online Accounts into the Calendar tab.', default: true },
    { id: 'notifPeek',         label: 'Notification peek',    description: 'Expand the pill into a banner when a notification arrives.',   default: true },
    { id: 'showPowerButton',   label: 'Session actions',      description: 'List Lock, Suspend, Log Out, Restart and Power Off in the dashboard’s ⋯ menu.', default: true },
    { id: 'hidePanel',         label: 'Hide top panel',       description: 'Hide the GNOME top bar and rely on the notch instead.',        default: false },
    { id: 'reclaimSpace',      label: 'Reclaim panel space',  description: 'Let maximized windows use the top strip the panel occupied (only applies when the panel is hidden).', default: false },
    { id: 'mirrorTray',        label: 'Mirror top-bar indicators', description: 'Show the top bar’s extension and status icons inside the Tray tab, so you can reach them with the panel hidden.', default: true },
    { id: 'notchHud',          label: 'Volume & brightness in the notch', description: 'Show volume, brightness and other on-screen levels as a short alert in the notch instead of GNOME’s centre pop-up.', default: true },
    { id: 'powerAlerts',       label: 'Charging & low battery alerts', description: 'A short alert when you plug in the charger or the battery drops to 20 % and 10 %.', default: true },
    { id: 'headphoneAlerts',   label: 'Headphone alerts',     description: 'A short alert when headphones or a Bluetooth headset become the audio output.', default: true },
    { id: 'eventHeadsUp',      label: 'Event heads-up',       description: 'A heads-up in the notch 5 minutes before a calendar event starts.', default: true },
    { id: 'autoHide',          label: 'Hide when idle',       description: 'Tuck the notch into the top edge while nothing is happening. It comes back for music, timers and alerts, or when you rest the pointer at the top centre.', default: false },
    { id: 'pillStats',         label: 'Stats in the pill',    description: 'Show memory and CPU in the pill when nothing else is live. Read every 2 seconds, only while on.', default: false },
    { id: 'swipeGestures',     label: 'Swipe gestures',       description: 'Two-finger swipe sideways on the pill to skip tracks; swipe down to open, up to close.', default: true },
    { id: 'lyricsOnline',      label: 'Look up lyrics online', description: 'Fetch timed lyrics for the playing song from lrclib.net (sends the song’s title, artist, album and length).', default: true },
    { id: 'topScroll',         label: 'Scroll top edge to switch workspaces', description: 'Restore top-edge scroll-to-switch-workspace when the panel is hidden — scroll anywhere along the top of the screen to move between workspaces.', default: false }
];

const DEFAULT_ACCENT = '#7aa2ff';

// Up to `pinnedMax` tabs (1–MAX_PINNED, set in Preferences) sit beside Home
// in the dashboard header; everything else is one click away in the grid.
export const MAX_PINNED = 8;
export const DEFAULT_PINNED_MAX = 5;
export const DEFAULT_PINNED = ['media', 'tasks', 'calendar', 'weather', 'system'];

// A stored shortcut limit → an integer in 1–MAX_PINNED (default when unset).
export function clampPinnedMax(n) {
    let v = typeof n === 'number' || typeof n === 'string' ? Math.round(Number(n)) : NaN;
    return Number.isFinite(v) && String(n).trim() !== '' ? Math.max(1, Math.min(MAX_PINNED, v)) : DEFAULT_PINNED_MAX;
}

// Accept #rgb / #rrggbb (with or without leading #), returns a normalized
// lowercase "#rrggbb" string, or null if the input isn't a valid hex colour.
export function normalizeHex(input) {
    if (typeof input !== 'string')
        return null;
    let s = input.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(s))
        s = s.split('').map(c => c + c).join('');
    if (/^[0-9a-f]{6}$/.test(s))
        return '#' + s;
    return null;
}

// "#rrggbb" -> [r, g, b] with each channel in 0..1 (the form the Cairo
// widgets and setAccent() consume).
export function hexToRgb01(hex) {
    let h = normalizeHex(hex) ?? DEFAULT_ACCENT;
    let n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function configDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'notchnux']);
}

export class ConfigStore {
    // `contents`: the file's bytes, already read (or null for defaults).
    // `readFile(path)`: a synchronous reader returning bytes or null. Only the
    // prefs window passes one (it re-reads before every write, see
    // _refresh()); the shell never does file IO here except through
    // loadAsync()/reloadAsync().
    constructor({ contents = null, readFile = null } = {}) {
        this._dir = configDir();
        this._path = GLib.build_filenamev([this._dir, 'config.json']);
        this._readFile = readFile;
        this._data = this._parse(contents ?? readFile?.(this._path) ?? null);
    }

    // Read the config without blocking and call back with a new store. A
    // missing or unreadable file gives the defaults; a cancelled read never
    // calls back.
    static loadAsync(cancellable, cb) {
        let path = GLib.build_filenamev([configDir(), 'config.json']);
        Gio.File.new_for_path(path).load_contents_async(cancellable, (f, res) => {
            let contents = null;
            try {
                [, contents] = f.load_contents_finish(res);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    logError('Failed to read config, using defaults.', e);
            }
            cb(new ConfigStore({ contents }));
        });
    }

    // Absolute path of the backing JSON file. The shell watches this so edits
    // made by the separate prefs.js process get applied live.
    get path() {
        return this._path;
    }

    // Re-read the file from disk, discarding the in-memory copy. Called by the
    // shell when its file monitor sees prefs.js has written new settings.
    reload() {
        this._data = this._load();
    }

    _defaults() {
        let tabs = {};
        for (let t of TAB_DEFS)
            tabs[t.id] = true;
        // Clipboard history reads everything the user copies, so it is
        // opt-in: off until enabled in Preferences → Tabs.
        tabs.clipboard = false;
        let features = {};
        for (let f of FEATURE_DEFS)
            features[f.id] = f.default;
        return {
            accent: DEFAULT_ACCENT,
            tabOrder: TAB_DEFS.map(t => t.id),
            tabs,
            features,
            wallpaper: { ...WALLPAPER_DEFAULTS },
            blur: { ...BLUR_DEFAULTS },
            // Per-indicator enable map for the Tray tab's mirror row, keyed by a
            // stable indicator id. Empty by default: an id not present is treated
            // as enabled (see isTrayMirrorEnabled), so every indicator shows
            // until the user hides one.
            trayMirror: {},
            // Catalog of indicators the shell has actually seen it can mirror,
            // as [{ id, label }]. The shell publishes this so the (separate)
            // prefs process can render a picker for indicators it can't see
            // directly. Not user-authored; overwritten by the shell.
            trayMirrorItems: [],
            // Shortcuts beside Home in the header: up to MAX_PINNED kept,
            // the first pinnedMax shown.
            pinnedTabs: [...DEFAULT_PINNED],
            pinnedMax: DEFAULT_PINNED_MAX,
            // Keep Awake survives a lock/unlock (the extension is re-enabled).
            keepAwake: false,
            // Music tab shows synced lyrics in place of the vinyl + knob.
            musicLyrics: false
        };
    }

    // Async counterpart of reload() for the shell, so a settings change made
    // in Preferences never blocks the compositor on file IO. Calls back
    // after the new values are in place; not at all if cancelled.
    reloadAsync(cancellable, cb) {
        Gio.File.new_for_path(this._path).load_contents_async(cancellable, (f, res) => {
            let contents = null;
            try {
                [, contents] = f.load_contents_finish(res);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    logError('Failed to read config, using defaults.', e);
            }
            this._data = this._parse(contents);
            cb();
        });
    }

    // Fresh data from disk when a synchronous reader was given (prefs);
    // otherwise the in-memory copy, which the shell keeps current through
    // its file monitor + reloadAsync().
    _load() {
        return this._readFile ? this._parse(this._readFile(this._path)) : this._data;
    }

    _parse(contents) {
        let data = this._defaults();
        try {
            if (contents) {
                let text = new TextDecoder().decode(contents);
                let parsed = JSON.parse(text);
                // Shallow-merge over defaults so a partial/older file keeps
                // sensible values for anything it doesn't mention.
                data = { ...data, ...parsed };
                data.tabs = { ...this._defaults().tabs, ...(parsed.tabs ?? {}) };
                data.features = { ...this._defaults().features, ...(parsed.features ?? {}) };
                data.wallpaper = { ...WALLPAPER_DEFAULTS, ...(parsed.wallpaper ?? {}) };
                data.blur = { ...BLUR_DEFAULTS, ...(parsed.blur ?? {}) };
                data.trayMirror = (parsed.trayMirror && typeof parsed.trayMirror === 'object')
                    ? { ...parsed.trayMirror } : {};
                data.trayMirrorItems = Array.isArray(parsed.trayMirrorItems)
                    ? parsed.trayMirrorItems.filter(it => it && typeof it.id === 'string')
                    : [];
                data.accent = normalizeHex(parsed.accent) ?? DEFAULT_ACCENT;
                data.pinnedTabs = this._cleanPinned(parsed.pinnedTabs ?? DEFAULT_PINNED);
                data.pinnedMax = clampPinnedMax(parsed.pinnedMax);
                data.keepAwake = !!parsed.keepAwake;
                data.musicLyrics = !!parsed.musicLyrics;
                data.tabOrder = this._reconcileOrder(parsed.tabOrder);
            }
        } catch (e) {
            // Corrupt JSON: log it but fall back to defaults so the extension
            // keeps working.
            logError('Failed to parse config, using defaults.', e);
            data.tabOrder = this._reconcileOrder(data.tabOrder);
        }
        return data;
    }

    // Produce a valid, complete tab order from a possibly stale/partial stored
    // list: keep known ids in their stored order, drop unknown ids, and slot in
    // any known tab the stored list forgot (e.g. added in a newer version) at
    // its default position — right after the nearest preceding default-order
    // tab the user has (or before the next one) — so new tabs like Home land
    // up front and Notes beside Shelf, not all at the end.
    _reconcileOrder(stored) {
        let known = new Set(TAB_DEFS.map(t => t.id));
        let seen = new Set();
        let order = [];
        for (let id of Array.isArray(stored) ? stored : []) {
            if (known.has(id) && !seen.has(id)) {
                order.push(id);
                seen.add(id);
            }
        }
        let defaults = TAB_DEFS.map(t => t.id);
        defaults.forEach((id, i) => {
            if (seen.has(id))
                return;
            let prev = defaults.slice(0, i).reverse().find(n => order.includes(n));
            let next = defaults.slice(i + 1).find(n => order.includes(n));
            let at = prev ? order.indexOf(prev) + 1
                : next ? order.indexOf(next) : order.length;
            order.splice(at, 0, id);
            seen.add(id);
        });
        return order;
    }

    // The shell and the prefs window each hold a ConfigStore over the same
    // file. Every setter first re-reads the file (_refresh) and then changes
    // only its own key, so one process never writes back a stale copy that
    // silently undoes the other's edit.
    _refresh() {
        this._data = this._load();
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            // Atomic (temp file + rename) and private to the user. The mode
            // argument only applies to new files, so also tighten a config
            // (and dir) created 0644/0755 by older versions.
            GLib.file_set_contents_full(this._path,
                new TextEncoder().encode(JSON.stringify(this._data, null, 2)),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
            GLib.chmod(this._path, 0o600);
            GLib.chmod(this._dir, 0o700);
        } catch (e) {
            logError('Failed to save config.', e);
        }
    }

    // ---- Accent ----
    get accent() {
        return this._data.accent;
    }
    setAccent(hex) {
        let norm = normalizeHex(hex);
        if (!norm)
            return false;
        this._refresh();
        this._data.accent = norm;
        this._save();
        return true;
    }
    get accentRgb() {
        return hexToRgb01(this._data.accent);
    }

    // ---- Tabs (order + enabled) ----
    get tabOrder() {
        return this._reconcileOrder(this._data.tabOrder);
    }
    setTabOrder(order) {
        this._refresh();
        this._data.tabOrder = this._reconcileOrder(order);
        this._save();
    }
    isTabEnabled(id) {
        return this._data.tabs[id] !== false;
    }
    setTabEnabled(id, enabled) {
        this._refresh();
        this._data.tabs[id] = !!enabled;
        this._save();
    }
    // The ordered list of tab ids that should actually be shown.
    get visibleTabs() {
        return this.tabOrder.filter(id => this.isTabEnabled(id));
    }

    // ---- Header shortcuts (pinned tabs) ----
    _cleanPinned(list) {
        let known = new Set(TAB_DEFS.map(t => t.id));
        known.delete('home');
        let out = [];
        for (let id of Array.isArray(list) ? list : []) {
            if (known.has(id) && !out.includes(id))
                out.push(id);
        }
        return out.slice(0, MAX_PINNED);
    }
    // ponytail: the stored list keeps up to MAX_PINNED, so lowering the
    // limit and raising it again brings shortcuts back, until the next edit
    // in the grid saves only the ones shown.
    get pinnedTabs() {
        return this._cleanPinned(this._data.pinnedTabs).slice(0, this.pinnedMax);
    }
    setPinnedTabs(list) {
        this._refresh();
        this._data.pinnedTabs = this._cleanPinned(list);
        this._save();
    }
    get pinnedMax() {
        return clampPinnedMax(this._data.pinnedMax);
    }
    setPinnedMax(n) {
        this._refresh();
        this._data.pinnedMax = clampPinnedMax(n);
        this._save();
    }

    get keepAwake() {
        return !!this._data.keepAwake;
    }
    setKeepAwake(on) {
        this._refresh();
        this._data.keepAwake = !!on;
        this._save();
    }

    get musicLyrics() {
        return !!this._data.musicLyrics;
    }
    setMusicLyrics(on) {
        this._refresh();
        this._data.musicLyrics = !!on;
        this._save();
    }

    // ---- Features ----
    isFeatureEnabled(id) {
        if (id in this._data.features)
            return !!this._data.features[id];
        let def = FEATURE_DEFS.find(f => f.id === id);
        return def ? def.default : true;
    }
    setFeatureEnabled(id, enabled) {
        this._refresh();
        this._data.features[id] = !!enabled;
        this._save();
    }

    // ---- Tray-mirror indicator picker ----
    // Which top-bar/Quick-Settings indicators the Tray tab mirrors, keyed by a
    // stable id the shell derives (see notchnux.js _trayMirrorId). Default-on:
    // an id absent from the map shows, so a newly-installed extension appears
    // automatically and the user only ever opts things *out*.
    isTrayMirrorEnabled(id) {
        let m = this._data.trayMirror ?? {};
        return m[id] !== false;
    }
    setTrayMirrorEnabled(id, enabled) {
        this._refresh();
        if (!this._data.trayMirror || typeof this._data.trayMirror !== 'object')
            this._data.trayMirror = {};
        this._data.trayMirror[id] = !!enabled;
        this._save();
    }
    // A stable serialization of just the user's enable map (NOT the published
    // catalog), for the shell's config-change diff. The shell writes the catalog
    // itself, so keying the diff on the whole trayMirror blob would make it react
    // to its own publish; this keys only on what the user can change in prefs.
    get trayMirrorKey() {
        let m = this._data.trayMirror ?? {};
        return JSON.stringify(Object.keys(m).sort().map(k => [k, m[k] !== false]));
    }

    // The catalog of mirrorable indicators the shell last saw, [{ id, label }].
    // Read by the prefs process to build the picker; written by the shell.
    get trayMirrorItems() {
        return Array.isArray(this._data.trayMirrorItems) ? this._data.trayMirrorItems : [];
    }
    // Publish the current set of mirrorable indicators. Only writes (and only
    // triggers a save + file-change) when the catalog actually differs, so the
    // shell re-rendering the tray doesn't churn the config file on every open.
    publishTrayMirrorItems(items) {
        let next = (Array.isArray(items) ? items : [])
            .filter(it => it && typeof it.id === 'string')
            .map(it => ({ id: it.id, label: String(it.label ?? it.id) }));
        this._refresh();
        let prev = this.trayMirrorItems;
        let same = prev.length === next.length &&
            prev.every((p, i) => p.id === next[i].id && p.label === next[i].label);
        if (same)
            return false;
        this._data.trayMirrorItems = next;
        this._save();
        return true;
    }

    // ---- Wallpaper rotation ----
    // Returned as a fresh object over the defaults so callers always get every
    // key even if the stored blob is partial or missing.
    get wallpaper() {
        return { ...WALLPAPER_DEFAULTS, ...(this._data.wallpaper ?? {}) };
    }
    // Merge a partial update into the stored wallpaper settings. Validates the
    // couple of fields that have a constrained shape; unknown keys pass through.
    setWallpaper(patch) {
        this._refresh();
        let next = { ...WALLPAPER_DEFAULTS, ...(this._data.wallpaper ?? {}), ...(patch ?? {}) };
        next.folder = typeof next.folder === 'string' ? next.folder : '';
        next.intervalSec = Math.max(5, parseInt(next.intervalSec, 10) || WALLPAPER_DEFAULTS.intervalSec);
        next.order = next.order === 'random' ? 'random' : 'sequential';
        next.rotationEnabled = !!next.rotationEnabled;
        next.autoLandscape = !!next.autoLandscape;
        next.enhance = !!next.enhance;
        next.enhanceMode = next.enhanceMode === 'manual' ? 'manual' : 'auto';
        next.transition = ['grow', 'wipe', 'fade', 'none'].includes(next.transition)
            ? next.transition : 'grow';
        // Clamp the manual strengths into their allowed ranges, falling back to
        // the auto defaults for anything non-numeric.
        let clampEnh = (v, def, range) => {
            let n = Number(v);
            if (!Number.isFinite(n)) n = def;
            return Math.min(range.max, Math.max(range.min, n));
        };
        next.enhanceSharpen = clampEnh(next.enhanceSharpen, ENHANCE_AUTO.sharpen, ENHANCE_RANGE.sharpen);
        next.enhanceContrast = clampEnh(next.enhanceContrast, ENHANCE_AUTO.contrast, ENHANCE_RANGE.contrast);
        next.enhanceSaturation = clampEnh(next.enhanceSaturation, ENHANCE_AUTO.saturation, ENHANCE_RANGE.saturation);
        next.pauseOnBattery = !!next.pauseOnBattery;
        next.pauseOnFullscreen = !!next.pauseOnFullscreen;
        this._data.wallpaper = next;
        this._save();
    }

    // ---- Blur / glass ----
    // Always returned complete over the defaults, with the preset id and radii
    // validated so the shell can consume them without re-checking.
    get blur() {
        let raw = { ...BLUR_DEFAULTS, ...(this._data.blur ?? {}) };
        let clampR = (v, def) => {
            let n = Math.round(Number(v));
            if (!Number.isFinite(n)) n = def;
            return Math.min(BLUR_RADIUS_RANGE.max, Math.max(BLUR_RADIUS_RANGE.min, n));
        };
        return {
            enabled: !!raw.enabled,
            preset: blurPreset(raw.preset).id,
            collapsedRadius: clampR(raw.collapsedRadius, BLUR_DEFAULTS.collapsedRadius),
            expandedRadius: clampR(raw.expandedRadius, BLUR_DEFAULTS.expandedRadius),
        };
    }
    // Merge a partial update into the stored blur settings; `blur` getter does
    // the validation, so this just persists the merged blob.
    setBlur(patch) {
        this._refresh();
        this._data.blur = { ...BLUR_DEFAULTS, ...(this._data.blur ?? {}), ...(patch ?? {}) };
        this._save();
    }
}
