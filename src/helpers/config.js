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

// The canonical set of dashboard tabs and their default order. The settings
// UI reconciles the stored order/enabled maps against this list so tabs added
// in a future version appear (enabled, at the end) without a migration step,
// and stale ids in an old config file are ignored.
export const TAB_DEFS = [
    { id: 'media',         label: 'Music',    icon: 'audio-x-generic-symbolic' },
    { id: 'system',        label: 'Tray',     icon: 'emblem-system-symbolic' },
    { id: 'weather',       label: 'Weather',  icon: 'weather-few-clouds-symbolic' },
    { id: 'studio',        label: 'Studio',   icon: 'camera-web-symbolic' },
    { id: 'calendar',      label: 'Calendar', icon: 'x-office-calendar-symbolic' },
    { id: 'notifications', label: 'Alerts',   icon: 'preferences-system-notifications-symbolic' },
    { id: 'shelf',         label: 'Shelf',    icon: 'view-list-symbolic' },
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
    pauseOnFullscreen: true
};

// Feature toggles exposed in settings. `id` is the stored key; `default`
// is used when the config file has no opinion yet.
export const FEATURE_DEFS = [
    { id: 'showBattery',       label: 'Battery on pill',      description: 'Show the battery indicator on the collapsed pill.',        default: true },
    { id: 'showPrivacy',       label: 'Privacy indicators',   description: 'Show mic/camera in-use dots on the collapsed pill.',        default: true },
    { id: 'pillMarquee',       label: 'Scrolling track title', description: 'Scroll long track titles across the pill while playing.',  default: true },
    { id: 'weatherAutoRefresh', label: 'Auto-refresh weather', description: 'Periodically refresh weather in the background.',           default: true },
    { id: 'calendarSync',      label: 'Calendar sync',        description: 'Pull events from GNOME Online Accounts into the Calendar tab.', default: true },
    { id: 'notifPeek',         label: 'Notification peek',    description: 'Expand the pill into a banner when a notification arrives.',   default: true },
    { id: 'showPowerButton',   label: 'Power button',         description: 'Show a power menu (suspend, log out, restart, power off) in the dashboard header.', default: true },
    { id: 'hidePanel',         label: 'Hide top panel',       description: 'Hide the GNOME top bar and rely on the notch instead.',        default: false },
    { id: 'reclaimSpace',      label: 'Reclaim panel space',  description: 'Let maximized windows use the top strip the panel occupied (only applies when the panel is hidden).', default: false }
];

const DEFAULT_ACCENT = '#7aa2ff';

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

export class ConfigStore {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'notchnux']);
        this._path = GLib.build_filenamev([this._dir, 'config.json']);
        this._data = this._load();
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
        let features = {};
        for (let f of FEATURE_DEFS)
            features[f.id] = f.default;
        return {
            accent: DEFAULT_ACCENT,
            tabOrder: TAB_DEFS.map(t => t.id),
            tabs,
            features,
            wallpaper: { ...WALLPAPER_DEFAULTS }
        };
    }

    _load() {
        let data = this._defaults();
        try {
            let file = Gio.File.new_for_path(this._path);
            let [ok, contents] = file.load_contents(null);
            if (ok) {
                let text = new TextDecoder().decode(contents);
                let parsed = JSON.parse(text);
                // Shallow-merge over defaults so a partial/older file keeps
                // sensible values for anything it doesn't mention.
                data = { ...data, ...parsed };
                data.tabs = { ...this._defaults().tabs, ...(parsed.tabs ?? {}) };
                data.features = { ...this._defaults().features, ...(parsed.features ?? {}) };
                data.wallpaper = { ...WALLPAPER_DEFAULTS, ...(parsed.wallpaper ?? {}) };
                data.accent = normalizeHex(parsed.accent) ?? DEFAULT_ACCENT;
                data.tabOrder = this._reconcileOrder(parsed.tabOrder);
            }
        } catch (e) {
            // A missing file on first run is expected; anything else we log
            // but still fall back to defaults so the extension keeps working.
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.error('NotchNux: Failed to load config, using defaults.', e);
            data.tabOrder = this._reconcileOrder(data.tabOrder);
        }
        return data;
    }

    // Produce a valid, complete tab order from a possibly stale/partial stored
    // list: keep known ids in their stored order, drop unknown ids, and append
    // any known tab the stored list forgot (e.g. added in a newer version).
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
        for (let t of TAB_DEFS) {
            if (!seen.has(t.id))
                order.push(t.id);
        }
        return order;
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            let text = JSON.stringify(this._data, null, 2);
            let file = Gio.File.new_for_path(this._path);
            // replace_contents is atomic (writes to a temp then renames), so a
            // crash mid-write can't leave a truncated config behind.
            file.replace_contents(
                new TextEncoder().encode(text),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null);
        } catch (e) {
            console.error('NotchNux: Failed to save config.', e);
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
        this._data.tabOrder = this._reconcileOrder(order);
        this._save();
    }
    isTabEnabled(id) {
        return this._data.tabs[id] !== false;
    }
    setTabEnabled(id, enabled) {
        this._data.tabs[id] = !!enabled;
        this._save();
    }
    // The ordered list of tab ids that should actually be shown.
    get visibleTabs() {
        return this.tabOrder.filter(id => this.isTabEnabled(id));
    }

    // ---- Features ----
    isFeatureEnabled(id) {
        if (id in this._data.features)
            return !!this._data.features[id];
        let def = FEATURE_DEFS.find(f => f.id === id);
        return def ? def.default : true;
    }
    setFeatureEnabled(id, enabled) {
        this._data.features[id] = !!enabled;
        this._save();
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
        let next = { ...WALLPAPER_DEFAULTS, ...(this._data.wallpaper ?? {}), ...(patch ?? {}) };
        next.folder = typeof next.folder === 'string' ? next.folder : '';
        next.intervalSec = Math.max(5, parseInt(next.intervalSec, 10) || WALLPAPER_DEFAULTS.intervalSec);
        next.order = next.order === 'random' ? 'random' : 'sequential';
        next.rotationEnabled = !!next.rotationEnabled;
        next.autoLandscape = !!next.autoLandscape;
        next.enhance = !!next.enhance;
        next.enhanceMode = next.enhanceMode === 'manual' ? 'manual' : 'auto';
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
}
