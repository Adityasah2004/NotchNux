// Out-of-process image work for NotchNux's wallpaper rotation.
//
// Decoding a multi-megapixel photo, rotating it and running a per-pixel
// sharpen/grade loop takes seconds of CPU. Inside gnome-shell that ran on the
// compositor thread and froze the whole desktop, so WallpaperHelper now spawns
// this script with plain `gjs -m` and waits for it asynchronously.
//
//   gjs -m image-worker.js process '<json>'
//       { src, out, landscape, enhance: null | { mode, sharpen, contrast,
//         saturation }, coverW, coverH }
//       Prints {"out": "<path>"} when it wrote `out`, or {"out": null} when the
//       source needs no processing and should be applied as-is.
//
//   gjs -m image-worker.js thumbs '<json>'
//       { items: [{ src, out }], landscape, w, h }
//       Writes a w×h centre-cropped JPEG per item; prints {"done": [src…]}.
//
// Only GLib/Gio/GdkPixbuf are used — no shell libraries — so this runs in any
// gjs. All paths arrive as argv/JSON, never through a shell.

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

// Auto-enhancement centres and clamps. Kept in step with config.js
// (ENHANCE_AUTO / ENHANCE_RANGE) and the prefs sliders.
const SHARPEN_AMOUNT = 0.6;
const CONTRAST = 1.06;
const SATURATION = 1.08;
const AUTO_BOUNDS = {
    sharpen: { min: 0.2, max: 1.2 },
    contrast: { min: 1.0, max: 1.18 },
    saturation: { min: 1.0, max: 1.25 },
};

function loadOriented(src) {
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(src);
    // Honour EXIF orientation first (phone photos are often stored sideways
    // with a corrective tag), so every decision matches how it's viewed.
    return pixbuf.apply_embedded_orientation() || pixbuf;
}

function toLandscape(pixbuf) {
    if (pixbuf.get_height() <= pixbuf.get_width())
        return pixbuf;
    return pixbuf.rotate_simple(GdkPixbuf.PixbufRotation.COUNTERCLOCKWISE) || pixbuf;
}

// Scale down (never up) so the image still covers coverW×coverH. Enhancing at
// display resolution is both faster and visually what the user sees.
function scaleToCover(pixbuf, coverW, coverH) {
    let w = pixbuf.get_width(), h = pixbuf.get_height();
    if (!coverW || !coverH)
        return pixbuf;
    let scale = Math.max(coverW / w, coverH / h);
    if (scale >= 1)
        return pixbuf;
    return pixbuf.scale_simple(Math.round(w * scale), Math.round(h * scale),
        GdkPixbuf.InterpType.HYPER) || pixbuf;
}

// Subsampled statistics: detail (mean luma gradient 0..255), contrastRms
// (luma std-dev) and saturation (mean chroma 0..1).
function imageStats(pixbuf) {
    let w = pixbuf.get_width();
    let h = pixbuf.get_height();
    let channels = pixbuf.get_n_channels();
    let rowstride = pixbuf.get_rowstride();
    if (channels < 3 || pixbuf.get_bits_per_sample() !== 8 || w < 3 || h < 3)
        return null;
    let px = pixbuf.get_pixels();
    let luma = i => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    let stepX = Math.max(1, Math.floor(w / 120));
    let stepY = Math.max(1, Math.floor(h / 120));
    let n = 0, sumL = 0, sumL2 = 0, sumGrad = 0, sumSat = 0;
    for (let y = 0; y < h - stepY; y += stepY) {
        for (let x = 0; x < w - stepX; x += stepX) {
            let i = y * rowstride + x * channels;
            let l = luma(i);
            sumL += l;
            sumL2 += l * l;
            sumGrad += Math.abs(l - luma(y * rowstride + (x + stepX) * channels)) +
                Math.abs(l - luma((y + stepY) * rowstride + x * channels));
            let r = px[i], g = px[i + 1], b = px[i + 2];
            let max = Math.max(r, g, b), min = Math.min(r, g, b);
            sumSat += max > 0 ? (max - min) / max : 0;
            n++;
        }
    }
    if (n === 0)
        return null;
    let mean = sumL / n;
    return {
        detail: sumGrad / n / 2,
        contrastRms: Math.sqrt(Math.max(0, sumL2 / n - mean * mean)),
        saturation: sumSat / n,
    };
}

// Flat/soft images get pushed harder, already-punchy ones are left alone.
function autoStrengths(pixbuf) {
    let stats = imageStats(pixbuf);
    if (!stats)
        return { sharpen: SHARPEN_AMOUNT, contrast: CONTRAST, saturation: SATURATION };
    let need = (v, low, high) => (v <= low ? 1 : v >= high ? 0 : (high - v) / (high - low));
    let span = b => b.max - b.min;
    return {
        sharpen: AUTO_BOUNDS.sharpen.min + need(stats.detail, 3, 22) * span(AUTO_BOUNDS.sharpen),
        contrast: AUTO_BOUNDS.contrast.min + need(stats.contrastRms, 30, 70) * span(AUTO_BOUNDS.contrast),
        saturation: AUTO_BOUNDS.saturation.min + need(stats.saturation, 0.12, 0.5) * span(AUTO_BOUNDS.saturation),
    };
}

// Unsharp mask (3×3 box low-pass) + contrast + saturation in one pass.
function sharpenAndGrade(pixbuf, { sharpen: amount, contrast, saturation: sat }) {
    let w = pixbuf.get_width();
    let h = pixbuf.get_height();
    let channels = pixbuf.get_n_channels();
    let rowstride = pixbuf.get_rowstride();
    if (channels < 3 || pixbuf.get_bits_per_sample() !== 8)
        return null;
    let src = pixbuf.get_pixels();
    let out = new Uint8Array(src.length);
    out.set(src);
    let clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            let i = y * rowstride + x * channels;
            for (let c = 0; c < 3; c++) {
                let p = i + c;
                let blur = (
                    src[p - rowstride - channels] + src[p - rowstride] + src[p - rowstride + channels] +
                    src[p - channels] + src[p] + src[p + channels] +
                    src[p + rowstride - channels] + src[p + rowstride] + src[p + rowstride + channels]
                ) / 9;
                out[p] = clamp(src[p] + amount * (src[p] - blur));
            }
            let r = clamp((out[i] - 128) * contrast + 128);
            let g = clamp((out[i + 1] - 128) * contrast + 128);
            let b = clamp((out[i + 2] - 128) * contrast + 128);
            let l = 0.299 * r + 0.587 * g + 0.114 * b;
            out[i] = clamp(l + (r - l) * sat);
            out[i + 1] = clamp(l + (g - l) * sat);
            out[i + 2] = clamp(l + (b - l) * sat);
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(out), GdkPixbuf.Colorspace.RGB,
        pixbuf.get_has_alpha(), 8, w, h, rowstride);
}

function save(pixbuf, out, quality) {
    let tmp = `${out}.part`;
    if (pixbuf.get_has_alpha())
        pixbuf.savev(tmp, 'png', [], []);
    else
        pixbuf.savev(tmp, 'jpeg', ['quality'], [String(quality)]);
    // Rename into place so the shell never reads a half-written file.
    GLib.rename(tmp, out);
}

function processOne(o) {
    let needsLandscape = false;
    if (o.landscape) {
        // Cheap header read; only fully decode things that might be portrait.
        let [, w, h] = GdkPixbuf.Pixbuf.get_file_info(o.src);
        needsLandscape = !(w > 0 && h > 0 && w > h);
    }
    if (!needsLandscape && !o.enhance)
        return null;

    let pixbuf = loadOriented(o.src);
    let rotated = false;
    if (o.landscape && pixbuf.get_height() > pixbuf.get_width()) {
        pixbuf = toLandscape(pixbuf);
        rotated = true;
    }
    if (!rotated && !o.enhance)
        return null;
    if (o.enhance) {
        pixbuf = scaleToCover(pixbuf, o.coverW, o.coverH);
        let strengths = o.enhance.mode === 'manual'
            ? { sharpen: o.enhance.sharpen, contrast: o.enhance.contrast, saturation: o.enhance.saturation }
            : autoStrengths(pixbuf);
        pixbuf = sharpenAndGrade(pixbuf, strengths) || pixbuf;
    }
    save(pixbuf, o.out, 95);
    return o.out;
}

function thumbOne(item, o) {
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(item.src, o.w * 3, o.h * 3, true);
    pixbuf = pixbuf.apply_embedded_orientation() || pixbuf;
    if (o.landscape)
        pixbuf = toLandscape(pixbuf);
    // Centre-crop to the thumbnail aspect, then scale to exactly w×h.
    let w = pixbuf.get_width(), h = pixbuf.get_height();
    let target = o.w / o.h;
    let cw = w, ch = h;
    if (w / h > target) cw = Math.round(h * target);
    else ch = Math.round(w / target);
    let cropped = pixbuf.new_subpixbuf(Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), cw, ch);
    let thumb = cropped.scale_simple(o.w, o.h, GdkPixbuf.InterpType.BILINEAR);
    save(thumb, item.out, 85);
}

const [mode, json] = ARGV;
try {
    let o = JSON.parse(json);
    if (mode === 'process') {
        print(JSON.stringify({ out: processOne(o) }));
    } else if (mode === 'thumbs') {
        let done = [];
        for (let item of o.items) {
            try {
                thumbOne(item, o);
                done.push(item.src);
            } catch (e) {
                printerr(`thumb failed for ${item.src}: ${e.message}`);
            }
        }
        print(JSON.stringify({ done }));
    } else {
        throw new Error(`unknown mode ${mode}`);
    }
} catch (e) {
    printerr(`image-worker: ${e.message}`);
    System.exit(1);
}
