// Home, Tasks, Focus and Notes tabs, plus the focus timer's live activity in
// the collapsed pill.
//
// These are methods mixed into the NotchNux actor (see installProductivity at
// the bottom), so they share its helpers: _mount(), _invalidateTab(),
// _makeTypable(), _switchTab(), the accent, the stores. Each tab keeps a small
// `_xxxUi` handle so data changes patch the visible actors in place instead of
// rebuilding the tab.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';


import { ProductivityStore, FOCUS_PRESETS, fmtCountdown } from '../helpers/productivity.js';
import { FocusRing, AlbumArtDisc, BREAK_GREEN, accentHex, accentRgbStr } from '../helpers/widgets.js';
import { addPressFeedback } from '../helpers/motion.js';
import { fmt } from '../helpers/format.js';

const HOME_TASKS = 4;

function label(text, styleClass, props = {}) {
    let l = new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconButton(iconName, styleClass, onClick, accessibleName = null) {
    let b = new St.Button({ style_class: styleClass, can_focus: true, reactive: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: accessibleName ?? '' });
    b.set_child(new St.Icon({ icon_name: iconName, icon_size: 14 }));
    b.connect('clicked', onClick);
    addPressFeedback(b);
    return b;
}

function card(styleClass = '') {
    return new St.BoxLayout({ style_class: `nook-card ${styleClass}`.trim(), orientation: Clutter.Orientation.VERTICAL, x_expand: true });
}

function eyebrow(text) {
    return new St.Label({ text, style_class: 'nook-card-eyebrow', y_align: Clutter.ActorAlign.CENTER });
}

// "45m" / "1h 15m".
function fmtMinutes(min) {
    if (min < 60) return `${min}m`;
    let h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

export const ProductivityTabs = {
    // ------------------------------------------------------------ lifecycle

    _initProductivity() {
        this._prod = new ProductivityStore();
        this._prodUnsub = this._prod.subscribe(kind => this._onProductivityChanged(kind));
        this._buildPillFocus();
        this._syncPillFocus();
        this._syncFocusDnd();
    },

    _destroyProductivity() {
        this._prodUnsub?.();
        // Hand Do Not Disturb back if we set it. If a session is still running
        // when we're re-enabled (e.g. after unlocking) it is re-applied then.
        if (this._prod?.dndByUs) {
            this._notificationSettings().set_boolean('show-banners', true);
            this._prod.setDndByUs(false);
        }
        this._prod?.destroy();
        this._prod = null;
    },

    _onProductivityChanged(kind) {
        if (this._destroyed)
            return;
        switch (kind) {
        case 'tick':
            this._tickPillFocus();
            if (this.isExpanded && this._activeTab === 'focus')
                this._focusUi?.update();
            else if (this.isExpanded && this._activeTab === 'home')
                this._homeUi?.updateFocus();
            break;
        case 'focus':
            this._syncPillFocus();
            this._syncFocusDnd();
            if (this._invalidateTab('focus', 'home')) {
                if (this._activeTab === 'focus') this._focusUi?.update();
                else this._homeUi?.updateFocus();
            }
            break;
        case 'focus-done':
        case 'break-done':
            this._onFocusPhaseDone(kind);
            break;
        case 'stopwatch':
        case 'sw-tick':
            this._onStopwatchChanged(kind);
            break;
        case 'loaded': {
            // Saved tasks/notes/focus arrived (read async after enable).
            this._syncPillFocus();
            this._syncFocusDnd();
            let tabs = ['home', 'tasks', 'focus', 'notes'];
            for (let tab of tabs)
                this._markTabDirty(tab);
            if (this.isExpanded && tabs.includes(this._activeTab))
                this._showActiveTab();
            break;
        }
        case 'tasks':
            if (this._invalidateTab('tasks', 'home')) {
                if (this._activeTab === 'tasks') this._tasksUi?.fill();
                else this._homeUi?.fillTasks();
            }
            break;
        }
    },

    // Open a tab, expanding the notch if needed.
    _openTab(tab) {
        if (!this._tabOrder.includes(tab))
            return;
        this._switchTab(tab);
        if (!this.isExpanded)
            this.expand();
    },

    // ------------------------------------------------------------ pill

    // The pill's live activity: a tiny ring + countdown while a focus or break
    // session exists. It takes the music zone's place (one activity at a time,
    // like a phone's dynamic island) and opens the Focus tab when clicked.
    _buildPillFocus() {
        this._pillFocusBox = new St.Button({
            style_class: 'notchnux-pill-focus', reactive: true, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER, visible: false });
        let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._pillFocusRing = new FocusRing(16, 3);
        this._pillFocusLabel = new St.Label({ style_class: 'notchnux-pill-focus-time', y_align: Clutter.ActorAlign.CENTER });
        row.add_child(this._pillFocusRing);
        row.add_child(this._pillFocusLabel);
        this._pillFocusBox.set_child(row);
        this._pillFocusBox.connect('clicked', () => this._openTab('focus'));
        this._pill.insert_child_at_index(this._pillFocusBox, 0);
    },

    _syncPillFocus() {
        if (!this._pillFocusBox)
            return;
        let active = this._prod.focusActive;
        let changed = active !== this._pillFocusBox.visible;
        this._pillFocusBox.visible = active;
        this._tickPillFocus();
        if (changed) {
            // Music (and the stopwatch) yield to the timer, and come back after.
            this._syncPillStopwatch?.();
            this._refreshLive();
            if (!this.isExpanded)
                this._applyPillWidth();
        }
    },

    _tickPillFocus() {
        if (!this._pillFocusBox?.visible)
            return;
        let f = this._prod.focus;
        let color = f.phase === 'break' ? BREAK_GREEN : null;
        this._pillFocusRing.set(f.progress, color, !f.running);
        this._pillFocusLabel.set_text(fmtCountdown(f.remainingMs));
        this._pillFocusLabel.set_style(`color: ${f.phase === 'break' ? '#5bdb9e' : accentHex()};`);
    },

    // ------------------------------------------------------------ focus ↔ DND

    // While a focus session runs with "silence" on, turn on Do Not Disturb —
    // and only ever undo a DND that we turned on ourselves.
    _syncFocusDnd() {
        if (!this._prod)
            return;
        let f = this._prod.focus;
        let settings = this._notificationSettings();
        let want = f.phase === 'focus' && f.running && f.silence;
        if (want && !this._prod.dndByUs && settings.get_boolean('show-banners')) {
            settings.set_boolean('show-banners', false);
            this._prod.setDndByUs(true);
        } else if (!want && this._prod.dndByUs) {
            settings.set_boolean('show-banners', true);
            this._prod.setDndByUs(false);
        }
    },

    _onFocusPhaseDone(kind) {
        this._syncPillFocus();
        this._syncFocusDnd();
        try {
            global.display.get_sound_player().play_from_theme('complete',
                kind === 'focus-done' ? 'Focus session complete' : 'Break over', null);
        } catch (e) {}
        if (this.isExpanded) {
            if (this._activeTab === 'focus') this._focusUi?.update();
            else if (this._activeTab === 'home') this._homeUi?.updateFocus();
            this._markTabDirty('focus');
            this._markTabDirty('home');
            return;
        }
        this._markTabDirty('focus');
        this._markTabDirty('home');
        let f = this._prod.focus;
        let [title, body, actions] = kind === 'focus-done'
            ? ['Focus session complete',
                `${f.sessionsToday} today · ${fmtMinutes(f.focusMinToday)} focused. Take a breather?`,
                [{ label: 'Start break', callback: () => this._prod.startBreak() },
                    { label: 'Not now', callback: () => {} }]]
            : ['Break’s over', 'Ready for another round?',
                [{ label: 'Start focus', callback: () => this._prod.startFocus() },
                    { label: 'Later', callback: () => {} }]];
        // A pseudo-notification: clicking the banner body opens the Focus tab.
        this._showNotificationPeek(title, body, new Gio.ThemedIcon({ name: 'alarm-symbolic' }),
            { activate: () => this._openTab('focus') }, actions);
    },

    // ------------------------------------------------------------ Home

    _renderHomeTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-home', orientation: Clutter.Orientation.VERTICAL, x_expand: true });

        // Greeting + weather chip.
        let now = new Date();
        let hour = now.getHours();
        let greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        let head = new St.BoxLayout({ style_class: 'nook-home-head', x_expand: true });
        let titles = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titles.add_child(label(greeting, 'nook-home-greeting'));
        titles.add_child(label(fmt(now, { weekday: 'long', month: 'long', day: 'numeric' }), 'nook-home-date'));
        head.add_child(titles);
        let w = this._weather.weatherData;
        if (w.loaded) {
            let chip = new St.Button({ style_class: 'nook-home-weather', y_align: Clutter.ActorAlign.CENTER, can_focus: true });
            let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
            row.add_child(new St.Icon({ icon_name: w.icon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER }));
            row.add_child(label(w.temp, 'nook-home-weather-temp'));
            chip.set_child(row);
            chip.connect('clicked', () => this._switchTab('weather'));
            addPressFeedback(chip);
            head.add_child(chip);
        }
        panel.add_child(head);

        let grid = new St.BoxLayout({ style_class: 'nook-home-grid', x_expand: true });
        let left = new St.BoxLayout({ style_class: 'nook-home-col', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        let right = new St.BoxLayout({ style_class: 'nook-home-col nook-home-side', orientation: Clutter.Orientation.VERTICAL });
        grid.add_child(left);
        grid.add_child(right);
        panel.add_child(grid);

        left.add_child(this._buildHomeAgenda());
        let tasks = this._buildHomeTasks();
        left.add_child(tasks.card);
        let focus = this._buildHomeFocus();
        right.add_child(focus.card);
        let media = this._buildHomeMedia();
        right.add_child(media.card);

        this._mount(panel);
        this._homeUi = {
            fillTasks: tasks.fill,
            updateFocus: focus.update,
            updateMedia: media.update,
        };
        tasks.fill();
        focus.update();
        media.update(this._mpris.getActiveTrackInfo());
    },

    _refreshHomeTab() {
        this._homeUi?.fillTasks();
        this._homeUi?.updateFocus();
        this._homeUi?.updateMedia(this._mpris.getActiveTrackInfo());
    },

    // Next timed event today ("Up next"), or the rest of the day's count.
    _buildHomeAgenda() {
        let c = new St.Button({ style_class: 'nook-card nook-home-agenda', x_expand: true, can_focus: true });
        let box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        c.set_child(box);
        c.connect('clicked', () => this._switchTab('calendar'));
        addPressFeedback(c, 0.98);

        let now = new Date();
        let dayEnd = new Date(now);
        dayEnd.setHours(24, 0, 0, 0);
        let upcoming = [...this._calendarServerEvents.values()]
            .filter(ev => !ev.allDay && ev.end > now && ev.start < dayEnd)
            .sort((a, b) => a.start - b.start);
        let next = upcoming[0];

        let head = new St.BoxLayout({ x_expand: true });
        let eb = eyebrow(next && next.start <= now ? 'NOW' : 'UP NEXT');
        eb.x_expand = true;
        head.add_child(eb);
        if (upcoming.length > 1)
            head.add_child(label(`+${upcoming.length - 1} more today`, 'nook-card-meta'));
        box.add_child(head);

        if (!next) {
            box.add_child(label('Nothing else today', 'nook-home-agenda-title nook-dim'));
            box.add_child(label('Your calendar is clear.', 'nook-home-agenda-sub'));
            return c;
        }
        let row = new St.BoxLayout({ style_class: 'nook-home-agenda-row', x_expand: true });
        let bar = new St.Widget({ style_class: 'nook-home-agenda-bar' });
        bar.set_style(`background-color: ${accentHex()};`);
        row.add_child(bar);
        let text = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        text.add_child(label(next.title, 'nook-home-agenda-title'));
        let mins = Math.round((next.start - now) / 60000);
        let when = next.start <= now ? `until ${fmt(next.end, { hour: 'numeric', minute: '2-digit' })}`
            : mins < 60 ? `in ${mins} min` : `at ${fmt(next.start, { hour: 'numeric', minute: '2-digit' })}`;
        text.add_child(label(next.location ? `${when} · ${next.location}` : when, 'nook-home-agenda-sub'));
        row.add_child(text);
        box.add_child(row);
        return c;
    },

    _buildHomeTasks() {
        let c = card('nook-home-tasks');
        let head = new St.BoxLayout({ x_expand: true });
        let eb = eyebrow('TASKS');
        eb.x_expand = true;
        head.add_child(eb);
        let count = label('', 'nook-card-meta');
        head.add_child(count);
        c.add_child(head);

        let list = new St.BoxLayout({ style_class: 'nook-home-task-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        c.add_child(list);

        let entry = new St.Entry({ style_class: 'nook-input nook-input-compact', hint_text: 'Add a task…',
            can_focus: true, x_expand: true });
        this._makeTypable(entry);
        entry.clutter_text.connect('activate', () => {
            if (this._prod.addTask(entry.get_text()))
                entry.set_text('');
        });
        c.add_child(entry);

        let fill = () => {
            list.destroy_all_children();
            let open = this._prod.openTasks;
            count.set_text(open.length ? `${open.length} open` : `${this._prod.doneToday} done today`);
            if (open.length === 0) {
                list.add_child(label('Nothing on your list. Nice.', 'nook-home-empty'));
                return;
            }
            for (let t of open.slice(0, HOME_TASKS))
                list.add_child(this._buildTaskRow(t, { compact: true }));
            if (open.length > HOME_TASKS) {
                let more = new St.Button({ style_class: 'nook-link', x_align: Clutter.ActorAlign.START, can_focus: true,
                    label: `${open.length - HOME_TASKS} more in Tasks →` });
                more.connect('clicked', () => this._switchTab('tasks'));
                list.add_child(more);
            }
        };
        return { card: c, fill };
    },

    _buildHomeFocus() {
        let c = new St.BoxLayout({ style_class: 'nook-card nook-home-focus', orientation: Clutter.Orientation.HORIZONTAL, x_expand: true });
        let ringStack = new St.Widget({ layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER });
        let ring = new FocusRing(58, 5);
        ringStack.add_child(ring);
        let time = new St.Label({ style_class: 'nook-home-focus-time', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        ringStack.add_child(time);
        c.add_child(ringStack);

        let side = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let phase = eyebrow('FOCUS');
        side.add_child(phase);
        let action = new St.Button({ style_class: 'nook-pill-btn', x_align: Clutter.ActorAlign.START, can_focus: true });
        let actionLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        action.set_child(actionLabel);
        action.connect('clicked', () => this._prod.toggleFocus());
        addPressFeedback(action);
        side.add_child(action);
        let stats = label('', 'nook-card-meta');
        side.add_child(stats);
        c.add_child(side);

        let update = () => {
            let f = this._prod.focus;
            let breakTime = f.phase === 'break';
            ring.set(f.phase === 'idle' ? 0 : f.progress, breakTime ? BREAK_GREEN : null, f.phase !== 'idle' && !f.running);
            time.set_text(fmtCountdown(f.remainingMs));
            phase.set_text(f.phase === 'idle' ? `FOCUS · ${f.presetMin}M` : breakTime ? 'BREAK' : f.running ? 'FOCUSING' : 'PAUSED');
            actionLabel.set_text(f.phase === 'idle' ? 'Start' : f.running ? 'Pause' : 'Resume');
            action.set_style(f.phase === 'idle' || !f.running ? `background-color: ${accentHex()}; color: #0d0d10;` : null);
            stats.set_text(f.sessionsToday ? `${f.sessionsToday} done · ${fmtMinutes(f.focusMinToday)}` : 'None yet today');
        };
        return { card: c, update };
    },

    _buildHomeMedia() {
        let c = card('nook-home-media');
        let row = new St.BoxLayout({ x_expand: true });
        let art = new AlbumArtDisc(38);
        art.y_align = Clutter.ActorAlign.CENTER;
        let artBox = new St.Bin({ style_class: 'nook-home-art', y_align: Clutter.ActorAlign.CENTER });
        artBox.set_child(art);
        row.add_child(artBox);
        let text = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let title = label('', 'nook-home-media-title');
        let artist = label('', 'nook-home-media-artist');
        text.add_child(title);
        text.add_child(artist);
        row.add_child(text);
        c.add_child(row);

        let controls = new St.BoxLayout({ style_class: 'nook-home-media-controls', x_align: Clutter.ActorAlign.CENTER });
        let prev = iconButton('media-skip-backward-symbolic', 'nook-mini-btn', () => this._mpris.previous(), 'Previous');
        let play = iconButton('media-playback-start-symbolic', 'nook-mini-btn nook-mini-btn-primary', () => this._mpris.playPause(), 'Play/Pause');
        let next = iconButton('media-skip-forward-symbolic', 'nook-mini-btn', () => this._mpris.next(), 'Next');
        controls.add_child(prev);
        controls.add_child(play);
        controls.add_child(next);
        c.add_child(controls);

        let artUrl = null;
        let update = info => {
            let playing = info.status === 'Playing';
            title.set_text(String(info.hasMedia ? info.title : 'Nothing playing'));
            artist.set_text(String(info.hasMedia ? info.artist : ''));
            artist.visible = info.hasMedia;
            play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            play.set_style(`background-color: ${accentHex()};`);
            for (let b of [prev, play, next])
                b.reactive = info.hasMedia;
            controls.opacity = info.hasMedia ? 255 : 110;
            if (info.albumArt !== artUrl) {
                artUrl = info.albumArt;
                art.setArtPath(null);
                this._loadAlbumArt(info.albumArt, art);
            }
        };
        return { card: c, update };
    },

    // ------------------------------------------------------------ Tasks

    // One task row: check circle · text (click to edit) · star · delete.
    _buildTaskRow(task, { compact = false } = {}) {
        let row = new St.BoxLayout({
            style_class: `nook-task-row${compact ? ' nook-task-row-compact' : ''}${task.done ? ' nook-task-done' : ''}`,
            x_expand: true, reactive: true, track_hover: true });

        let check = new St.Button({ style_class: 'nook-task-check', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: task.done ? 'Mark as not done' : 'Mark as done' });
        check.set_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 12 }));
        if (task.done)
            check.set_style(`background-color: ${accentHex()}; border-color: ${accentHex()};`);
        check.connect('clicked', () => {
            // Fill the circle and fade the row, then commit (which re-fills
            // the list without this row).
            check.set_style(`background-color: ${accentHex()}; border-color: ${accentHex()};`);
            check.child.opacity = 255;
            row.ease({
                opacity: 0, translation_x: 14, duration: 220, delay: 120,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this._prod.toggleTask(task.id),
            });
        });
        addPressFeedback(check, 0.88);
        row.add_child(check);

        let text = new St.Label({ style_class: 'nook-task-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: !compact });
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        let escaped = GLib.markup_escape_text(task.text, -1);
        text.clutter_text.set_markup(task.done ? `<s>${escaped}</s>` : escaped);
        row.add_child(text);

        if (compact) {
            if (task.starred) {
                let star = new St.Icon({ icon_name: 'starred-symbolic', icon_size: 12, style_class: 'nook-task-star-on', y_align: Clutter.ActorAlign.CENTER });
                star.set_style(`color: ${accentHex()};`);
                row.add_child(star);
            }
            return row;
        }

        // Click the text to edit it in place; Enter saves, Escape cancels.
        if (!task.done) {
            text.connect('button-release-event', () => {
                let edit = new St.Entry({ style_class: 'nook-input nook-task-edit', text: task.text, x_expand: true, can_focus: true });
                this._makeTypable(edit);
                let done = save => {
                    if (save) this._prod.renameTask(task.id, edit.get_text());
                    else this._tasksUi?.fill();
                };
                edit.clutter_text.connect('activate', () => done(true));
                edit.clutter_text.connect('key-press-event', (a, ev) => {
                    if (ev.get_key_symbol() === Clutter.KEY_Escape) { done(false); return Clutter.EVENT_STOP; }
                    return Clutter.EVENT_PROPAGATE;
                });
                row.replace_child(text, edit);
                edit.clutter_text.grab_key_focus();
                this._grabKeyboard(edit.clutter_text);
                return Clutter.EVENT_STOP;
            });
        }

        let star = iconButton(task.starred ? 'starred-symbolic' : 'non-starred-symbolic',
            `nook-task-action${task.starred ? ' nook-task-star-on' : ''}`, () => this._prod.toggleStar(task.id), 'Star');
        if (task.starred)
            star.set_style(`color: ${accentHex()};`);
        let del = iconButton('window-close-symbolic', 'nook-task-action nook-task-delete', () => {
            row.ease({ opacity: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._prod.removeTask(task.id) });
        }, 'Delete');
        // Secondary actions surface on hover so the list reads clean.
        let actions = new St.BoxLayout({ style_class: 'nook-task-actions', y_align: Clutter.ActorAlign.CENTER });
        actions.add_child(star);
        actions.add_child(del);
        actions.opacity = task.starred ? 255 : 0;
        del.opacity = 0;
        row.connect('notify::hover', () => {
            actions.ease({ opacity: row.hover || task.starred ? 255 : 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            del.ease({ opacity: row.hover ? 255 : 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        });
        row.add_child(actions);
        return row;
    },

    _renderTasksTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-tasks', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        this._tasksView ??= 'open';

        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        let title = label('Tasks', 'nook-section-title');
        head.add_child(title);
        let badge = new St.Bin({ style_class: 'nook-count-badge', y_align: Clutter.ActorAlign.CENTER });
        badge.set_style(`background-color: ${accentHex()};`);
        let badgeLabel = new St.Label();
        badge.set_child(badgeLabel);
        head.add_child(badge);
        head.add_child(new St.Widget({ x_expand: true }));

        // Open / Done segmented switch.
        let seg = new St.BoxLayout({ style_class: 'nook-segmented', y_align: Clutter.ActorAlign.CENTER });
        let segBtns = {};
        for (let [id, text] of [['open', 'Open'], ['done', 'Done']]) {
            let b = new St.Button({ style_class: 'nook-segment', label: text, can_focus: true });
            b.connect('clicked', () => {
                this._tasksView = id;
                this._tasksUi?.fill();
            });
            seg.add_child(b);
            segBtns[id] = b;
        }
        head.add_child(seg);
        let clear = new St.Button({ style_class: 'nook-clear-btn', label: 'Clear', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        clear.connect('clicked', () => this._prod.clearDone());
        head.add_child(clear);
        panel.add_child(head);

        // Quick add. A leading "!" stars the task.
        let addRow = new St.BoxLayout({ style_class: 'nook-task-add', x_expand: true });
        let entry = new St.Entry({ style_class: 'nook-input', hint_text: 'Add a task — start with ! to star it',
            can_focus: true, x_expand: true });
        this._makeTypable(entry);
        let add = () => {
            if (this._prod.addTask(entry.get_text())) {
                entry.set_text('');
                this._tasksView = 'open';
            }
        };
        entry.clutter_text.connect('activate', add);
        addRow.add_child(entry);
        let addBtn = iconButton('list-add-symbolic', 'nook-add-btn', add, 'Add task');
        addBtn.set_style(`background-color: ${accentHex()};`);
        addRow.add_child(addBtn);
        panel.add_child(addRow);

        let scroll = new St.ScrollView({ style_class: 'nook-task-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let list = new St.BoxLayout({ style_class: 'nook-task-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        scroll.set_child(list);
        panel.add_child(scroll);

        let footer = label('', 'nook-card-meta nook-task-footer');
        panel.add_child(footer);

        let fill = () => {
            let open = this._prod.openTasks;
            let done = this._prod.doneTasks;
            let view = this._tasksView;
            badgeLabel.set_text(String(open.length));
            badge.visible = open.length > 0;
            for (let [id, b] of Object.entries(segBtns)) {
                if (id === view) b.add_style_class_name('nook-segment-active');
                else b.remove_style_class_name('nook-segment-active');
            }
            clear.visible = view === 'done' && done.length > 0;
            list.destroy_all_children();
            let items = view === 'open' ? open : done;
            if (items.length === 0) {
                let empty = new St.BoxLayout({ style_class: 'nook-empty', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
                let ic = new St.Icon({ icon_name: view === 'open' ? 'checkbox-checked-symbolic' : 'task-due-symbolic',
                    icon_size: 26, style_class: 'nook-empty-icon', x_align: Clutter.ActorAlign.CENTER });
                ic.set_style(`color: rgba(${accentRgbStr()}, 0.8);`);
                empty.add_child(ic);
                empty.add_child(new St.Label({ text: view === 'open' ? 'All clear' : 'Nothing completed yet',
                    style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
                empty.add_child(new St.Label({ text: view === 'open' ? 'Add something above to get started.' : 'Ticked-off tasks land here.',
                    style_class: 'nook-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
                list.add_child(empty);
            } else {
                for (let t of items)
                    list.add_child(this._buildTaskRow(t));
            }
            footer.set_text(view === 'open'
                ? `${this._prod.doneToday} done today · click a task to edit`
                : `${done.length} completed`);
            if (this.isExpanded && this._activeTab === 'tasks')
                this._resizeToContent();
        };
        this._mount(panel);
        this._tasksUi = { fill };
        fill();
    },

    // ------------------------------------------------------------ Focus

    _renderFocusTab() {
        this._swUi = null;
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-focus', orientation: Clutter.Orientation.VERTICAL, x_expand: true });

        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(this._buildFocusModeSwitch());
        let phase = new St.Label({ style_class: 'nook-phase-chip', y_align: Clutter.ActorAlign.CENTER });
        phase.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        head.add_child(phase);
        head.add_child(new St.Widget({ x_expand: true }));
        let silence = new St.Button({ style_class: 'nook-chip', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        let silenceRow = new St.BoxLayout();
        silenceRow.add_child(new St.Icon({ icon_name: 'notifications-disabled-symbolic', icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
        silenceRow.add_child(new St.Label({ text: 'Silence alerts', y_align: Clutter.ActorAlign.CENTER }));
        silence.set_child(silenceRow);
        silence.connect('clicked', () => this._prod.setSilence(!this._prod.focus.silence));
        addPressFeedback(silence);
        head.add_child(silence);
        panel.add_child(head);

        // The big ring with the countdown over it.
        let body = new St.BoxLayout({ style_class: 'nook-focus-body', x_expand: true });
        let ringStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        let ring = new FocusRing(168, 11);
        ringStack.add_child(ring);
        let center = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        let time = new St.Label({ style_class: 'nook-focus-time', x_align: Clutter.ActorAlign.CENTER });
        let sub = new St.Label({ style_class: 'nook-focus-sub', x_align: Clutter.ActorAlign.CENTER });
        center.add_child(time);
        center.add_child(sub);
        ringStack.add_child(center);
        body.add_child(ringStack);

        // Right column: presets, controls, today's stats.
        let side = new St.BoxLayout({ style_class: 'nook-focus-side', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        side.add_child(eyebrow('LENGTH'));
        let presets = new St.BoxLayout({ style_class: 'nook-chip-row' });
        let presetBtns = {};
        for (let min of FOCUS_PRESETS) {
            let b = new St.Button({ style_class: 'nook-chip', label: `${min} min`, can_focus: true });
            b.connect('clicked', () => this._prod.setPreset(min));
            addPressFeedback(b);
            presets.add_child(b);
            presetBtns[min] = b;
        }
        side.add_child(presets);

        let controls = new St.BoxLayout({ style_class: 'nook-focus-controls' });
        let reset = iconButton('view-refresh-symbolic', 'nook-round-btn', () => this._prod.resetFocus(), 'Reset');
        let main = new St.Button({ style_class: 'nook-focus-main', can_focus: true });
        let mainRow = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        let mainIcon = new St.Icon({ icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        let mainLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        mainRow.add_child(mainIcon);
        mainRow.add_child(mainLabel);
        main.set_child(mainRow);
        main.connect('clicked', () => this._prod.toggleFocus());
        addPressFeedback(main);
        let skip = iconButton('media-skip-forward-symbolic', 'nook-round-btn', () => this._prod.skipFocus(), 'Skip');
        controls.add_child(reset);
        controls.add_child(main);
        controls.add_child(skip);
        side.add_child(controls);

        let stats = new St.BoxLayout({ style_class: 'nook-focus-stats' });
        let dots = new St.BoxLayout({ style_class: 'nook-cycle-dots', y_align: Clutter.ActorAlign.CENTER });
        let dotActors = [];
        for (let i = 0; i < 4; i++) {
            let d = new St.Widget({ style_class: 'nook-cycle-dot' });
            dots.add_child(d);
            dotActors.push(d);
        }
        stats.add_child(dots);
        let statsLabel = label('', 'nook-card-meta');
        stats.add_child(statsLabel);
        side.add_child(stats);
        body.add_child(side);
        panel.add_child(body);

        let update = () => {
            let f = this._prod.focus;
            let breakTime = f.phase === 'break';
            let accent = breakTime ? '#5bdb9e' : accentHex();
            ring.set(f.phase === 'idle' ? 0 : f.progress, breakTime ? BREAK_GREEN : null, f.phase !== 'idle' && !f.running);
            time.set_text(fmtCountdown(f.remainingMs));
            sub.set_text(f.phase === 'idle' ? 'ready when you are' : !f.running ? 'paused'
                : breakTime ? 'stretch, breathe' : `of ${Math.round(f.durationMs / 60000)} min`);
            phase.set_text(f.phase === 'idle' ? 'READY' : breakTime ? 'BREAK' : 'FOCUS');
            phase.set_style(`color: ${accent}; background-color: ${breakTime ? 'rgba(91, 219, 158, 0.14)' : `rgba(${accentRgbStr()}, 0.14)`};`);
            silence.set_style(f.silence ? `color: ${accentHex()}; border-color: rgba(${accentRgbStr()}, 0.45);` : null);
            for (let [min, b] of Object.entries(presetBtns)) {
                let on = Number(min) === f.presetMin;
                b.set_style(on ? `background-color: rgba(${accentRgbStr()}, 0.20); border-color: rgba(${accentRgbStr()}, 0.5); color: #fff;` : null);
                b.reactive = f.phase === 'idle';
                b.opacity = f.phase === 'idle' || on ? 255 : 110;
            }
            mainIcon.icon_name = f.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            mainLabel.set_text(f.phase === 'idle' ? 'Start focus' : f.running ? 'Pause' : 'Resume');
            main.set_style(`background-color: ${accent};`);
            reset.reactive = f.phase !== 'idle';
            reset.opacity = f.phase !== 'idle' ? 255 : 90;
            skip.reactive = f.phase !== 'idle';
            skip.opacity = f.phase !== 'idle' ? 255 : 90;
            let cycle = (this._prod._focus.cycle ?? 0) % 4;
            dotActors.forEach((d, i) => d.set_style(i < cycle ? `background-color: ${accentHex()};` : null));
            statsLabel.set_text(f.sessionsToday
                ? `${f.sessionsToday} session${f.sessionsToday === 1 ? '' : 's'} · ${fmtMinutes(f.focusMinToday)} today`
                : 'Long break after 4 sessions');
        };
        this._mount(panel);
        this._focusUi = { update };
        update();
    },

    _refreshFocusTab() {
        this._focusUi?.update();
    },

    // ------------------------------------------------------------ Notes

    _renderNotesTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-notes', orientation: Clutter.Orientation.VERTICAL, x_expand: true });

        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(label('Notes', 'nook-section-title'));
        let status = label('Saved', 'nook-card-meta nook-notes-status');
        head.add_child(status);
        head.add_child(new St.Widget({ x_expand: true }));
        let copy = new St.Button({ style_class: 'nook-clear-btn', label: 'Copy', can_focus: true });
        copy.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._prod.notes);
            status.set_text('Copied');
        });
        head.add_child(copy);
        // Two-step clear: the first click arms it for 3 s.
        let clear = new St.Button({ style_class: 'nook-clear-btn', label: 'Clear', can_focus: true });
        let armed = 0;
        clear.connect('clicked', () => {
            if (!armed) {
                clear.label = 'Really clear?';
                clear.add_style_class_name('nook-danger');
                armed = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    armed = 0;
                    clear.label = 'Clear';
                    clear.remove_style_class_name('nook-danger');
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            GLib.Source.remove(armed);
            armed = 0;
            clear.label = 'Clear';
            clear.remove_style_class_name('nook-danger');
            entry.set_text('');
        });
        clear.connect('destroy', () => { if (armed) GLib.Source.remove(armed); });
        head.add_child(clear);
        panel.add_child(head);

        let scroll = new St.ScrollView({ style_class: 'nook-notes-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let wrap = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        let entry = new St.Entry({ style_class: 'nook-notes-entry', hint_text: 'Jot something down… it saves as you type.',
            can_focus: true, x_expand: true, text: this._prod.notes });
        let text = entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._makeTypable(entry);
        wrap.add_child(entry);
        scroll.set_child(wrap);
        panel.add_child(scroll);

        let footer = label('', 'nook-card-meta');
        panel.add_child(footer);
        let words = () => {
            let t = entry.get_text().trim();
            let n = t ? t.split(/\s+/).length : 0;
            footer.set_text(`${n} word${n === 1 ? '' : 's'} · saved on this computer only`);
        };
        words();

        let typingId = 0;
        text.connect('text-changed', () => {
            this._prod.setNotes(entry.get_text());
            status.set_text('Editing…');
            words();
            if (typingId) GLib.Source.remove(typingId);
            typingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                typingId = 0;
                status.set_text('Saved');
                return GLib.SOURCE_REMOVE;
            });
        });
        text.connect('destroy', () => { if (typingId) GLib.Source.remove(typingId); });
        // Keep the caret in view as the note grows past the scroll area.
        text.connect('cursor-changed', () => {
            let adj = scroll.get_vadjustment();
            let [ok, , y, lineH] = text.position_to_coords(text.get_cursor_position());
            if (!ok || !adj) return;
            if (y < adj.value)
                adj.value = y;
            else if (y + lineH > adj.value + adj.page_size)
                adj.value = y + lineH - adj.page_size + 8;
        });

        this._mount(panel);
        this._notesUi = { entry };
    },
};

export function installProductivity(proto) {
    for (let [name, fn] of Object.entries(ProductivityTabs))
        proto[name] = fn;
}
