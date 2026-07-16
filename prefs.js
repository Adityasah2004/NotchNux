// Preferences window for NotchNux.
//
// GNOME launches this in a *separate* GTK4/libadwaita process (from the
// Extensions app, or `gnome-extensions prefs notchnux@...`, or the notch's
// gear button via extension.openPreferences()). Because it's a different
// process it can't touch the running shell's actors — instead it reads and
// writes the same JSON document the shell reads (~/.config/notchnux/config.json)
// through the shared ConfigStore, and the shell watches that file and re-applies
// changes live. So every mutation here is a ConfigStore setter that persists
// immediately; the notch updates itself when the file changes.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { ConfigStore, TAB_DEFS, FEATURE_DEFS, normalizeHex } from './src/helpers/config.js';

// Same preset swatches offered by the old in-notch Appearance section.
const ACCENT_PRESETS = ['#7aa2ff', '#a78bfa', '#f472b6', '#f87171', '#fb923c', '#e8b06a', '#34d399', '#22d3ee'];

export default class NotchNuxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const config = new ConfigStore();

        const page = new Adw.PreferencesPage({
            title: 'NotchNux',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        this._addAppearanceGroup(page, config);
        this._addTabsGroup(page, config);
        this._addFeaturesGroup(page, config);
        this._addQuickShareGroup(page);
        this._addSystemGroup(page);

        window.set_default_size(560, 720);
    }

    // ---- Appearance: accent colour ----
    _addAppearanceGroup(page, config) {
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Accent colour applied across the dashboard. Changes take effect instantly.',
        });
        page.add(group);

        // Preset swatches. Clicking one commits it and syncs the picker/entry.
        const swatchRow = new Adw.ActionRow({ title: 'Presets' });
        const swatchBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        // The colour picker and hex entry are declared first so the swatch
        // handlers (created in the loop) can update them.
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({ with_alpha: false }),
            valign: Gtk.Align.CENTER,
        });
        const hexEntry = new Gtk.Entry({
            max_length: 7,
            width_chars: 8,
            valign: Gtk.Align.CENTER,
            text: config.accent,
        });

        const applyAccent = (hex, { syncEntry = true, syncPicker = true } = {}) => {
            const norm = normalizeHex(hex);
            if (!norm)
                return;
            config.setAccent(norm);
            if (syncEntry)
                hexEntry.set_text(norm);
            if (syncPicker) {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(norm))
                    colorButton.set_rgba(rgba);
            }
        };

        for (const hex of ACCENT_PRESETS) {
            const btn = new Gtk.Button({
                valign: Gtk.Align.CENTER,
                tooltip_text: hex,
            });
            btn.add_css_class('circular');
            // Colour the button face via inline CSS. We paint the swatch with
            // background-image (a flat gradient) instead of `background`, because
            // Adwaita's own button style sets a background-image gradient that
            // would otherwise paint over a plain `background` and leave the
            // swatch looking like an empty grey button. USER priority beats the
            // theme so the colour actually shows.
            const provider = new Gtk.CssProvider();
            provider.load_from_string(
                `button {` +
                `  background-image: image(${hex});` +
                `  background-color: ${hex};` +
                `  min-width: 22px; min-height: 22px;` +
                `  border: none; box-shadow: none;` +
                `}`);
            btn.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
            btn.connect('clicked', () => applyAccent(hex));
            swatchBox.append(btn);
        }
        swatchRow.add_suffix(swatchBox);
        group.add(swatchRow);

        // Native colour picker row.
        const pickerRow = new Adw.ActionRow({
            title: 'Custom colour',
            subtitle: 'Pick any colour with the system dialog',
        });
        {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(config.accent))
                colorButton.set_rgba(rgba);
        }
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.get_rgba();
            const to255 = (v) => Math.round(v * 255);
            const hex = '#' + [c.red, c.green, c.blue]
                .map((v) => to255(v).toString(16).padStart(2, '0')).join('');
            applyAccent(hex, { syncPicker: false });
        });
        pickerRow.add_suffix(colorButton);
        group.add(pickerRow);

        // Manual hex entry row.
        const hexRow = new Adw.ActionRow({
            title: 'Hex value',
            subtitle: 'e.g. #7aa2ff',
        });
        const commitHex = () => {
            const norm = normalizeHex(hexEntry.get_text());
            if (norm) {
                hexEntry.remove_css_class('error');
                applyAccent(norm, { syncEntry: false });
            } else {
                hexEntry.add_css_class('error');
            }
        };
        hexEntry.connect('activate', commitHex);
        // Also commit when focus leaves the entry.
        const focusCtl = new Gtk.EventControllerFocus();
        focusCtl.connect('leave', commitHex);
        hexEntry.add_controller(focusCtl);
        hexRow.add_suffix(hexEntry);
        group.add(hexRow);
    }

    // ---- Tabs: enable toggles + drag reorder ----
    _addTabsGroup(page, config) {
        const group = new Adw.PreferencesGroup({
            title: 'Tabs',
            description: 'Toggle a tab off to hide it from the carousel. Drag to reorder.',
        });
        page.add(group);

        // A ListBox gives us native row drag-and-drop; each row carries its tab
        // id and an enable switch. Reordering rewrites config.tabOrder.
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        listBox.add_css_class('boxed-list');
        group.add(listBox);

        const rowsById = new Map();

        const commitOrder = () => {
            const order = [];
            let child = listBox.get_first_child();
            while (child) {
                if (child._tabId)
                    order.push(child._tabId);
                child = child.get_next_sibling();
            }
            config.setTabOrder(order);
        };

        for (const id of config.tabOrder) {
            const def = TAB_DEFS.find((t) => t.id === id);
            if (!def)
                continue;

            const row = new Adw.ActionRow({
                title: def.label,
            });
            row._tabId = id;

            // Drag handle (visual affordance).
            const handle = new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                valign: Gtk.Align.CENTER,
            });
            handle.add_css_class('dim-label');
            row.add_prefix(handle);

            const icon = new Gtk.Image({ icon_name: def.icon, valign: Gtk.Align.CENTER });
            row.add_prefix(icon);

            const toggle = new Gtk.Switch({
                active: config.isTabEnabled(id),
                valign: Gtk.Align.CENTER,
            });
            toggle.connect('notify::active', () => {
                config.setTabEnabled(id, toggle.get_active());
            });
            row.add_suffix(toggle);
            row.activatable_widget = toggle;

            this._makeRowDraggable(row, listBox, rowsById, commitOrder);
            rowsById.set(id, row);
            listBox.append(row);
        }
    }

    // Wire up drag-and-drop reordering for a tab row. On drop we move the
    // dragged row above the drop target and persist the new order.
    _makeRowDraggable(row, listBox, rowsById, commitOrder) {
        // Drag source: carry the tab id as a string.
        const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        dragSource.connect('prepare', () => {
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(row._tabId);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', (_src, drag) => {
            // Show a small drag icon so the gesture reads clearly.
            const icon = Gtk.DragIcon.get_for_drag(drag);
            const label = new Gtk.Label({ label: row.get_title(), margin_start: 8, margin_end: 8 });
            icon.set_child(label);
        });
        row.add_controller(dragSource);

        // Drop target: accept a tab id and reorder.
        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (_tgt, sourceId) => {
            if (!sourceId || sourceId === row._tabId)
                return false;
            const sourceRow = rowsById.get(sourceId);
            if (!sourceRow)
                return false;
            const targetIndex = row.get_index();
            listBox.remove(sourceRow);
            listBox.insert(sourceRow, targetIndex);
            commitOrder();
            return true;
        });
        row.add_controller(dropTarget);
    }

    // ---- Features: per-feature switches ----
    _addFeaturesGroup(page, config) {
        const group = new Adw.PreferencesGroup({
            title: 'Features',
            description: 'Turn individual features on or off.',
        });
        page.add(group);

        for (const f of FEATURE_DEFS) {
            const row = new Adw.SwitchRow({
                title: f.label,
                subtitle: f.description,
                active: config.isFeatureEnabled(f.id),
            });
            row.connect('notify::active', () => {
                config.setFeatureEnabled(f.id, row.get_active());
            });
            group.add(row);
        }
    }

    // ---- Quick Share (GSConnect) ----
    // The Shelf's "Send" action sends files to paired devices through GSConnect.
    // This group surfaces whether GSConnect is available and which devices are
    // reachable, and links out to GSConnect's own settings to pair a new one.
    // We talk to the same session-bus service the shell uses.
    _addQuickShareGroup(page) {
        const GSC_NAME = 'org.gnome.Shell.Extensions.GSConnect';
        const GSC_BASE = '/org/gnome/Shell/Extensions/GSConnect';

        const group = new Adw.PreferencesGroup({
            title: 'Quick Share',
            description: 'Send files from the Shelf to your phone or another device via GSConnect (the Linux “nearby share”).',
        });
        page.add(group);

        // Determine service availability + reachable devices synchronously; this
        // runs once when the prefs window is built.
        let serviceUp = false;
        let devices = [];
        try {
            const bus = Gio.DBus.session;
            const owner = bus.call_sync(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'NameHasOwner', new GLib.Variant('(s)', [GSC_NAME]),
                new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null);
            serviceUp = owner.deepUnpack()[0];

            if (serviceUp) {
                const reply = bus.call_sync(
                    GSC_NAME, GSC_BASE, 'org.freedesktop.DBus.ObjectManager',
                    'GetManagedObjects', null,
                    new GLib.VariantType('(a{oa{sa{sv}}})'),
                    Gio.DBusCallFlags.NONE, -1, null);
                const [objects] = reply.deepUnpack();
                for (const path in objects) {
                    const dev = objects[path]['org.gnome.Shell.Extensions.GSConnect.Device'];
                    if (!dev) continue;
                    devices.push({
                        name: dev['Name'] ? dev['Name'].deepUnpack() : 'Device',
                        type: dev['Type'] ? dev['Type'].deepUnpack() : 'phone',
                        connected: dev['Connected'] ? dev['Connected'].deepUnpack() : false,
                        paired: dev['Paired'] ? dev['Paired'].deepUnpack() : false,
                    });
                }
            }
        } catch (e) {
            // Leave serviceUp=false; the status row below explains the situation.
        }

        // Status row.
        const statusRow = new Adw.ActionRow({
            title: 'GSConnect',
            subtitle: serviceUp ? 'Running' : 'Not detected',
        });
        statusRow.add_prefix(new Gtk.Image({
            icon_name: serviceUp ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        group.add(statusRow);

        if (serviceUp) {
            const iconFor = (t) => t === 'phone' ? 'phone-symbolic'
                : t === 'tablet' ? 'tablet-symbolic' : 'computer-symbolic';
            if (devices.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: 'No paired devices',
                    subtitle: 'Pair a device in GSConnect to send files to it.',
                });
                group.add(emptyRow);
            } else {
                for (const d of devices) {
                    const ready = d.connected && d.paired;
                    const row = new Adw.ActionRow({
                        title: d.name,
                        subtitle: ready ? 'Ready to receive'
                            : !d.paired ? 'Not paired' : 'Not connected',
                    });
                    row.add_prefix(new Gtk.Image({ icon_name: iconFor(d.type), valign: Gtk.Align.CENTER }));
                    if (ready) {
                        row.add_suffix(new Gtk.Image({ icon_name: 'emblem-ok-symbolic', valign: Gtk.Align.CENTER }));
                    }
                    group.add(row);
                }
            }
        } else {
            const helpRow = new Adw.ActionRow({
                title: 'GSConnect is not running',
                subtitle: 'Install & enable the GSConnect extension to send Shelf files to your devices.',
            });
            group.add(helpRow);
        }

        // Open GSConnect's own preferences to manage pairing.
        const manageRow = new Adw.ActionRow({
            title: 'Manage devices',
            subtitle: 'Open GSConnect settings to pair or configure a device',
            activatable: true,
        });
        manageRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER }));
        manageRow.connect('activated', () => {
            // Open GSConnect's own preferences via the Extensions app. Its UUID
            // is the well-known gsconnect@andyholmes.github.io.
            try {
                Gio.Subprocess.new(
                    ['gnome-extensions', 'prefs', 'gsconnect@andyholmes.github.io'],
                    Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e, 'NotchNux: failed to open GSConnect settings');
            }
        });
        group.add(manageRow);
    }

    // ---- System shortcuts ----
    _addSystemGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: 'System',
            description: 'Open the matching GNOME settings panels.',
        });
        page.add(group);

        const openControlCenter = (args) => {
            try {
                Gio.Subprocess.new(['gnome-control-center', ...args], Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e, 'NotchNux: failed to open GNOME Settings');
            }
        };

        const accountsRow = new Adw.ActionRow({
            title: 'Online Accounts',
            subtitle: 'Add a Google account for calendar sync',
            activatable: true,
        });
        accountsRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER }));
        accountsRow.connect('activated', () => openControlCenter(['online-accounts']));
        group.add(accountsRow);

        const locationRow = new Adw.ActionRow({
            title: 'Location Privacy',
            subtitle: 'Allow location access for live weather',
            activatable: true,
        });
        locationRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER }));
        locationRow.connect('activated', () => openControlCenter(['privacy', 'location']));
        group.add(locationRow);
    }
}
