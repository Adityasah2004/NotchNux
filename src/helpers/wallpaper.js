// Wallpaper rotation for NotchNux.
//
// GNOME's Wayland compositor renders the desktop background itself and only
// accepts a *static image URI* via the org.gnome.desktop.background GSettings
// (picture-uri / picture-uri-dark). There is no supported path for a shell
// extension to put a video/GIF/live wallpaper behind the desktop under Mutter,
// so this helper deals exclusively with still images.
//
// WallpaperHelper owns:
//   - scanning a folder for image files (getWallpapers, cached + monitored)
//   - reading / applying the current wallpaper through GSettings
//   - the rotation timer (sequential or random order)
//   - manual next/prev/set, which restart the timer from the chosen image
//   - auto-pause: the caller feeds it battery / fullscreen state and the timer
//     holds while paused, resuming where it left off.
//   - landscape rotation / enhancement and dashboard thumbnails, all done by
//     src/tools/image-worker.js in a separate process. Doing that pixel work
//     in-process used to freeze the whole desktop for seconds per image.
//
// It carries no persisted state of its own — the folder, interval, order and
// auto-pause preferences live in ConfigStore and are pushed in via configure().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BG_SCHEMA = 'org.gnome.desktop.background';

const CACHE_ROOT = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchnux']);
// Processed (rotated and/or enhanced) copies. Originals are never modified;
// GNOME is pointed at the copy instead.
const PROC_DIR = GLib.build_filenamev([CACHE_ROOT, 'wallpaper']);
const THUMB_DIR = GLib.build_filenamev([CACHE_ROOT, 'wp-thumbs']);
// Pre-worker cache locations; removed on startup.
const LEGACY_DIRS = ['landscape', 'enhanced'].map(d => GLib.build_filenamev([CACHE_ROOT, d]));
const PROC_KEEP = 24;
const THUMB_KEEP = 400;

// Thumbnail size: the dashboard cell is 132×82 CSS px; render at 2× so it's
// crisp on HiDPI.
const THUMB_W = 264;
const THUMB_H = 164;
const THUMB_BATCH = 6;

// Sentinel in _procResults: the image needs no processing; apply the original.
const AS_IS = Symbol('as-is');

const WORKER = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('tools').get_child('image-worker.js').get_path();

// Extensions we treat as valid still wallpapers. Anything GNOME's background
// renderer can't draw (mp4/webm/gif animation) is intentionally excluded — see
// the file header.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'svg']);

function mkdirPrivate(path) {
    GLib.mkdir_with_parents(path, 0o700);
}

// Keep the newest `keep` regular files in `dir`, delete the rest.
function pruneDir(dir, keep) {
    try {
        let d = Gio.File.new_for_path(dir);
        if (!d.query_exists(null))
            return;
        let en = d.enumerate_children('standard::name,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let files = [];
        let info;
        while ((info = en.next_file(null)) !== null)
            files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
        en.close(null);
        files.sort((a, b) => b[1] - a[1]);
        for (let [name] of files.slice(keep)) {
            try { d.get_child(name).delete(null); } catch (e) {}
        }
    } catch (e) {
        console.warn('NotchNux: wallpaper cache prune failed', e.message);
    }
}

export class WallpaperHelper {
    constructor() {
        this._bg = new Gio.Settings({ schema_id: BG_SCHEMA });
        this._cancellable = new Gio.Cancellable();

        // Rotation state.
        this._folder = null;
        this._intervalSec = 300;
        this._order = 'sequential'; // 'sequential' | 'random'
        this._rotationEnabled = false;
        // When true, portrait images are rotated 90° into landscape (honouring
        // EXIF orientation) before being applied. Off leaves images as-is.
        this._autoLandscape = false;
        // Sharpen + contrast/saturation pass for a crisper desktop.
        this._enhance = false;
        this._enhanceMode = 'auto';
        this._enhSharpen = 0.6;
        this._enhContrast = 1.06;
        this._enhSaturation = 1.08;

        // Auto-pause inputs, updated by setPauseState(). While either is true
        // the timer is held.
        this._pauseOnBattery = true;
        this._pauseOnFullscreen = true;
        this._onBattery = false;
        this._inFullscreen = false;

        this._timerId = 0;
        // Index into the *current* file list of the wallpaper we last applied,
        // so sequential rotation advances from where the user (or the timer)
        // left off. -1 means "not found in the list".
        this._currentIndex = -1;
        // The *source* (original folder) path we last applied — the
        // authoritative "which wallpaper is current" marker, since picture-uri
        // may point at a processed cache copy.
        this._currentPath = null;

        // Folder listing cache, invalidated by a directory monitor so the
        // rotation tick doesn't re-enumerate the folder every time.
        this._list = null;
        this._dirMonitor = null;
        this._dirMonitorId = 0;

        // Worker bookkeeping. _applyGen discards results from a superseded
        // setWallpaper(); _procResults remembers per-key outcomes this session.
        this._applyGen = 0;
        this._applyProc = null;
        this._procResults = new Map();
        this._thumbQueue = [];
        this._thumbWaiters = new Map();   // src -> [cb]
        this._thumbBusy = false;

        this._pruneId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._pruneId = 0;
            for (let d of LEGACY_DIRS) {
                pruneDir(d, 0);
                try { Gio.File.new_for_path(d).delete(null); } catch (e) {}
            }
            pruneDir(PROC_DIR, PROC_KEEP);
            pruneDir(THUMB_DIR, THUMB_KEEP);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._stopTimer();
        if (this._pruneId) {
            GLib.Source.remove(this._pruneId);
            this._pruneId = 0;
        }
        this._cancellable.cancel();
        this._applyProc?.force_exit();
        this._applyProc = null;
        this._thumbQueue = [];
        this._thumbWaiters.clear();
        this._unwatchFolder();
        this._bg = null;
    }

    // Push the user's preferences in. Called once at startup and again whenever
    // the config file changes. Restarts the timer so a new interval/order/folder
    // takes effect immediately.
    configure({ folder, intervalSec, order, rotationEnabled, autoLandscape, enhance,
                enhanceMode, enhanceSharpen, enhanceContrast, enhanceSaturation,
                pauseOnBattery, pauseOnFullscreen }) {
        let newFolder = folder || null;
        if (newFolder !== this._folder) {
            this._folder = newFolder;
            this._list = null;
            this._watchFolder();
        }
        this._intervalSec = Math.max(5, intervalSec | 0);
        this._order = order === 'random' ? 'random' : 'sequential';
        this._rotationEnabled = !!rotationEnabled;
        this._autoLandscape = !!autoLandscape;
        this._enhance = !!enhance;
        this._enhanceMode = enhanceMode === 'manual' ? 'manual' : 'auto';
        let pick = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
        this._enhSharpen = pick(enhanceSharpen, 0.6);
        this._enhContrast = pick(enhanceContrast, 1.06);
        this._enhSaturation = pick(enhanceSaturation, 1.08);
        this._pauseOnBattery = !!pauseOnBattery;
        this._pauseOnFullscreen = !!pauseOnFullscreen;
        this._syncTimer();
    }

    // Feed live power/fullscreen state so the timer can auto-pause. Cheap to
    // call repeatedly; only re-evaluates the timer when the effective pause
    // state actually flips.
    setPauseState({ onBattery, inFullscreen }) {
        let before = this._isPaused();
        if (onBattery !== undefined) this._onBattery = !!onBattery;
        if (inFullscreen !== undefined) this._inFullscreen = !!inFullscreen;
        if (this._isPaused() !== before)
            this._syncTimer();
    }

    _isPaused() {
        return (this._pauseOnBattery && this._onBattery) ||
               (this._pauseOnFullscreen && this._inFullscreen);
    }

    // Whether rotation should currently be ticking.
    _shouldRun() {
        return this._rotationEnabled && !!this._folder && !this._isPaused();
    }

    // --- Wallpaper list ---

    _watchFolder() {
        this._unwatchFolder();
        if (!this._folder)
            return;
        try {
            this._dirMonitor = Gio.File.new_for_path(this._folder)
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._dirMonitorId = this._dirMonitor.connect('changed', () => {
                this._list = null;
            });
        } catch (e) {
            this._dirMonitor = null;
        }
    }

    _unwatchFolder() {
        if (this._dirMonitor) {
            if (this._dirMonitorId)
                this._dirMonitor.disconnect(this._dirMonitorId);
            this._dirMonitor.cancel();
        }
        this._dirMonitor = null;
        this._dirMonitorId = 0;
    }

    _scanFolder() {
        let list = [];
        try {
            let dir = Gio.File.new_for_path(this._folder);
            let enumerator = dir.enumerate_children(
                'standard::name,standard::type,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                let name = info.get_name();
                let ext = name.split('.').pop().toLowerCase();
                if (!IMAGE_EXTS.has(ext))
                    continue;
                let file = dir.get_child(name);
                list.push({
                    name,
                    path: file.get_path(),
                    uri: file.get_uri(),
                    mtime: info.get_attribute_uint64('time::modified'),
                });
            }
            enumerator.close(null);
        } catch (e) {
            console.error('NotchNux: Failed to enumerate wallpaper folder', e);
        }
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        return list;
    }

    // Return the image files in the configured folder as
    // [{ name, path, uri, mtime, current }], sorted by name so sequential order
    // is stable and predictable. `current` marks the one we're showing now.
    getWallpapers() {
        if (!this._folder)
            return [];
        if (!this._list)
            this._list = this._scanFolder();
        // Prefer the source path we last applied ourselves; only fall back to
        // GNOME's picture-uri when we haven't set anything this session.
        let currentPath = this._currentPath || this.getCurrentPath();
        let list = this._list.map(w => ({ ...w, current: w.path === currentPath }));
        this._currentIndex = list.findIndex(w => w.current);
        return list;
    }

    // Absolute path of the wallpaper GNOME is currently showing (from the
    // light picture-uri), or null.
    getCurrentPath() {
        try {
            let uri = this._bg.get_string('picture-uri');
            return uri ? Gio.File.new_for_uri(uri).get_path() : null;
        } catch (e) {
            return null;
        }
    }

    // --- Worker plumbing ---

    // Run image-worker.js in its own process at low CPU priority. `done(result)`
    // gets the parsed JSON reply, or null on failure/cancel. Returns the
    // subprocess so callers can abandon it.
    _spawnWorker(mode, payload, done) {
        let gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        let argv = [gjs, '-m', WORKER, mode, JSON.stringify(payload)];
        let nice = GLib.find_program_in_path('nice');
        if (nice)
            argv = [nice, '-n', '10', ...argv];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            console.error('NotchNux: cannot start image worker', e);
            done(null);
            return null;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let stdout = '', stderr = '';
            try {
                [, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                done(null);
                return;
            }
            if (stderr?.trim())
                console.warn(`NotchNux: image worker: ${stderr.trim().slice(0, 300)}`);
            if (!p.get_successful()) {
                done(null);
                return;
            }
            try {
                done(JSON.parse(stdout.trim().split('\n').pop()));
            } catch (e) {
                done(null);
            }
        });
        return proc;
    }

    _key(...parts) {
        return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, parts.join('\u0001'), -1);
    }

    _mtime(path) {
        try {
            return Gio.File.new_for_path(path)
                .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
                .get_attribute_uint64('time::modified');
        } catch (e) {
            return 0;
        }
    }

    // Largest monitor, in device pixels — the size enhancement is done at.
    _coverSize() {
        try {
            let [w, h] = global.display.get_size();
            return [w, h];
        } catch (e) {
            return [2560, 1600];
        }
    }

    // --- Thumbnails ---

    // Cached thumbnail path for a list item, or null if not generated yet.
    thumbFor(item) {
        let path = GLib.build_filenamev([THUMB_DIR,
            `${this._key(item.path, item.mtime, this._autoLandscape)}.jpg`]);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    // Generate thumbnails for `items` in the background, a few per worker run,
    // calling `onReady(srcPath, thumbPath)` as each batch lands.
    requestThumbs(items, onReady) {
        mkdirPrivate(THUMB_DIR);
        for (let item of items) {
            let waiters = this._thumbWaiters.get(item.path);
            if (waiters) {
                waiters.push(onReady);
                continue;
            }
            this._thumbWaiters.set(item.path, [onReady]);
            this._thumbQueue.push({
                src: item.path,
                out: GLib.build_filenamev([THUMB_DIR,
                    `${this._key(item.path, item.mtime, this._autoLandscape)}.jpg`]),
            });
        }
        this._pumpThumbs();
    }

    _pumpThumbs() {
        if (this._thumbBusy || this._thumbQueue.length === 0)
            return;
        this._thumbBusy = true;
        let batch = this._thumbQueue.splice(0, THUMB_BATCH);
        this._spawnWorker('thumbs', {
            items: batch, landscape: this._autoLandscape, w: THUMB_W, h: THUMB_H,
        }, result => {
            this._thumbBusy = false;
            let ok = new Set(result?.done ?? []);
            for (let item of batch) {
                let waiters = this._thumbWaiters.get(item.src) ?? [];
                this._thumbWaiters.delete(item.src);
                if (!ok.has(item.src))
                    continue;
                for (let cb of waiters) {
                    try { cb(item.src, item.out); } catch (e) { console.error(e); }
                }
            }
            if (!this._cancellable.is_cancelled())
                this._pumpThumbs();
        });
    }

    // --- Applying ---

    _applyUri(path) {
        if (!this._bg)
            return;
        let uri = Gio.File.new_for_path(path).get_uri();
        this._bg.set_string('picture-uri', uri);
        this._bg.set_string('picture-uri-dark', uri);
        // A folder of user images is almost never the exact monitor size;
        // 'zoom' fills without distortion. Only set it if the user left it at
        // 'none' so we don't override a deliberate choice.
        if (this._bg.get_string('picture-options') === 'none')
            this._bg.set_string('picture-options', 'zoom');
    }

    // Options for the worker, or null when the image can be applied as-is.
    _processOptions() {
        if (!this._autoLandscape && !this._enhance)
            return null;
        let [coverW, coverH] = this._coverSize();
        return {
            landscape: this._autoLandscape,
            enhance: this._enhance ? {
                mode: this._enhanceMode,
                sharpen: this._enhSharpen,
                contrast: this._enhContrast,
                saturation: this._enhSaturation,
            } : null,
            coverW, coverH,
        };
    }

    // Point GNOME at `path` (or its processed copy) for both the light and
    // dark background. Returns immediately; when processing is needed the
    // desktop switches once the worker finishes, and a newer call supersedes
    // an older in-flight one. Restarts the rotation timer from this pick.
    setWallpaper(path) {
        if (!path)
            return false;
        this._currentPath = path;
        let gen = ++this._applyGen;
        if (this._shouldRun())
            this._syncTimer();

        let opts = this._processOptions();
        if (!opts) {
            this._applyUri(path);
            return true;
        }
        let key = this._key(path, this._mtime(path), JSON.stringify(opts));
        let out = GLib.build_filenamev([PROC_DIR, `${key}.jpg`]);
        if (this._procResults.get(key) === AS_IS) {
            this._applyUri(path);
            return true;
        }
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            this._applyUri(out);
            return true;
        }

        mkdirPrivate(PROC_DIR);
        this._applyProc?.force_exit();
        this._applyProc = this._spawnWorker('process', { src: path, out, ...opts }, result => {
            if (gen !== this._applyGen)
                return; // superseded by a newer pick
            this._applyProc = null;
            if (result && result.out) {
                this._applyUri(result.out);
            } else {
                if (result)
                    this._procResults.set(key, AS_IS);
                this._applyUri(path);
            }
        });
        return true;
    }

    // Advance to the next wallpaper per the configured order and apply it.
    // Returns the applied path, or null if there's nothing to rotate to.
    next() {
        return this._step(+1);
    }

    prev() {
        return this._step(-1);
    }

    _step(dir) {
        let list = this.getWallpapers();
        if (list.length === 0)
            return null;
        if (list.length === 1) {
            this.setWallpaper(list[0].path);
            return list[0].path;
        }

        let idx;
        if (this._order === 'random') {
            // Pick a random image that isn't the current one.
            do {
                idx = Math.floor(Math.random() * list.length);
            } while (idx === this._currentIndex);
        } else if (this._currentIndex < 0) {
            // Nothing of ours applied yet: start the cycle at the first image
            // (or the last, if stepping backwards) rather than skipping it.
            idx = dir >= 0 ? 0 : list.length - 1;
        } else {
            idx = (this._currentIndex + dir + list.length) % list.length;
        }
        this.setWallpaper(list[idx].path);
        return list[idx].path;
    }

    // --- Timer ---

    // Reconcile the running timer with _shouldRun(): start it (or restart it to
    // pick up a new interval) when rotation should run, stop it otherwise.
    _syncTimer() {
        this._stopTimer();
        if (!this._shouldRun())
            return;
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._intervalSec,
            () => {
                this.next();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }
}
