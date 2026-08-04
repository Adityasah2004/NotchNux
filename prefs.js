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

import { ConfigStore, TAB_DEFS, FEATURE_DEFS, WALLPAPER_DEFAULTS, ENHANCE_AUTO, ENHANCE_RANGE, normalizeHex, BLUR_PRESETS, BLUR_RADIUS_RANGE, BLUR_DEFAULTS } from './src/helpers/config.js';

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
        this._addBlurGroup(page, config);
        this._addWallpaperGroup(page, config, window);
        this._addTabsGroup(page, config);
        this._addFeaturesGroup(page, config);
        this._addTrayMirrorGroup(page, config);
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

    // ---- Glass & Blur ----
    // Real gaussian backdrop blur behind the notch (Shell.BlurEffect). A master
    // switch, a glass-style preset, and independent blur strength for the
    // collapsed pill vs the open dashboard. Every control persists through
    // config.setBlur(); the shell watches the file and re-applies live.
    _addBlurGroup(page, config) {
        const group = new Adw.PreferencesGroup({
            title: 'Glass & Blur',
            description: 'Frost the backdrop behind the notch. Apple/Samsung-style glass presets, with separate blur strength for the collapsed pill and the open dashboard.',
        });
        page.add(group);

        // Master enable. When off, the rows below are dimmed but still visible so
        // the user can see what they'll get.
        const enableRow = new Adw.SwitchRow({
            title: 'Enable blur',
            subtitle: 'Composite a live gaussian blur of the wallpaper/windows behind the panel.',
            active: config.blur.enabled,
        });
        group.add(enableRow);

        // Glass preset. ComboRow over BLUR_PRESETS; the model index maps to the
        // preset id.
        const presetIds = BLUR_PRESETS.map(p => p.id);
        const presetModel = new Gtk.StringList();
        for (const p of BLUR_PRESETS)
            presetModel.append(p.label);
        const presetRow = new Adw.ComboRow({
            title: 'Glass style',
            subtitle: BLUR_PRESETS[Math.max(0, presetIds.indexOf(config.blur.preset))].description,
            model: presetModel,
            selected: Math.max(0, presetIds.indexOf(config.blur.preset)),
        });
        group.add(presetRow);
        // Guard so programmatic slider moves (from applying a preset or a reset)
        // don't each fire a separate config write on top of the batched one.
        let syncing = false;
        presetRow.connect('notify::selected', () => {
            if (syncing) return;
            const p = BLUR_PRESETS[presetRow.get_selected()];
            if (!p) return;
            presetRow.set_subtitle(p.description);
            // A preset is a full look: commit its id *and* its recommended
            // strengths in one write, then move the sliders to match.
            config.setBlur({
                preset: p.id,
                collapsedRadius: p.collapsedRadius,
                expandedRadius: p.expandedRadius,
            });
            syncing = true;
            collapsedRow.set_value(p.collapsedRadius);
            expandedRow.set_value(p.expandedRadius);
            syncing = false;
        });

        // Per-state radius sliders. SpinRow over the shared range; step of 2 so
        // the value moves in visible increments.
        const collapsedRow = new Adw.SpinRow({
            title: 'Collapsed blur',
            subtitle: 'Blur strength while the notch is a pill.',
            adjustment: new Gtk.Adjustment({
                lower: BLUR_RADIUS_RANGE.min,
                upper: BLUR_RADIUS_RANGE.max,
                step_increment: 2,
                page_increment: 8,
                value: config.blur.collapsedRadius,
            }),
        });
        group.add(collapsedRow);
        collapsedRow.connect('notify::value', () => {
            if (syncing) return;
            config.setBlur({ collapsedRadius: collapsedRow.get_value() });
        });

        const expandedRow = new Adw.SpinRow({
            title: 'Expanded blur',
            subtitle: 'Blur strength while the dashboard is open.',
            adjustment: new Gtk.Adjustment({
                lower: BLUR_RADIUS_RANGE.min,
                upper: BLUR_RADIUS_RANGE.max,
                step_increment: 2,
                page_increment: 8,
                value: config.blur.expandedRadius,
            }),
        });
        group.add(expandedRow);
        expandedRow.connect('notify::value', () => {
            if (syncing) return;
            config.setBlur({ expandedRadius: expandedRow.get_value() });
        });

        // Reset the whole glass/blur group back to shipped defaults (Liquid
        // Glass, 18/36) in one write, then re-sync every widget. Leaves the
        // master enable switch untouched — resetting the *look*, not turning it
        // off. Wrapped in the same guard so the slider/combo moves don't each
        // re-write config on top of the batched reset.
        const resetRow = new Adw.ActionRow({
            title: 'Reset glass & blur',
            subtitle: 'Restore the default style and blur strengths.',
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset to defaults',
            valign: Gtk.Align.CENTER,
        });
        resetBtn.add_css_class('flat');
        resetRow.add_suffix(resetBtn);
        resetRow.set_activatable_widget(resetBtn);
        group.add(resetRow);
        resetBtn.connect('clicked', () => {
            config.setBlur({
                preset: BLUR_DEFAULTS.preset,
                collapsedRadius: BLUR_DEFAULTS.collapsedRadius,
                expandedRadius: BLUR_DEFAULTS.expandedRadius,
            });
            syncing = true;
            const idx = Math.max(0, presetIds.indexOf(BLUR_DEFAULTS.preset));
            presetRow.set_selected(idx);
            presetRow.set_subtitle(BLUR_PRESETS[idx].description);
            collapsedRow.set_value(BLUR_DEFAULTS.collapsedRadius);
            expandedRow.set_value(BLUR_DEFAULTS.expandedRadius);
            syncing = false;
        });

        // Commit the toggle and gate the dependent rows on it.
        const syncSensitivity = () => {
            const on = enableRow.get_active();
            presetRow.set_sensitive(on);
            collapsedRow.set_sensitive(on);
            expandedRow.set_sensitive(on);
            resetRow.set_sensitive(on);
        };
        enableRow.connect('notify::active', () => {
            config.setBlur({ enabled: enableRow.get_active() });
            syncSensitivity();
        });
        syncSensitivity();
    }

    // ---- Wallpaper: rotate through a folder of images ----
    // GNOME/Wayland only accepts static image wallpapers, so this rotates
    // JPG/PNG/WebP/etc. through the desktop background GSettings. Every control
    // writes straight back through config.setWallpaper(); the shell watches the
    // file and re-applies the rotation live. The dashboard's Wallpaper tab is
    // the visual switcher; this group is where the behaviour is configured.
    _addWallpaperGroup(page, config, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Wallpaper',
            description: 'Rotate the desktop wallpaper through a folder of images. Only still images are supported — GNOME on Wayland can’t render video or live wallpapers behind the desktop.',
        });
        page.add(group);

        const wp = config.wallpaper;
        // Shared patch helper: merge one field and persist.
        const patch = (p) => config.setWallpaper(p);

        // Folder chooser. Shows the current folder as the subtitle.
        const folderRow = new Adw.ActionRow({
            title: 'Folder',
            subtitle: wp.folder || 'No folder selected',
        });
        const folderBtn = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose wallpaper folder',
        });
        folderBtn.add_css_class('flat');
        folderBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({ title: 'Choose wallpaper folder' });
            if (wp.folder) {
                try {
                    dialog.set_initial_folder(Gio.File.new_for_path(wp.folder));
                } catch (e) {}
            }
            dialog.select_folder(window, null, (dlg, res) => {
                try {
                    const file = dlg.select_folder_finish(res);
                    if (file) {
                        const path = file.get_path();
                        patch({ folder: path });
                        folderRow.set_subtitle(path);
                    }
                } catch (e) {
                    // User cancelled — dismissal raises a Gtk.DialogError; ignore.
                }
            });
        });
        folderRow.add_suffix(folderBtn);
        folderRow.activatable_widget = folderBtn;
        group.add(folderRow);

        // Master on/off for the timer.
        const rotateRow = new Adw.SwitchRow({
            title: 'Rotate automatically',
            subtitle: 'Switch to the next wallpaper on a timer',
            active: wp.rotationEnabled,
        });
        rotateRow.connect('notify::active', () => patch({ rotationEnabled: rotateRow.get_active() }));
        group.add(rotateRow);

        // Interval: a value spinner + a unit dropdown (seconds/minutes/hours).
        // We store seconds; the UI picks the friendliest unit for the stored
        // value so re-opening prefs shows "5 minutes", not "300 seconds".
        const UNITS = [
            { label: 'seconds', factor: 1 },
            { label: 'minutes', factor: 60 },
            { label: 'hours', factor: 3600 },
        ];
        // Choose the largest unit that divides the stored seconds cleanly.
        let unitIdx = 1;
        for (let i = UNITS.length - 1; i >= 0; i--) {
            if (wp.intervalSec % UNITS[i].factor === 0) { unitIdx = i; break; }
        }
        const intervalRow = new Adw.ActionRow({
            title: 'Interval',
            subtitle: 'How long each wallpaper stays before switching',
        });
        const intervalBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 100000, step_increment: 1, page_increment: 10,
                value: Math.max(1, Math.round(wp.intervalSec / UNITS[unitIdx].factor)),
            }),
            valign: Gtk.Align.CENTER,
        });
        const unitDrop = Gtk.DropDown.new_from_strings(UNITS.map(u => u.label));
        unitDrop.set_selected(unitIdx);
        unitDrop.set_valign(Gtk.Align.CENTER);
        const commitInterval = () => {
            const factor = UNITS[unitDrop.get_selected()].factor;
            const seconds = Math.max(5, Math.round(spin.get_value()) * factor);
            patch({ intervalSec: seconds });
        };
        spin.connect('value-changed', commitInterval);
        unitDrop.connect('notify::selected', commitInterval);
        intervalBox.append(spin);
        intervalBox.append(unitDrop);
        intervalRow.add_suffix(intervalBox);
        group.add(intervalRow);

        // Order: sequential vs random.
        const orderRow = new Adw.ComboRow({
            title: 'Order',
            subtitle: 'Play the folder in order, or shuffle',
            model: Gtk.StringList.new(['Sequential', 'Random']),
            selected: wp.order === 'random' ? 1 : 0,
        });
        orderRow.connect('notify::selected', () => {
            patch({ order: orderRow.get_selected() === 1 ? 'random' : 'sequential' });
        });
        group.add(orderRow);

        // Rotate portrait images so they fill a landscape screen. EXIF
        // orientation is honoured, and only portrait images are turned; the
        // originals are never modified (a rotated copy is cached and used).
        const landscapeRow = new Adw.SwitchRow({
            title: 'Rotate portrait to landscape',
            subtitle: 'Turn portrait images 90° so they fit a landscape display',
            active: wp.autoLandscape,
        });
        landscapeRow.connect('notify::active', () => patch({ autoLandscape: landscapeRow.get_active() }));
        group.add(landscapeRow);

        // Sharpen + grade images for a crisper desktop. Originals are never
        // modified; an enhanced copy is cached and applied. The expander's own
        // switch is the master on/off; inside, Auto uses tuned defaults while
        // Manual reveals sliders for sharpness, contrast and saturation.
        const enhanceRow = new Adw.ExpanderRow({
            title: 'Enhance for crispness',
            subtitle: 'Sharpen and boost contrast so wallpapers render crisper and more detailed',
            show_enable_switch: true,
            enable_expansion: wp.enhance,
        });
        enhanceRow.connect('notify::enable-expansion', () => patch({ enhance: enhanceRow.get_enable_expansion() }));
        group.add(enhanceRow);

        // Auto vs Manual. In Auto the sliders are hidden and the tuned defaults
        // apply; switching to Manual reveals and enables them.
        const modeRow = new Adw.ComboRow({
            title: 'Enhancement',
            subtitle: 'Auto uses tuned defaults; Manual lets you dial it in',
            model: Gtk.StringList.new(['Auto', 'Manual']),
            selected: wp.enhanceMode === 'manual' ? 1 : 0,
        });
        enhanceRow.add_row(modeRow);

        // Helper: build a slider row backed by a Gtk.Scale over a numeric field.
        // The stored value shows directly on the scale with two decimals.
        // Returns the row so callers can show/hide it per mode.
        const makeSlider = (title, subtitle, key, range, current) => {
            const row = new Adw.ActionRow({ title, subtitle });
            const adj = new Gtk.Adjustment({
                lower: range.min, upper: range.max,
                step_increment: 0.01, page_increment: 0.1,
                value: current,
            });
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment: adj,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                digits: 2,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                width_request: 200,
            });
            // Only persist once the drag settles / the user stops, not on every
            // pixel of motion — keeps the config writes (and cache rebuilds) sane.
            let pending = 0;
            adj.connect('value-changed', () => {
                if (pending) GLib.Source.remove(pending);
                pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    pending = 0;
                    patch({ [key]: adj.get_value() });
                    return GLib.SOURCE_REMOVE;
                });
            });
            row.add_suffix(scale);
            enhanceRow.add_row(row);
            return row;
        };

        const sharpenRow = makeSlider(
            'Sharpness', 'Edge detail added back (unsharp mask)',
            'enhanceSharpen', ENHANCE_RANGE.sharpen, wp.enhanceSharpen);
        const contrastRow = makeSlider(
            'Contrast', 'Push darks down and lights up',
            'enhanceContrast', ENHANCE_RANGE.contrast, wp.enhanceContrast);
        const saturationRow = makeSlider(
            'Saturation', 'Deepen colours',
            'enhanceSaturation', ENHANCE_RANGE.saturation, wp.enhanceSaturation);

        // Show the sliders only in Manual mode.
        const syncManual = () => {
            const manual = modeRow.get_selected() === 1;
            sharpenRow.visible = manual;
            contrastRow.visible = manual;
            saturationRow.visible = manual;
        };
        modeRow.connect('notify::selected', () => {
            patch({ enhanceMode: modeRow.get_selected() === 1 ? 'manual' : 'auto' });
            syncManual();
        });
        syncManual();

        // Auto-pause toggles.
        const batteryRow = new Adw.SwitchRow({
            title: 'Pause on battery',
            subtitle: 'Stop rotating while running on battery power',
            active: wp.pauseOnBattery,
        });
        batteryRow.connect('notify::active', () => patch({ pauseOnBattery: batteryRow.get_active() }));
        group.add(batteryRow);

        const fsRow = new Adw.SwitchRow({
            title: 'Pause in fullscreen',
            subtitle: 'Stop rotating while an app is fullscreen (games, video)',
            active: wp.pauseOnFullscreen,
        });
        fsRow.connect('notify::active', () => patch({ pauseOnFullscreen: fsRow.get_active() }));
        group.add(fsRow);
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

    // ---- Mirrored indicators (Tray tab) ----
    // Lets the user choose which top-bar / Quick Settings indicators the Tray
    // tab's mirror row shows. This process can't read the live shell's status
    // area, so the shell publishes the list of indicators it can mirror (as
    // { id, label }) into the config; we render a switch per entry and write the
    // per-id enable map straight back. The shell watches the file and re-renders.
    _addTrayMirrorGroup(page, config) {
        const group = new Adw.PreferencesGroup({
            title: 'Mirrored indicators',
            description: 'Choose which top-bar and Quick Settings indicators appear in the Tray tab. Requires "Mirror top-bar indicators" to be on.',
        });
        page.add(group);

        const items = config.trayMirrorItems;
        if (!items.length) {
            // The catalog is only populated once the shell has rendered the Tray
            // tab at least once (it publishes what it saw). Tell the user how to
            // populate it rather than showing an empty group.
            const empty = new Adw.ActionRow({
                title: 'No indicators discovered yet',
                subtitle: 'Open the notch, switch to the Tray tab once, then reopen these settings. Indicators you have will be listed here.',
            });
            group.add(empty);
            return;
        }

        // Stable, human-friendly order.
        const sorted = [...items].sort((a, b) =>
            String(a.label).localeCompare(String(b.label)));
        for (const it of sorted) {
            const row = new Adw.SwitchRow({
                title: it.label || it.id,
                // Show the raw id as a subtitle so ambiguous entries (two icons
                // with the same name) are still distinguishable.
                subtitle: it.id,
                active: config.isTrayMirrorEnabled(it.id),
            });
            row.connect('notify::active', () => {
                config.setTrayMirrorEnabled(it.id, row.get_active());
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
