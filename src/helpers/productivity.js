// Tasks, notes and the focus timer for NotchNux.
//
// Everything lives under ~/.local/share/notchnux (0700) as small files written
// atomically with 0600 permissions:
//   tasks.json  — [{ id, text, done, starred, created, doneAt }]
//   notes.md    — free text
//   focus.json  — timer state + today's stats
//
// GNOME disables the extension on every screen lock and re-enables it on
// unlock, so nothing here may live only in memory: the focus timer is stored as
// a wall-clock end time and simply keeps running across a lock.

import GLib from 'gi://GLib';

export const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchnux']);
const TASKS_PATH = GLib.build_filenamev([DATA_DIR, 'tasks.json']);
const NOTES_PATH = GLib.build_filenamev([DATA_DIR, 'notes.md']);
const FOCUS_PATH = GLib.build_filenamev([DATA_DIR, 'focus.json']);

export const FOCUS_PRESETS = [15, 25, 50];   // minutes
const SHORT_BREAK_MIN = 5;
const LONG_BREAK_MIN = 15;
const LONG_BREAK_EVERY = 4;                    // sessions
const MAX_TASK_LEN = 200;
const MAX_TASKS = 500;
const MAX_NOTES = 64 * 1024;

export function readText(path) {
    try {
        let [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

export function writeText(path, text) {
    try {
        GLib.mkdir_with_parents(DATA_DIR, 0o700);
        GLib.file_set_contents_full(path, new TextEncoder().encode(text),
            GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        GLib.chmod(path, 0o600);
    } catch (e) {
        console.error(`NotchNux: failed to save ${path}`, e);
    }
}

function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class ProductivityStore {
    constructor() {
        this._saveIds = {};
        this._listeners = new Set();
        this._tasks = this._loadTasks();
        this._notes = readText(NOTES_PATH) ?? '';
        this._focus = this._loadFocus();
        this._tickId = 0;
        this._swTickId = 0;
        this._syncTicker();
        this._syncSwTicker();
    }

    destroy() {
        // Flush anything still waiting on its debounce before we go.
        for (let [what, id] of Object.entries(this._saveIds)) {
            GLib.Source.remove(id);
            this._write(what);
        }
        this._saveIds = {};
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        if (this._swTickId) {
            GLib.Source.remove(this._swTickId);
            this._swTickId = 0;
        }
        this._listeners.clear();
    }

    // `cb(kind)` with kind = 'tasks' | 'notes' | 'focus' | 'tick'. Returns an
    // unsubscribe function.
    subscribe(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _emit(kind) {
        for (let cb of this._listeners) {
            try {
                cb(kind);
            } catch (e) {
                console.error('NotchNux: productivity listener failed', e);
            }
        }
    }

    // Debounced write so a burst of edits (typing a note, ticking several
    // tasks) costs one small file write.
    _scheduleSave(what, delay = 400) {
        if (this._saveIds[what])
            GLib.Source.remove(this._saveIds[what]);
        this._saveIds[what] = GLib.timeout_add(GLib.PRIORITY_LOW, delay, () => {
            delete this._saveIds[what];
            this._write(what);
            return GLib.SOURCE_REMOVE;
        });
    }

    _write(what) {
        if (what === 'tasks')
            writeText(TASKS_PATH, JSON.stringify(this._tasks, null, 1));
        else if (what === 'notes')
            writeText(NOTES_PATH, this._notes);
        else if (what === 'focus')
            writeText(FOCUS_PATH, JSON.stringify(this._focus, null, 1));
    }

    // ------------------------------------------------------------ stopwatch
    // Wall-clock based like the focus timer, so it keeps counting through a
    // lock (the extension is torn down and rebuilt) and a restart. Stored with
    // the focus state.

    get stopwatch() {
        let sw = this._focus.sw ?? { running: false, startedAt: 0, accMs: 0, laps: [] };
        let elapsedMs = sw.accMs + (sw.running ? Math.max(0, Date.now() - sw.startedAt) : 0);
        return { running: !!sw.running, elapsedMs, laps: sw.laps ?? [], active: sw.running || sw.accMs > 0 };
    }

    _sw() {
        if (!this._focus.sw)
            this._focus.sw = { running: false, startedAt: 0, accMs: 0, laps: [] };
        return this._focus.sw;
    }

    toggleStopwatch() {
        let sw = this._sw();
        if (sw.running) {
            sw.accMs += Math.max(0, Date.now() - sw.startedAt);
            sw.running = false;
        } else {
            sw.startedAt = Date.now();
            sw.running = true;
        }
        this._changedSw();
    }

    lapStopwatch() {
        let sw = this._sw();
        if (!sw.running)
            return;
        sw.laps = [this.stopwatch.elapsedMs, ...(sw.laps ?? [])].slice(0, 20);
        this._changedSw();
    }

    resetStopwatch() {
        this._focus.sw = { running: false, startedAt: 0, accMs: 0, laps: [] };
        this._changedSw();
    }

    _changedSw() {
        this._scheduleSave('focus', 50);
        this._syncSwTicker();
        this._emit('stopwatch');
    }

    // Once a second only while it runs.
    _syncSwTicker() {
        let running = !!this._focus.sw?.running;
        if (running && !this._swTickId) {
            this._swTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._focus.sw?.running) {
                    this._swTickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._emit('sw-tick');
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!running && this._swTickId) {
            GLib.Source.remove(this._swTickId);
            this._swTickId = 0;
        }
    }

    // ---------------------------------------------------------------- tasks

    _loadTasks() {
        try {
            let list = JSON.parse(readText(TASKS_PATH) ?? '[]');
            if (!Array.isArray(list))
                return [];
            return list
                .filter(t => t && typeof t.text === 'string' && t.text.trim())
                .slice(0, MAX_TASKS)
                .map(t => ({
                    id: String(t.id ?? GLib.uuid_string_random()),
                    text: t.text.slice(0, MAX_TASK_LEN),
                    done: !!t.done,
                    starred: !!t.starred,
                    created: Number(t.created) || Date.now(),
                    doneAt: t.done ? Number(t.doneAt) || Date.now() : null,
                }));
        } catch (e) {
            // Keep the unreadable file for recovery instead of letting the
            // next save overwrite it.
            console.error('NotchNux: tasks.json is unreadable; moved to tasks.json.bak', e);
            GLib.rename(TASKS_PATH, `${TASKS_PATH}.bak`);
            return [];
        }
    }

    // Open tasks: starred first, then oldest first. Done tasks: most recent first.
    get openTasks() {
        return this._tasks.filter(t => !t.done)
            .sort((a, b) => (b.starred - a.starred) || (a.created - b.created));
    }

    get doneTasks() {
        return this._tasks.filter(t => t.done).sort((a, b) => b.doneAt - a.doneAt);
    }

    get doneToday() {
        let key = todayKey();
        return this._tasks.filter(t => t.done && todayKey(new Date(t.doneAt)) === key).length;
    }

    addTask(text) {
        text = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_LEN);
        if (!text || this._tasks.length >= MAX_TASKS)
            return null;
        // A leading "!" stars the task: "!call the bank".
        let starred = text.startsWith('!');
        if (starred)
            text = text.slice(1).trim();
        if (!text)
            return null;
        let task = { id: GLib.uuid_string_random(), text, done: false, starred,
            created: Date.now(), doneAt: null };
        this._tasks.push(task);
        this._changedTasks();
        return task;
    }

    _task(id) {
        return this._tasks.find(t => t.id === id) ?? null;
    }

    toggleTask(id) {
        let t = this._task(id);
        if (!t) return;
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        this._changedTasks();
    }

    toggleStar(id) {
        let t = this._task(id);
        if (!t) return;
        t.starred = !t.starred;
        this._changedTasks();
    }

    renameTask(id, text) {
        let t = this._task(id);
        text = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_LEN);
        if (!t || !text) return;
        t.text = text;
        this._changedTasks();
    }

    removeTask(id) {
        let before = this._tasks.length;
        this._tasks = this._tasks.filter(t => t.id !== id);
        if (this._tasks.length !== before)
            this._changedTasks();
    }

    clearDone() {
        this._tasks = this._tasks.filter(t => !t.done);
        this._changedTasks();
    }

    _changedTasks() {
        this._scheduleSave('tasks', 150);
        this._emit('tasks');
    }

    // ---------------------------------------------------------------- notes

    get notes() {
        return this._notes;
    }

    setNotes(text) {
        text = String(text ?? '').slice(0, MAX_NOTES);
        if (text === this._notes)
            return;
        this._notes = text;
        this._scheduleSave('notes', 600);
        this._emit('notes');
    }

    // ---------------------------------------------------------------- focus
    //
    // State: { phase: 'idle' | 'focus' | 'break', running, endsAt (epoch ms,
    // while running), remainingMs (while paused), durationMs, presetMin,
    // silence, day, sessionsToday, focusMsToday, cycle }

    _loadFocus() {
        let base = {
            phase: 'idle', running: false, endsAt: 0, remainingMs: 0, durationMs: 25 * 60000,
            presetMin: 25, silence: true, day: todayKey(), sessionsToday: 0, focusMsToday: 0, cycle: 0,
        };
        let f;
        try {
            f = { ...base, ...JSON.parse(readText(FOCUS_PATH) ?? '{}') };
        } catch (e) {
            f = base;
        }
        if (!FOCUS_PRESETS.includes(f.presetMin))
            f.presetMin = 25;
        if (f.day !== todayKey())
            Object.assign(f, { day: todayKey(), sessionsToday: 0, focusMsToday: 0 });
        return f;
    }

    get focus() {
        let f = this._focus;
        let remainingMs = f.running ? Math.max(0, f.endsAt - Date.now()) : f.remainingMs;
        if (f.phase === 'idle')
            remainingMs = f.presetMin * 60000;
        let durationMs = f.phase === 'idle' ? f.presetMin * 60000 : f.durationMs;
        return {
            phase: f.phase,
            running: f.running,
            remainingMs,
            durationMs,
            progress: durationMs > 0 ? 1 - remainingMs / durationMs : 0,
            presetMin: f.presetMin,
            silence: f.silence,
            sessionsToday: f.day === todayKey() ? f.sessionsToday : 0,
            focusMinToday: f.day === todayKey() ? Math.round(f.focusMsToday / 60000) : 0,
        };
    }

    // True while a session (focus or break) is counting down or paused.
    get focusActive() {
        return this._focus.phase !== 'idle';
    }

    setPreset(min) {
        if (!FOCUS_PRESETS.includes(min)) return;
        this._focus.presetMin = min;
        this._changedFocus();
    }

    setSilence(on) {
        this._focus.silence = !!on;
        this._changedFocus();
    }

    // Whether *we* turned Do Not Disturb on for the current session, so we
    // only ever undo our own change.
    get dndByUs() {
        return !!this._focus.dndByUs;
    }

    setDndByUs(on) {
        this._focus.dndByUs = !!on;
        this._scheduleSave('focus', 50);
    }

    _begin(phase, minutes) {
        let f = this._focus;
        f.phase = phase;
        f.running = true;
        f.durationMs = minutes * 60000;
        f.endsAt = Date.now() + f.durationMs;
        f.remainingMs = f.durationMs;
    }

    startFocus() {
        this._begin('focus', this._focus.presetMin);
        this._changedFocus();
    }

    startBreak() {
        let long = this._focus.cycle > 0 && this._focus.cycle % LONG_BREAK_EVERY === 0;
        this._begin('break', long ? LONG_BREAK_MIN : SHORT_BREAK_MIN);
        this._changedFocus();
    }

    // Play/pause toggle; from idle it starts a focus session.
    toggleFocus() {
        let f = this._focus;
        if (f.phase === 'idle') {
            this.startFocus();
            return;
        }
        if (f.running) {
            f.remainingMs = Math.max(0, f.endsAt - Date.now());
            f.running = false;
        } else {
            f.endsAt = Date.now() + f.remainingMs;
            f.running = true;
        }
        this._changedFocus();
    }

    resetFocus() {
        Object.assign(this._focus, { phase: 'idle', running: false, endsAt: 0, remainingMs: 0 });
        this._changedFocus();
    }

    // End the current phase now. Skipping a focus session doesn't count it.
    skipFocus() {
        if (this._focus.phase === 'focus') {
            this._focus.phase = 'idle';
            this._focus.running = false;
            this.startBreak();
        } else {
            this.resetFocus();
        }
    }

    // A phase ran out. Focus → counts toward today and moves to "break due"
    // (idle, so the user chooses when the break starts); break → idle.
    _completePhase() {
        let f = this._focus;
        let finished = f.phase;
        if (f.day !== todayKey())
            Object.assign(f, { day: todayKey(), sessionsToday: 0, focusMsToday: 0 });
        if (finished === 'focus') {
            f.sessionsToday++;
            f.focusMsToday += f.durationMs;
            f.cycle++;
        }
        Object.assign(f, { phase: 'idle', running: false, endsAt: 0, remainingMs: 0 });
        this._changedFocus();
        this._emit(finished === 'focus' ? 'focus-done' : 'break-done');
    }

    _changedFocus() {
        this._scheduleSave('focus', 50);
        this._syncTicker();
        this._emit('focus');
    }

    // A once-a-second tick only while a phase is counting down; it also
    // catches a phase that ended while the screen was locked.
    _syncTicker() {
        let f = this._focus;
        if (f.running && f.endsAt <= Date.now()) {
            // Deferred: callers may still be wiring up listeners.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._focus.running && this._focus.endsAt <= Date.now())
                    this._completePhase();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (f.running && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                if (!this._focus.running) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                if (this._focus.endsAt <= Date.now()) {
                    this._tickId = 0;
                    this._completePhase();
                    return GLib.SOURCE_REMOVE;
                }
                this._emit('tick');
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!f.running && this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
    }
}

// "mm:ss" (or "h:mm:ss") for a millisecond count, rounded up so a timer never
// shows 0:00 while it still has time left.
export function fmtCountdown(ms) {
    let total = Math.max(0, Math.ceil(ms / 1000));
    let h = Math.floor(total / 3600);
    let m = Math.floor((total % 3600) / 60);
    let s = total % 60;
    let pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
