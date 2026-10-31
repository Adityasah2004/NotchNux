// Tray tab — a Control Center for the notch.
//
//   ┌ Connectivity ─────────────┐ ┌ Silence ┐ ┌ Night  ┐
//   │ ◉ Wi-Fi      ADITYA     › │ │         │ │ Light  │
//   │ ◉ Bluetooth  2 on       › │ ├─────────┤ ├────────┤
//   │ ◉ Hotspot    Off          │ │ Screen- │ │ Lock   │
//   │ ◉ Airplane   Off          │ │ shot    │ │        │
//   └───────────────────────────┘ └─────────┘ └────────┘
//   [🔊 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ] 45%
//   [☀ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ] 70%
//   ┌ Devices ──────────────────┐ ┌ System ───────────────┐
//   └───────────────────────────┘ └───────────────────────┘
//   Top bar  ⓘ ⓘ ⓘ ⓘ
//
// Everything updates in place: toggles restyle, sliders follow the mixer and
// backlight, meters scale a fill (a transform — no relayout) and only the
// device list is rebuilt when BlueZ / UPower report a change.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import { addPressFeedback } from '../helpers/motion.js';
import { accentHex, accentRgbStr } from '../helpers/widgets.js';

const NIGHT_LIGHT_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const DEV_CAP = 3;
const HOT = 85;   // meter turns amber past this

function label(text, cls, props = {}) {
    let l = new St.Label({ text, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function onStyle() {
    return `background-color: ${accentHex()}; color: #0b0b0e;`;
}

const TrayFeatures = {
    _renderSystemTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-cc', vertical: true, x_expand: true });
        let ui = { conn: {}, tiles: {}, sliders: {} };
        this._trayUi = ui;

        // ---- Row 1: connectivity + quick tiles ----
        let top = new St.BoxLayout({ style_class: 'nn-cc-top', x_expand: true });
        let conn = new St.BoxLayout({ style_class: 'nn-cc-card nn-cc-conn', vertical: true, x_expand: true });
        ui.conn.wifi = this._ccRow(conn, 'Wi-Fi', () => {
            let on = !this._system.getWifiInfo().enabled;
            this._system.setWifiEnabled(on);
            ui.conn.wifi.update(on, on ? 'Turning on…' : 'Off');
            this._scheduleTrayReRender();
        }, () => this._openWifiScanOverlay());
        ui.conn.bt = this._ccRow(conn, 'Bluetooth', () => {
            let on = !this._system.getBluetoothPowered();
            ui.conn.bt.update(on, on ? 'Turning on…' : 'Off');
            this._system.setBluetoothRadio(on, () => this._queueTrayCardsRefresh());
        }, () => this._openBluetoothScanOverlay());
        ui.conn.hotspot = this._ccRow(conn, 'Hotspot', () => this._toggleHotspot());
        ui.conn.air = this._ccRow(conn, 'Airplane Mode', () => {
            let on = !this._system.getAirplaneMode();
            ui.conn.air.update(on, on ? 'On' : 'Off');
            this._system.setAirplaneMode(on, () => this._queueTrayCardsRefresh());
        });
        top.add_child(conn);

        let grid = new St.BoxLayout({ style_class: 'nn-cc-grid', vertical: true });
        let gridRows = [0, 1].map(() => {
            let r = new St.BoxLayout({ style_class: 'nn-cc-grid-row', y_expand: true });
            grid.add_child(r);
            return r;
        });
        let dnd = this._notificationSettings();
        ui.tiles.dnd = this._ccTile(gridRows[0], 'Silence', () => {
            let silent = dnd.get_boolean('show-banners');
            dnd.set_boolean('show-banners', !silent);
            this._syncTrayToggles();
        });
        let night = this._nightLightSettings();
        ui.tiles.night = this._ccTile(gridRows[0], 'Night Light', night ? () => {
            night.set_boolean('night-light-enabled', !night.get_boolean('night-light-enabled'));
            this._syncTrayToggles();
        } : null);
        ui.tiles.shot = this._ccTile(gridRows[1], 'Screenshot', () => {
            this._collapseImmediately();
            Main.screenshotUI.open();
        });
        ui.tiles.shot.update(false, 'Capture', 'accessories-screenshot-symbolic');
        ui.tiles.lock = this._ccTile(gridRows[1], 'Lock', () => {
            this._collapseImmediately();
            Main.screenShield.lock(true);
        });
        ui.tiles.lock.update(false, 'Screen', 'system-lock-screen-symbolic');
        top.add_child(grid);
        panel.add_child(top);

        // ---- Row 2: sliders ----
        let sliders = new St.BoxLayout({ style_class: 'nn-cc-sliders', vertical: true, x_expand: true });
        ui.sliders.volume = this._ccSlider(sliders, this._system.volume / 100, v => {
            if (this._system.isMuted && v > 0)
                this._system.setMuted(false);
            this._system.setVolume(v);
        }, () => {
            this._system.setMuted(!this._system.isMuted);
            this._syncTraySliders();
        });
        ui.sliders.volume.btn.accessible_name = 'Mute';
        ui.sliders.bright = this._ccSlider(sliders, (this._system.getBrightness() ?? 0) / 100,
            v => this._system.setBrightness(Math.max(1, v)));
        ui.sliders.bright.icon.icon_name = 'display-brightness-symbolic';
        ui.sliders.bright.btn.reactive = false;
        panel.add_child(sliders);

        // ---- Row 3: devices + system ----
        let lower = new St.BoxLayout({ style_class: 'nn-cc-lower', x_expand: true });
        let devCard = new St.BoxLayout({ style_class: 'nn-cc-card nn-cc-list nn-cc-devcard', vertical: true, x_expand: true });
        devCard.add_child(label('DEVICES', 'nook-card-eyebrow'));
        ui.devList = new St.BoxLayout({ style_class: 'nn-cc-devlist', vertical: true, x_expand: true });
        devCard.add_child(ui.devList);
        lower.add_child(devCard);

        let sysCard = new St.BoxLayout({ style_class: 'nn-cc-card nn-cc-list', vertical: true, x_expand: true });
        sysCard.add_child(label('SYSTEM', 'nook-card-eyebrow'));
        this._trayMeters = {
            cpu: this._ccMeter(sysCard, 'CPU'),
            ram: this._ccMeter(sysCard, 'Memory'),
            disk: this._ccMeter(sysCard, 'Disk'),
        };
        let net = new St.BoxLayout({ style_class: 'nn-cc-meter nn-cc-net', x_expand: true });
        net.add_child(label('Network', 'nn-cc-meter-name'));
        let down = label('', 'nn-cc-net-rate', { x_expand: true, x_align: Clutter.ActorAlign.END });
        let up = label('', 'nn-cc-net-rate');
        net.add_child(new St.Icon({ icon_name: 'go-down-symbolic', icon_size: 11, style_class: 'nn-cc-net-icon', y_align: Clutter.ActorAlign.CENTER }));
        net.add_child(down);
        net.add_child(new St.Icon({ icon_name: 'go-up-symbolic', icon_size: 11, style_class: 'nn-cc-net-icon', y_align: Clutter.ActorAlign.CENTER }));
        net.add_child(up);
        sysCard.add_child(net);
        this._trayMeters.net = { down, up };
        lower.add_child(sysCard);
        panel.add_child(lower);

        // ---- Row 4: mirrored top-bar indicators ----
        if (this._config.isFeatureEnabled('mirrorTray')) {
            let tray = this._buildTrayMirror();
            if (tray)
                panel.add_child(tray);
        }

        this._mount(panel);
        this._fillTrayDevices();
        this._syncTrayToggles();
        this._syncTraySliders();
        this._updateSystemTabMeters(false);
    },

    // One connectivity row: a round toggle, then a name + state that opens a
    // detail sheet (when `onOpen` is given) or toggles too.
    _ccRow(parent, name, onToggle, onOpen = null) {
        let row = new St.BoxLayout({ style_class: 'nn-cc-row', x_expand: true });
        let circle = new St.Button({ style_class: 'nn-cc-circle', can_focus: true, accessible_name: name,
            y_align: Clutter.ActorAlign.CENTER });
        let icon = new St.Icon({ icon_size: 16 });
        circle.set_child(icon);
        circle.connect('clicked', onToggle);
        addPressFeedback(circle, 0.88);
        row.add_child(circle);

        let textBtn = new St.Button({ style_class: 'nn-cc-rowbtn', x_expand: true, can_focus: !!onOpen });
        let box = new St.BoxLayout({ x_expand: true });
        let texts = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        texts.add_child(label(name, 'nn-cc-name'));
        let sub = label('', 'nn-cc-sub');
        texts.add_child(sub);
        box.add_child(texts);
        if (onOpen)
            box.add_child(new St.Icon({ icon_name: 'go-next-symbolic', icon_size: 12,
                style_class: 'nn-cc-chevron', y_align: Clutter.ActorAlign.CENTER }));
        textBtn.set_child(box);
        textBtn.connect('clicked', onOpen ?? onToggle);
        row.add_child(textBtn);
        parent.add_child(row);

        let item = {
            row, circle, icon,
            update: (on, subText, iconName = null) => {
                if (iconName) icon.icon_name = iconName;
                circle.set_style(on ? onStyle() : null);
                if (on) circle.add_style_class_name('nn-cc-circle-on');
                else circle.remove_style_class_name('nn-cc-circle-on');
                sub.set_text(subText);
            },
            setEnabled: enabled => {
                circle.reactive = enabled;
                row.opacity = enabled ? 255 : 110;
            },
        };
        return item;
    },

    // A square quick tile: icon in a circle, name, state.
    _ccTile(parent, name, onClick) {
        let btn = new St.Button({ style_class: 'nn-cc-card nn-cc-tile', x_expand: true, y_expand: true,
            can_focus: true, accessible_name: name, reactive: !!onClick });
        let col = new St.BoxLayout({ vertical: true, x_expand: true });
        let circle = new St.Bin({ style_class: 'nn-cc-circle nn-cc-circle-sm', x_align: Clutter.ActorAlign.START });
        let icon = new St.Icon({ icon_size: 15 });
        circle.set_child(icon);
        col.add_child(circle);
        col.add_child(new St.Widget({ y_expand: true }));
        col.add_child(label(name, 'nn-cc-name'));
        let sub = label('', 'nn-cc-sub');
        col.add_child(sub);
        btn.set_child(col);
        if (onClick) {
            btn.connect('clicked', onClick);
            addPressFeedback(btn, 0.95);
        } else {
            btn.opacity = 110;
        }
        parent.add_child(btn);
        return {
            btn,
            update: (on, subText, iconName = null) => {
                if (iconName) icon.icon_name = iconName;
                circle.set_style(on ? onStyle() : null);
                if (on) btn.add_style_class_name('nn-cc-tile-on');
                else btn.remove_style_class_name('nn-cc-tile-on');
                sub.set_text(subText);
            },
        };
    },

    // A Control Center pill slider: GNOME's own Slider (drag, scroll and
    // keyboard for free) themed thick, with its icon inside on the left.
    _ccSlider(parent, value, onChange, onIcon = null) {
        let row = new St.BoxLayout({ style_class: 'nn-cc-slider-row', x_expand: true });
        // Fixed layout: the slider is bound to the stack's size and the icon
        // button sits at a fixed inset (BinLayout ignores child alignment here).
        let stack = new St.Widget({ layout_manager: new Clutter.FixedLayout(), x_expand: true, height: 34 });
        let slider = new Slider.Slider(Math.max(0, Math.min(1, value)));
        slider.add_style_class_name('nn-cc-slider');
        slider.set_style(`-barlevel-active-background-color: ${accentHex()};`);
        slider.add_constraint(new Clutter.BindConstraint({ source: stack, coordinate: Clutter.BindCoordinate.SIZE }));
        stack.add_child(slider);
        let btn = new St.Button({ style_class: 'nn-cc-slider-btn', x: 5, y: 4, can_focus: !!onIcon });
        let icon = new St.Icon({ icon_size: 15, style_class: 'nn-cc-slider-icon' });
        btn.set_child(icon);
        if (onIcon) btn.connect('clicked', onIcon);
        stack.add_child(btn);
        row.add_child(stack);
        let val = label('', 'nn-cc-slider-val');
        row.add_child(val);
        parent.add_child(row);

        let item = { row, slider, icon, btn, val, dragging: false, syncing: false };
        slider.connect('drag-begin', () => { item.dragging = true; });
        slider.connect('drag-end', () => { item.dragging = false; });
        slider.connect('notify::value', () => {
            if (item.syncing)
                return;
            let v = Math.round(slider.value * 100);
            val.set_text(`${v}%`);
            onChange(v);
            item.onValue?.(v);
        });
        item.set = v => {
            if (item.dragging)
                return;
            item.syncing = true;
            slider.value = Math.max(0, Math.min(1, v / 100));
            item.syncing = false;
            val.set_text(`${Math.round(v)}%`);
        };
        return item;
    },

    // A labelled usage bar. The fill is scaled, never resized, so a refresh
    // costs one transform per meter.
    _ccMeter(parent, name) {
        let row = new St.BoxLayout({ style_class: 'nn-cc-meter', x_expand: true });
        row.add_child(label(name, 'nn-cc-meter-name'));
        let track = new St.Widget({ style_class: 'nn-cc-track', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let fill = new St.Widget({ style_class: 'nn-cc-fill', x_expand: true, y_expand: true });
        fill.set_pivot_point(0, 0.5);
        fill.scale_x = 0;
        track.add_child(fill);
        row.add_child(track);
        let val = label('', 'nn-cc-meter-val');
        row.add_child(val);
        parent.add_child(row);
        return { fill, val, hot: null };
    },

    _setMeter(m, pct, animate) {
        if (!m) return;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        m.val.set_text(`${pct}%`);
        let hot = pct >= HOT;
        if (hot !== m.hot) {
            m.hot = hot;
            m.fill.set_style(`background-color: ${hot ? '#ff9f0a' : accentHex()};`);
        }
        m.fill.remove_transition('scale-x');
        if (animate && St.Settings.get().enable_animations)
            m.fill.ease({ scale_x: pct / 100, duration: 500, mode: Clutter.AnimationMode.EASE_OUT_CUBIC });
        else
            m.fill.scale_x = pct / 100;
    },

    _updateSystemTabMeters(animate = true) {
        if (this._destroyed || !this._trayMeters) return;
        let m = this._trayMeters;
        this._setMeter(m.cpu, this._system.getCpuUsage(), animate);
        this._setMeter(m.ram, this._system.getRamUsage(), animate);
        this._setMeter(m.disk, this._system.getDiskUsage(), animate);
        m.net.down.set_text(this._system.getNetDownLabel());
        m.net.up.set_text(this._system.getNetUpLabel());
        this._syncTraySliders();
    },

    _nightLightSettings() {
        if (this._nightLight === undefined) {
            let src = Gio.SettingsSchemaSource.get_default();
            this._nightLight = src?.lookup(NIGHT_LIGHT_SCHEMA, true)
                ? new Gio.Settings({ schema_id: NIGHT_LIGHT_SCHEMA }) : null;
        }
        return this._nightLight;
    },

    _toggleHotspot() {
        let info = this._system.getWifiInfo();
        if (!info.enabled)
            return;
        let ui = this._trayUi;
        ui?.conn.hotspot.update(!info.hotspot, info.hotspot ? 'Stopping…' : 'Starting…');
        this._system.setHotspotEnabled(!info.hotspot, (ok, detail) => {
            if (ok && detail && detail.ssid)
                this._notifyTransient('Hotspot is on',
                    `Network: ${detail.ssid}\nPassword: ${detail.password}`);
            // This adapter can only share a channel for AP+client on 2.4 GHz.
            if (ok && detail && detail.concurrent === false)
                Main.notify('NotchNux Hotspot',
                    'Wi-Fi was on a 5 GHz channel, which can\'t host a hotspot. ' +
                    'The hotspot started on 2.4 GHz and the Wi-Fi connection was dropped ' +
                    '(this adapter has a single radio).');
            this._scheduleTrayReRender();
        });
    },

    // Restyle every toggle from live state. Cheap; called after any change.
    _syncTrayToggles() {
        let ui = this._trayUi;
        if (!ui) return;
        let wifi = this._system.getWifiInfo();
        let c = ui.conn;
        c.wifi.setEnabled(wifi.available);
        c.wifi.update(wifi.enabled && !wifi.hotspot,
            !wifi.available ? 'Unavailable' : !wifi.enabled ? 'Off'
                : wifi.hotspot ? 'Sharing as hotspot' : wifi.connected ? (wifi.ssid ?? 'Connected') : 'Not connected',
            wifi.enabled ? 'network-wireless-signal-excellent-symbolic' : 'network-wireless-offline-symbolic');

        let btOn = this._system.getBluetoothPowered();
        let connected = this._system.getBluetoothDevices(() => this._queueTrayCardsRefresh()).filter(d => d.connected);
        c.bt.update(btOn,
            !btOn ? 'Off' : connected.length === 1 ? connected[0].name
                : connected.length ? `${connected.length} connected` : 'On',
            btOn ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic');

        c.hotspot.setEnabled(wifi.available && wifi.enabled);
        c.hotspot.update(wifi.hotspot, wifi.hotspot ? 'Sharing' : 'Off', 'network-wireless-hotspot-symbolic');

        let air = this._system.getAirplaneMode();
        c.air.update(air, air ? 'On' : 'Off', 'airplane-mode-symbolic');

        let silent = !this._notificationSettings().get_boolean('show-banners');
        ui.tiles.dnd.update(silent, silent ? 'On' : 'Off',
            silent ? 'notifications-disabled-symbolic' : 'preferences-system-notifications-symbolic');
        let night = this._nightLightSettings();
        let nightOn = !!night?.get_boolean('night-light-enabled');
        ui.tiles.night.update(nightOn, night ? (nightOn ? 'On' : 'Off') : 'Unavailable', 'night-light-symbolic');
    },

    _syncTraySliders() {
        let s = this._trayUi?.sliders;
        if (!s) return;
        let muted = this._system.isMuted;
        let vol = this._system.volume;
        s.volume.set(muted ? 0 : vol);
        s.volume.icon.icon_name = muted || vol === 0 ? 'audio-volume-muted-symbolic'
            : vol < 34 ? 'audio-volume-low-symbolic'
            : vol < 67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        let b = this._system.getBrightness();
        s.bright.row.visible = b !== null;
        if (b !== null)
            s.bright.set(b);
    },

    // (Re)build the DEVICES list from the current snapshots. Cheap: a few rows.
    _fillTrayDevices() {
        let ui = this._trayUi;
        if (!ui) return;
        let bat = this._system.getBatteryInfo();
        let level = Math.max(0, Math.min(100, Math.round((bat.percentage ?? 100) / 10) * 10));
        let batIcon = `battery-level-${level}${bat.isCharging ? (level === 100 ? '-charged' : '-charging') : ''}-symbolic`;
        let rows = [{ name: 'This device', icon: batIcon, pct: bat.percentage }];
        for (let d of this._system.getBluetoothDevices(() => this._queueTrayCardsRefresh())) {
            rows.push({ name: d.name, icon: d.icon, pct: d.percentage,
                status: d.dbusPath ? (d.connected ? 'Connected' : 'Paired') : null,
                dbusPath: d.dbusPath, connected: d.connected, bluetooth: !!d.dbusPath });
        }
        // Connected accessories first, then paired ones.
        rows = [rows[0], ...rows.slice(1).sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0))];
        let sig = JSON.stringify(rows.map(r => [r.name, r.pct, r.status]));
        if (sig === ui.devSig)
            return;
        ui.devSig = sig;
        ui.devList.destroy_all_children();
        if (rows.length === 1)
            rows.push({ name: 'No accessories', icon: 'bluetooth-disconnected-symbolic', pct: null });
        for (let d of rows.slice(0, DEV_CAP))
            ui.devList.add_child(this._buildDeviceRow(d));
        let extra = rows.length - DEV_CAP;
        if (extra > 0)
            ui.devList.add_child(this._buildMoreRow(`+${extra} more…`, () => this._openBluetoothScanOverlay()));
    },

    // Refresh the toggles and device list on the next idle, coalescing bursts
    // of BlueZ / UPower / NetworkManager change callbacks.
    _queueTrayCardsRefresh() {
        if (this._trayCardsId || this._destroyed)
            return;
        this._trayCardsId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._trayCardsId = 0;
            if (!this._trayUi || !this.isExpanded || this._activeTab !== 'system')
                return GLib.SOURCE_REMOVE;
            this._syncTrayToggles();
            let before = this._trayUi.devSig;
            this._fillTrayDevices();
            if (this._trayUi.devSig !== before)
                this._resizeToContent();
            return GLib.SOURCE_REMOVE;
        });
    },
};

export function installTray(proto) {
    for (let [name, fn] of Object.entries(TrayFeatures))
        proto[name] = fn;
}
