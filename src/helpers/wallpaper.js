// Wallpaper rotation for NotchNux.
//
// GNOME's Wayland compositor renders the desktop background itself and only
// accepts a *static image URI* via the org.gnome.desktop.background GSettings
// (picture-uri / picture-uri-dark). There is no supported path for a shell
// extension to put a video/GIF/live wallpaper behind the desktop under Mutter,
// so this helper deals exclusively with still images.
//
// WallpaperHelper owns:
//   - scanning a folder for image files (getWallpapers)
//   - reading / applying the current wallpaper through GSettings
//   - the rotation timer (sequential or random order)
//   - manual next/prev/set, which restart the timer from the chosen image
//   - auto-pause: the caller feeds it battery / fullscreen state and the timer
//     holds while paused, resuming where it left off.
//
// It carries no persisted state of its own — the folder, interval, order and
// auto-pause preferences live in ConfigStore and are pushed in via configure().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

const BG_SCHEMA = 'org.gnome.desktop.background';

// Where we drop landscape-rotated copies of portrait wallpapers. We never
// touch the user's originals; GNOME is pointed at the copy instead.
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchnux', 'landscape']);

// Where we drop crispened copies. Same policy as CACHE_DIR: originals are
// never modified; GNOME renders our enhanced copy instead.
const ENHANCE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchnux', 'enhanced']);

// Default enhancement strengths. Tuned to look noticeably crisper without the
// haloing/over-saturated look that heavier values produce on photographic
// wallpapers.
//
// These are the *centre* of the auto range: in 'auto' mode the strengths are
// derived per image from its own statistics (see _autoStrengthsFor) and land
// near these for an average photo, stronger for a flat/soft one and weaker for
// an already-punchy/crisp one. In 'manual' mode they're ignored — the user's
// own values pushed in via configure() apply unchanged to every image.
//   sharpen     — how much of the edge signal to add back (unsharp mask).
//   contrast    — >1 pushes darks down / lights up around mid-grey.
//   saturation  — >1 deepens colour; kept gentle so skies/skin stay natural.
const SHARPEN_AMOUNT = 0.6;
const CONTRAST = 1.06;
const SATURATION = 1.08;

// Bounds the per-image auto strengths are clamped into, so an extreme image
// can't push the filter into haloing / posterised / neon territory. Kept in
// step with the manual slider ranges in config.js (ENHANCE_RANGE).
const AUTO_BOUNDS = {
    sharpen: { min: 0.2, max: 1.2 },
    contrast: { min: 1.0, max: 1.18 },
    saturation: { min: 1.0, max: 1.25 },
};

// Extensions we treat as valid still wallpapers. Anything GNOME's background
// renderer can't draw (mp4/webm/gif animation) is intentionally excluded — see
// the file header.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'svg']);

export class WallpaperHelper {
    constructor() {
        this._bg = new Gio.Settings({ schema_id: BG_SCHEMA });

        // Rotation state.
        this._folder = null;
        this._intervalSec = 300;
        this._order = 'sequential'; // 'sequential' | 'random'
        this._rotationEnabled = false;
        // When true, portrait images are rotated 90° into landscape (honouring
        // EXIF orientation) before being applied. Off leaves images as-is.
        this._autoLandscape = false;
        // When true, images get an unsharp-mask + contrast/saturation pass so
        // the rendered desktop looks crisper and more detailed. Off applies the
        // original pixels untouched.
        this._enhance = false;
        // 'auto' derives the strengths per image from its own statistics;
        // 'manual' applies the fixed user values below to every image.
        this._enhanceMode = 'auto';
        // The *manual* strengths (only used when _enhanceMode === 'manual').
        this._enhSharpen = SHARPEN_AMOUNT;
        this._enhContrast = CONTRAST;
        this._enhSaturation = SATURATION;

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
        // The *source* (original folder) path we last applied. This is the
        // authoritative marker for "which wallpaper is current": when
        // auto-landscape is on we hand GNOME a rotated *cache* copy, so
        // picture-uri no longer matches any file in the folder and can't be
        // used to find our place in the list. Tracking the source path here
        // keeps sequential rotation cycling 1→2→…→n→1 regardless.
        this._currentPath = null;
    }

    destroy() {
        this._stopTimer();
        this._bg = null;
    }

    // Push the user's preferences in. Called once at startup and again whenever
    // the config file changes. Restarts the timer so a new interval/order/folder
    // takes effect immediately.
    configure({ folder, intervalSec, order, rotationEnabled, autoLandscape, enhance,
                enhanceMode, enhanceSharpen, enhanceContrast, enhanceSaturation,
                pauseOnBattery, pauseOnFullscreen }) {
        this._folder = folder || null;
        this._intervalSec = Math.max(5, intervalSec | 0);
        this._order = order === 'random' ? 'random' : 'sequential';
        this._rotationEnabled = !!rotationEnabled;
        this._autoLandscape = !!autoLandscape;
        this._enhance = !!enhance;
        this._enhanceMode = enhanceMode === 'manual' ? 'manual' : 'auto';
        // Manual strengths: use the user's values, falling back to the tuned
        // defaults for any non-finite entry. Ignored entirely in auto mode,
        // where strengths are derived per image (see _autoStrengthsFor).
        let pick = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
        this._enhSharpen = pick(enhanceSharpen, SHARPEN_AMOUNT);
        this._enhContrast = pick(enhanceContrast, CONTRAST);
        this._enhSaturation = pick(enhanceSaturation, SATURATION);
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

    // Return the image files in the configured folder as
    // [{ name, path, uri, current }], sorted by name so sequential order is
    // stable and predictable. `current` marks the one GNOME is showing now.
    getWallpapers() {
        let list = [];
        if (!this._folder)
            return list;
        // Prefer the source path we last applied ourselves; only fall back to
        // GNOME's picture-uri when we haven't set anything this session (e.g.
        // right after startup). With auto-landscape on, picture-uri points at a
        // cache copy and would never match a folder file, so relying on it alone
        // would strand _currentIndex at -1 and break sequential rotation.
        let currentPath = this._currentPath || this.getCurrentPath();
        try {
            let dir = Gio.File.new_for_path(this._folder);
            let enumerator = dir.enumerate_children(
                'standard::name,standard::type',
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
                let path = GLib.build_filenamev([this._folder, name]);
                list.push({
                    name,
                    path,
                    uri: Gio.File.new_for_path(path).get_uri(),
                    current: path === currentPath,
                });
            }
        } catch (e) {
            console.error('NotchNux: Failed to enumerate wallpaper folder', e);
        }
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        // Keep the index in sync with the freshly-scanned list so timer
        // advancement lines up with what the tab shows.
        this._currentIndex = list.findIndex(w => w.current);
        return list;
    }

    // Absolute path of the wallpaper GNOME is currently showing (from the
    // light picture-uri), or null. Used to highlight the active thumbnail.
    getCurrentPath() {
        try {
            let uri = this._bg.get_string('picture-uri');
            if (!uri)
                return null;
            let f = Gio.File.new_for_uri(uri);
            return f.get_path();
        } catch (e) {
            return null;
        }
    }

    // Path to use for a *preview* thumbnail of `srcPath`: the landscape-rotated
    // copy when auto-landscape is on (so the dashboard shows the image the way
    // it'll actually be applied — turned to fill the screen), otherwise the
    // original. Enhancement is deliberately skipped here: it's subtle, costly to
    // compute, and not what changes the framing. Never throws.
    previewPathFor(srcPath) {
        try {
            return this._landscapeCopyFor(srcPath);
        } catch (e) {
            return srcPath;
        }
    }

    // --- Landscape rotation ---

    // If auto-landscape is on and `srcPath` is a portrait image, return the
    // path to a landscape (90°-rotated) copy in the cache; otherwise return
    // `srcPath` unchanged. EXIF orientation is applied first, so the "portrait"
    // decision and the rotation both match how the photo is meant to be viewed.
    // Never throws: on any failure it falls back to the original path.
    _landscapeCopyFor(srcPath) {
        if (!this._autoLandscape || !srcPath)
            return srcPath;
        try {
            // Cheap orientation check without decoding the whole image. Note
            // get_file_info reports the *stored* pixel size, before EXIF, so we
            // still load fully below to make the real decision — but this lets
            // us skip obviously-landscape files fast.
            let [, w, h] = GdkPixbuf.Pixbuf.get_file_info(srcPath);
            if (w > 0 && h > 0 && w >= h)
                return srcPath; // already landscape/square in stored pixels…

            let src = Gio.File.new_for_path(srcPath);
            let info = src.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let mtime = info.get_attribute_uint64('time::modified');

            // Cache key: source basename + mtime, so edits invalidate the copy
            // and unchanged files are reused across rotations and restarts.
            let base = src.get_basename().replace(/\.[^.]+$/, '');
            let cachePath = GLib.build_filenamev([CACHE_DIR, `${base}.${mtime}.png`]);
            if (GLib.file_test(cachePath, GLib.FileTest.EXISTS))
                return cachePath;

            let pixbuf = GdkPixbuf.Pixbuf.new_from_file(srcPath);
            // Honour EXIF orientation first (phone photos are often stored
            // sideways with a corrective tag).
            let oriented = pixbuf.apply_embedded_orientation() || pixbuf;
            // Only rotate if it's *actually* portrait once oriented.
            if (oriented.get_height() <= oriented.get_width())
                return srcPath;
            let rotated = oriented.rotate_simple(GdkPixbuf.PixbufRotation.COUNTERCLOCKWISE);
            if (!rotated)
                return srcPath;

            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            rotated.savev(cachePath, 'png', [], []);
            return cachePath;
        } catch (e) {
            console.error('NotchNux: Failed to landscape-rotate wallpaper', e);
            return srcPath;
        }
    }

    // --- Enhancement (crisp + detailed) ---

    // If enhancement is on, return the path to a sharpened, contrast/saturation-
    // boosted copy of `srcPath` in the cache; otherwise return `srcPath`
    // unchanged. GdkPixbuf ships no convolution, so the sharpen is a hand-rolled
    // unsharp mask (original + amount·(original − blur)) with a cheap 3×3 box
    // blur as the low-pass. Never throws: on any failure it falls back to the
    // original path so a wallpaper still gets applied.
    _enhanceCopyFor(srcPath) {
        if (!this._enhance || !srcPath)
            return srcPath;
        try {
            let src = Gio.File.new_for_path(srcPath);
            let info = src.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let mtime = info.get_attribute_uint64('time::modified');

            let pixbuf = GdkPixbuf.Pixbuf.new_from_file(srcPath);
            // Honour EXIF orientation so we analyse and sharpen the image as
            // it's actually viewed.
            pixbuf = pixbuf.apply_embedded_orientation() || pixbuf;

            // Pick the strengths for *this* image. Auto derives them from the
            // image's own statistics; manual uses the fixed user values.
            let strengths = this._enhanceMode === 'manual'
                ? { sharpen: this._enhSharpen, contrast: this._enhContrast, saturation: this._enhSaturation }
                : this._autoStrengthsFor(pixbuf);

            // Cache key includes mtime *and* the effective strengths, so editing
            // the source, retuning manual sliders, or auto picking different
            // strengths all invalidate stale copies while unchanged files are
            // reused across rotations and restarts. Strengths are rounded so
            // tiny floating-point differences don't fragment the cache.
            let round = (v) => Math.round(v * 1000) / 1000;
            let base = src.get_basename().replace(/\.[^.]+$/, '');
            let tune = `${this._enhanceMode[0]}${round(strengths.sharpen)}-${round(strengths.contrast)}-${round(strengths.saturation)}`;
            let cachePath = GLib.build_filenamev([ENHANCE_DIR, `${base}.${mtime}.${tune}.png`]);
            if (GLib.file_test(cachePath, GLib.FileTest.EXISTS))
                return cachePath;

            let enhanced = this._sharpenAndGrade(pixbuf, strengths);
            if (!enhanced)
                return srcPath;

            GLib.mkdir_with_parents(ENHANCE_DIR, 0o755);
            enhanced.savev(cachePath, 'png', [], []);
            return cachePath;
        } catch (e) {
            console.error('NotchNux: Failed to enhance wallpaper', e);
            return srcPath;
        }
    }

    // --- Auto (adaptive) strengths ---

    // Analyse `pixbuf` and derive per-image sharpen/contrast/saturation
    // strengths from its own content, so a flat or soft wallpaper gets pushed
    // harder while an already-punchy, crisp one is left mostly alone. Returns
    // { sharpen, contrast, saturation } clamped to AUTO_BOUNDS. Falls back to
    // the tuned centres (SHARPEN_AMOUNT/CONTRAST/SATURATION) if the layout is
    // one we can't read.
    _autoStrengthsFor(pixbuf) {
        let stats = this._imageStats(pixbuf);
        if (!stats)
            return { sharpen: SHARPEN_AMOUNT, contrast: CONTRAST, saturation: SATURATION };

        let clampTo = (v, b) => (v < b.min ? b.min : v > b.max ? b.max : v);
        // Map a measurement to a 0..1 "needs boost" factor: 1 when the image is
        // at/below `low`, 0 at/above `high`, linear between.
        let need = (v, low, high) => {
            if (v <= low) return 1;
            if (v >= high) return 0;
            return (high - v) / (high - low);
        };

        // Sharpen: soft images (little high-frequency detail) want more; already
        // crisp images want less. `detail` is mean per-pixel gradient in 0..255.
        let sharpen = AUTO_BOUNDS.sharpen.min +
            need(stats.detail, 3, 22) * (AUTO_BOUNDS.sharpen.max - AUTO_BOUNDS.sharpen.min);

        // Contrast: flat images (low luma spread) want a bigger push. `contrastRms`
        // is the std-dev of luma in 0..255 (~64 is a punchy photo).
        let contrast = AUTO_BOUNDS.contrast.min +
            need(stats.contrastRms, 30, 70) * (AUTO_BOUNDS.contrast.max - AUTO_BOUNDS.contrast.min);

        // Saturation: dull images want deepening; already-vivid ones barely any.
        // `saturation` is mean chroma in 0..1.
        let saturation = AUTO_BOUNDS.saturation.min +
            need(stats.saturation, 0.12, 0.5) * (AUTO_BOUNDS.saturation.max - AUTO_BOUNDS.saturation.min);

        return {
            sharpen: clampTo(sharpen, AUTO_BOUNDS.sharpen),
            contrast: clampTo(contrast, AUTO_BOUNDS.contrast),
            saturation: clampTo(saturation, AUTO_BOUNDS.saturation),
        };
    }

    // Cheap single-pass statistics over a subsampled grid of `pixbuf`:
    //   detail       — mean absolute horizontal+vertical luma gradient (0..255),
    //                   a proxy for how sharp/detailed the image already is.
    //   contrastRms  — std-dev of luma (0..255), how much tonal spread it has.
    //   saturation   — mean chroma = (max−min)/max over RGB (0..1).
    // Subsamples so a 4K wallpaper is analysed in a few thousand reads rather
    // than millions. Returns null on an unsupported layout.
    _imageStats(pixbuf) {
        let w = pixbuf.get_width();
        let h = pixbuf.get_height();
        let channels = pixbuf.get_n_channels();
        let rowstride = pixbuf.get_rowstride();
        if (channels < 3 || pixbuf.get_bits_per_sample() !== 8 || w < 3 || h < 3)
            return null;

        let px = pixbuf.get_pixels();
        let luma = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

        // Aim for ~120 samples on each axis; step at least 1px.
        let stepX = Math.max(1, Math.floor(w / 120));
        let stepY = Math.max(1, Math.floor(h / 120));

        let n = 0;
        let sumL = 0, sumL2 = 0;   // for mean + std-dev of luma
        let sumGrad = 0;           // for mean gradient (detail)
        let sumSat = 0;            // for mean chroma

        for (let y = 0; y < h - stepY; y += stepY) {
            for (let x = 0; x < w - stepX; x += stepX) {
                let i = y * rowstride + x * channels;
                let l = luma(i);
                sumL += l;
                sumL2 += l * l;

                // Gradient against the neighbours one step right and down.
                let lRight = luma(y * rowstride + (x + stepX) * channels);
                let lDown = luma((y + stepY) * rowstride + x * channels);
                sumGrad += Math.abs(l - lRight) + Math.abs(l - lDown);

                let r = px[i], g = px[i + 1], b = px[i + 2];
                let max = r > g ? (r > b ? r : b) : (g > b ? g : b);
                let min = r < g ? (r < b ? r : b) : (g < b ? g : b);
                sumSat += max > 0 ? (max - min) / max : 0;

                n++;
            }
        }
        if (n === 0)
            return null;

        let mean = sumL / n;
        let variance = Math.max(0, sumL2 / n - mean * mean);
        return {
            detail: sumGrad / n / 2,       // averaged over the two directions
            contrastRms: Math.sqrt(variance),
            saturation: sumSat / n,
        };
    }

    // Apply an unsharp mask plus contrast and saturation grading to `pixbuf`
    // at the given `strengths` ({ sharpen, contrast, saturation }), returning a
    // new Pixbuf (or null on an unsupported layout). Operates on the raw byte
    // buffer in one pass over the pixels; the blur used by the unsharp mask is a
    // separable-free 3×3 box read straight from the source rows.
    _sharpenAndGrade(pixbuf, strengths) {
        let w = pixbuf.get_width();
        let h = pixbuf.get_height();
        let channels = pixbuf.get_n_channels();
        let hasAlpha = pixbuf.get_has_alpha();
        let rowstride = pixbuf.get_rowstride();
        // GdkPixbuf only ever hands us 8-bit RGB(A). Bail defensively otherwise.
        if (channels < 3 || pixbuf.get_bits_per_sample() !== 8)
            return null;

        let src = pixbuf.get_pixels(); // read-only bytes of the source
        let out = new Uint8Array(src.length);
        out.set(src); // copy through alpha and untouched edge pixels

        // Precompute the contrast/saturation lookup is impractical (saturation
        // mixes channels), so we grade inline per pixel. Luma weights are the
        // usual Rec.601 coefficients.
        let amount = strengths.sharpen;
        let contrast = strengths.contrast;
        let sat = strengths.saturation;

        let clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                let i = y * rowstride + x * channels;
                for (let c = 0; c < 3; c++) {
                    let p = i + c;
                    // 3×3 box blur of the neighbourhood → low-pass estimate.
                    let blur = (
                        src[p - rowstride - channels] + src[p - rowstride] + src[p - rowstride + channels] +
                        src[p - channels]             + src[p]             + src[p + channels] +
                        src[p + rowstride - channels] + src[p + rowstride] + src[p + rowstride + channels]
                    ) / 9;
                    // Unsharp mask: add back the high-frequency detail.
                    out[p] = clamp(src[p] + amount * (src[p] - blur));
                }

                // Contrast + saturation grade on the sharpened RGB.
                let r = out[i], g = out[i + 1], b = out[i + 2];
                r = clamp((r - 128) * contrast + 128);
                g = clamp((g - 128) * contrast + 128);
                b = clamp((b - 128) * contrast + 128);
                let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                out[i]     = clamp(luma + (r - luma) * sat);
                out[i + 1] = clamp(luma + (g - luma) * sat);
                out[i + 2] = clamp(luma + (b - luma) * sat);
            }
        }

        return GdkPixbuf.Pixbuf.new_from_bytes(
            new GLib.Bytes(out), GdkPixbuf.Colorspace.RGB,
            hasAlpha, 8, w, h, rowstride);
    }

    // --- Applying ---

    // Point GNOME at `path` for both the light and dark background, and make
    // sure it's actually drawn as a zoomed picture. Restarts the rotation timer
    // so the next auto-switch is a full interval away from this manual pick.
    setWallpaper(path) {
        if (!path)
            return false;
        try {
            // Remember the *source* path before it's swapped for a landscape
            // cache copy; getWallpapers() matches against this to keep our place
            // in the rotation (see _currentPath).
            let srcPath = path;
            path = this._landscapeCopyFor(path);
            // Enhance last, so we sharpen the exact pixels GNOME renders
            // (including any landscape-rotated copy).
            path = this._enhanceCopyFor(path);
            let uri = Gio.File.new_for_path(path).get_uri();
            this._bg.set_string('picture-uri', uri);
            this._bg.set_string('picture-uri-dark', uri);
            // A folder of user images is almost never the exact monitor size;
            // 'zoom' fills without distortion. Only set it if the user left it
            // at 'none' (a blank/solid-colour desktop) so we don't override a
            // deliberate 'wallpaper'/'centered' choice.
            if (this._bg.get_string('picture-options') === 'none')
                this._bg.set_string('picture-options', 'zoom');
            Gio.Settings.sync();
            this._currentPath = srcPath;
            // Restart the countdown from this pick.
            if (this._shouldRun())
                this._syncTimer();
            return true;
        } catch (e) {
            console.error('NotchNux: Failed to set wallpaper', e);
            return false;
        }
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
