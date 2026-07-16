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
    { id: 'shelf',         label: 'Shelf',    icon: 'view-list-symbolic' }
];

// Feature toggles exposed in settings. `id` is the stored key; `default`
// is used when the config file has no opinion yet.
export const FEATURE_DEFS = [
    { id: 'showBattery',       label: 'Battery on pill',      description: 'Show the battery indicator on the collapsed pill.',        default: true },
    { id: 'showPrivacy',       label: 'Privacy indicators',   description: 'Show mic/camera in-use dots on the collapsed pill.',        default: true },
    { id: 'pillMarquee',       label: 'Scrolling track title', description: 'Scroll long track titles across the pill while playing.',  default: true },
    { id: 'weatherAutoRefresh', label: 'Auto-refresh weather', description: 'Periodically refresh weather in the background.',           default: true },
    { id: 'calendarSync',      label: 'Calendar sync',        description: 'Pull events from GNOME Online Accounts into the Calendar tab.', default: true },
    { id: 'notifPeek',         label: 'Notification peek',    description: 'Expand the pill into a banner when a notification arrives.',   default: true }
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
            features
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
}
