// Cairo-drawn UI components for the NotchNux "Nook" dashboard.
//
// The Nook design concept leans on visuals St's CSS engine can't produce —
// conic gradients (vinyl label, volume knob, radial meters), radial groove
// patterns, and continuous animation. St has no CSS `animation` and no
// conic/repeating gradients, so those elements are drawn with Cairo on
// St.DrawingArea and animated with Clutter timelines/rotations instead.
//
// Every widget exposes a `.actor` (or *is* the St actor) plus a small update
// API so the renderers in notchnux.js can rebind them to live data cheaply
// without reconstructing the Cairo scene from scratch.

import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import GLib from 'gi://GLib';

// Shared palette — mirrors the concept's tokens (--acc / --acc2 etc.).
// ACCENT / ACCENT2 are intentionally mutable arrays, not frozen constants:
// every Cairo widget reads ACCENT[0..2] at *draw* time, so setAccent() can
// recolour the whole dashboard by mutating these arrays in place (the export
// binding stays the same, only the contents change) and asking widgets to
// repaint. AMBER is a fixed secondary and never changes.
export const ACCENT = [0.478, 0.635, 1.0];      // #7aa2ff
export const ACCENT2 = [0.655, 0.749, 1.0];     // #a7bfff
export const AMBER = [0.910, 0.690, 0.416];     // #e8b06a

// Recolour the shared accent from an [r, g, b] triple (channels in 0..1).
// ACCENT2 is derived as a lighter tint of the base, mirroring the original
// #7aa2ff -> #a7bfff relationship, so gradients keep their two-stop depth.
export function setAccent(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3)
        return;
    ACCENT[0] = rgb[0]; ACCENT[1] = rgb[1]; ACCENT[2] = rgb[2];
    // Lift each channel ~40% of the way toward white for the highlight tint.
    ACCENT2[0] = rgb[0] + (1 - rgb[0]) * 0.4;
    ACCENT2[1] = rgb[1] + (1 - rgb[1]) * 0.4;
    ACCENT2[2] = rgb[2] + (1 - rgb[2]) * 0.4;
}

// "#rrggbb" for the current accent — handy for building St inline styles that
// must override the stylesheet's hardcoded blue.
export function accentHex() {
    let to = c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
    return '#' + to(ACCENT[0]) + to(ACCENT[1]) + to(ACCENT[2]);
}

// "r, g, b" (0..255) for building rgba(...) inline styles at a chosen alpha.
export function accentRgbStr() {
    let to = c => Math.round(Math.max(0, Math.min(1, c)) * 255);
    return `${to(ACCENT[0])}, ${to(ACCENT[1])}, ${to(ACCENT[2])}`;
}
const TRACK = [1, 1, 1, 0.14];                   // faint ring track
const FACE = [0.075, 0.075, 0.094];              // #131317 inner disc face

function setSource(cr, rgb, a = 1) {
    cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], rgb.length > 3 ? rgb[3] : a);
}

// ============================================================
// Spinning vinyl record
// ============================================================
// A dark disc with concentric grooves and a coloured centre label. Cairo has
// no conic gradient, so the "rainbow" label is faked with an off-centre radial
// gradient; the illusion of a pressed record comes from the continuous spin,
// driven by a Clutter rotation timeline (not CSS, which St lacks).
export const Vinyl = GObject.registerClass(
class Vinyl extends St.DrawingArea {
    _init(size = 148) {
        super._init({ width: size, height: size, style_class: 'nook-vinyl' });
        this._size = size;
        this._spinning = false;
        this._spinId = 0;
        this.set_pivot_point(0.5, 0.5);
        this.connect('repaint', () => this._draw());
    }

    _draw() {
        let cr = this.get_context();
        let s = this._size;
        let c = s / 2;
        let r = c - 1;

        // Disc body.
        cr.arc(c, c, r, 0, 2 * Math.PI);
        setSource(cr, [0.039, 0.039, 0.051]); // #0a0a0d
        cr.fill();

        // Concentric grooves.
        cr.setLineWidth(1);
        for (let gr = r - 4; gr > s * 0.22; gr -= 3) {
            cr.arc(c, c, gr, 0, 2 * Math.PI);
            setSource(cr, [0.098, 0.098, 0.125], 0.55); // #191920-ish
            cr.stroke();
        }

        // Sheen highlight (top-left).
        let grad = new Cairo.RadialGradient(
            c * 0.76, c * 0.6, 2, c * 0.76, c * 0.6, r);
        grad.addColorStopRGBA(0, 1, 1, 1, 0.14);
        grad.addColorStopRGBA(0.45, 1, 1, 1, 0);
        cr.arc(c, c, r, 0, 2 * Math.PI);
        cr.setSource(grad);
        cr.fill();

        // Centre label — off-centre radial to suggest the pressed rainbow.
        let lr = s * 0.2;
        let label = new Cairo.RadialGradient(
            c - lr * 0.3, c - lr * 0.4, 1, c, c, lr);
        label.addColorStopRGBA(0, AMBER[0], AMBER[1], AMBER[2], 1);
        label.addColorStopRGBA(0.4, 0.776, 0.416, 0.478, 1);   // #c66a7a
        label.addColorStopRGBA(0.7, 0.490, 0.420, 0.659, 1);   // #7d6ba8
        label.addColorStopRGBA(1, ACCENT[0] * 0.9, 0.58, 0.75, 1);
        cr.arc(c, c, lr, 0, 2 * Math.PI);
        cr.setSource(label);
        cr.fill();
        // Label rim.
        cr.arc(c, c, lr, 0, 2 * Math.PI);
        cr.setLineWidth(2.5);
        setSource(cr, FACE);
        cr.stroke();

        // Spindle hole.
        cr.arc(c, c, s * 0.027, 0, 2 * Math.PI);
        setSource(cr, FACE);
        cr.fill();

        cr.arc(c, c, r - 0.75, 0, 2 * Math.PI);
        cr.setLineWidth(1.5);
        setSource(cr, [1, 1, 1], 0.16);
        cr.stroke();

        cr.$dispose();
    }

    startSpin() {
        if (this._spinning) return;
        this._spinning = true;
        this._spinStartedAt = GLib.get_monotonic_time();
        this._spinId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._spinning)
                return GLib.SOURCE_REMOVE;
            let elapsedMs = (GLib.get_monotonic_time() - this._spinStartedAt) / 1000;
            this.rotation_angle_z = (elapsedMs / 9000 * 360) % 360;
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopSpin() {
        this._spinning = false;
        if (this._spinId) {
            GLib.Source.remove(this._spinId);
            this._spinId = 0;
        }
        this.remove_all_transitions();
    }
});

export const AlbumArtDisc = GObject.registerClass(
class AlbumArtDisc extends St.Widget {
    _init(size = 52) {
        super._init({
            width: size,
            height: size,
            style_class: 'nook-vinyl-art',
            visible: false
        });
        this._size = size;
    }

    setArtPath(path) {
        if (!path) {
            this.set_style('');
            this.visible = false;
            return;
        }

        try {
            let uri = GLib.filename_to_uri(path, null);
            this.set_style(`background-image: url("${uri}"); background-size: cover; background-position: center;`);
            this.visible = true;
        } catch (e) {
            console.error('NotchNux: Failed to load circular album art', e);
            this.set_style('');
            this.visible = false;
        }
    }
});

// ============================================================
// Volume / dial knob
// ============================================================
// A filled arc (the "conic" fill the concept draws) around a raised knob, with
// a glowing pointer at the current value and the numeric value in the centre.
export const Knob = GObject.registerClass(
class Knob extends St.DrawingArea {
    _init(size = 76) {
        super._init({ width: size, height: size, style_class: 'nook-knob' });
        this._size = size;
        this._value = 0.72; // 0..1
        this._destroyed = false;
        this._repaintId = this.connect('repaint', () => this._draw());
        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._repaintId) {
                this.disconnect(this._repaintId);
                this._repaintId = 0;
            }
        });
    }

    setValue(v) {
        if (this._destroyed)
            return;
        this._value = Math.max(0, Math.min(1, v));
        this.queue_repaint();
    }

    _draw() {
        if (this._destroyed)
            return;

        let cr;
        try {
            cr = this.get_context();
        } catch (e) {
            this._destroyed = true;
            return;
        }
        let s = this._size;
        let c = s / 2;
        let r = c - 3;
        // Sweep from 135° to 405° (i.e. a 270° gauge with the gap at the bottom).
        let start = (135 * Math.PI) / 180;
        let sweep = (270 * Math.PI) / 180;
        let end = start + sweep * this._value;

        // Track.
        cr.setLineWidth(6);
        cr.setLineCap(Cairo.LineCap.ROUND);
        setSource(cr, TRACK);
        cr.arc(c, c, r, start, start + sweep);
        cr.stroke();

        // Filled value arc.
        setSource(cr, ACCENT);
        cr.arc(c, c, r, start, end);
        cr.stroke();

        // Raised knob face.
        let face = new Cairo.RadialGradient(
            c, c - r * 0.4, 2, c, c, r * 0.7);
        face.addColorStopRGBA(0, 0.149, 0.149, 0.173, 1); // #26262c
        face.addColorStopRGBA(1, 0.078, 0.078, 0.094, 1); // #141418
        cr.arc(c, c, r * 0.66, 0, 2 * Math.PI);
        cr.setSource(face);
        cr.fill();

        // Pointer at the current value.
        let px = c + Math.cos(end) * r * 0.5;
        let py = c + Math.sin(end) * r * 0.5;
        let ix = c + Math.cos(end) * r * 0.24;
        let iy = c + Math.sin(end) * r * 0.24;
        cr.setLineWidth(3.5);
        setSource(cr, ACCENT);
        cr.moveTo(ix, iy);
        cr.lineTo(px, py);
        cr.stroke();

        cr.$dispose();
    }
});

// ============================================================
// Radial ring meter (CPU / RAM / disk)
// ============================================================
export const RingMeter = GObject.registerClass(
class RingMeter extends St.DrawingArea {
    _init(size = 56, color = ACCENT) {
        super._init({ width: size, height: size, style_class: 'nook-ring' });
        this._size = size;
        this._value = 0;   // 0..1
        this._color = color;
        this.connect('repaint', () => this._draw());
    }

    setValue(v) {
        this._value = Math.max(0, Math.min(1, v));
        this.queue_repaint();
    }

    _draw() {
        let cr = this.get_context();
        let s = this._size;
        let c = s / 2;
        let r = c - 3;
        let start = -Math.PI / 2; // 12 o'clock
        cr.setLineWidth(5);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Track ring.
        setSource(cr, [1, 1, 1, 0.1]);
        cr.arc(c, c, r, 0, 2 * Math.PI);
        cr.stroke();

        // Value ring.
        if (this._value > 0.001) {
            setSource(cr, this._color);
            cr.arc(c, c, r, start, start + 2 * Math.PI * this._value);
            cr.stroke();
        }

        // Inner face so the label sits on solid dark.
        cr.arc(c, c, r - 6, 0, 2 * Math.PI);
        setSource(cr, FACE);
        cr.fill();

        cr.$dispose();
    }
});

// ============================================================
// Analog clock
// ============================================================
export const AnalogClock = GObject.registerClass(
class AnalogClock extends St.DrawingArea {
    _init(size = 150) {
        super._init({ width: size, height: size, style_class: 'nook-clock' });
        this._size = size;
        this._date = new Date();
        this.connect('repaint', () => this._draw());
    }

    setDate(d) {
        this._date = d;
        this.queue_repaint();
    }

    _draw() {
        let cr = this.get_context();
        let s = this._size;
        let c = s / 2;
        let r = c - 3;

        // Flat minimal face: a single soft disc, no rim clutter. The tint is
        // barely there so the numerals and hands carry the design.
        cr.arc(c, c, r, 0, 2 * Math.PI);
        setSource(cr, [1, 1, 1, 0.03]);
        cr.fill();

        // Cardinal numerals only — 12 / 3 / 6 / 9 — set just inside the rim.
        // Cairo's toy text API (selectFontFace/showText) renders nothing on
        // St's DrawingArea context, so lay the glyphs out with PangoCairo,
        // which does draw reliably in the Shell.
        let fontSize = Math.round(s * 0.13);
        let layout = PangoCairo.create_layout(cr);
        let desc = Pango.FontDescription.from_string(`Sans Bold ${fontSize}px`);
        layout.set_font_description(desc);
        setSource(cr, [1, 1, 1, 0.85]);
        const numR = r - fontSize;   // radius the numerals sit on
        const nums = [
            { n: '12', a: -Math.PI / 2 },
            { n: '3',  a: 0 },
            { n: '6',  a: Math.PI / 2 },
            { n: '9',  a: Math.PI },
        ];
        for (let { n, a } of nums) {
            layout.set_text(n, -1);
            let [w, h] = layout.get_pixel_size();
            // Center the glyph box on its position on the numeral circle.
            let x = c + Math.cos(a) * numR - w / 2;
            let y = c + Math.sin(a) * numR - h / 2;
            cr.moveTo(x, y);
            PangoCairo.show_layout(cr, layout);
        }
        cr.newPath();

        let d = this._date;
        let hours = d.getHours() % 12;
        let mins = d.getMinutes();
        let secs = d.getSeconds();
        // Thin, round-capped hands with a short back-tail for balance.
        cr.setLineCap(Cairo.LineCap.ROUND);
        let hand = (angleFrac, len, width, rgb) => {
            let a = angleFrac * 2 * Math.PI - Math.PI / 2;
            cr.setLineWidth(width);
            setSource(cr, rgb);
            cr.moveTo(c - Math.cos(a) * (len * 0.16), c - Math.sin(a) * (len * 0.16));
            cr.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
            cr.stroke();
        };
        // Hour, minute (soft white), second (accent, thinnest).
        hand((hours + mins / 60) / 12, r * 0.48, 3, [0.949, 0.949, 0.957]);
        hand((mins + secs / 60) / 60, r * 0.68, 2, [0.949, 0.949, 0.957]);
        hand(secs / 60, r * 0.74, 1, ACCENT);

        // Hub: accent dot ringed by the face colour for a floating look.
        cr.arc(c, c, 3.5, 0, 2 * Math.PI);
        setSource(cr, ACCENT);
        cr.fill();
        cr.arc(c, c, 1.4, 0, 2 * Math.PI);
        setSource(cr, [0.075, 0.075, 0.094]);
        cr.fill();

        cr.$dispose();
    }
});

// ============================================================
// Equalizer bars (the "now playing" animation)
// ============================================================
// Four thin bars whose scale_y bounces on staggered Clutter tweens — again
// standing in for the CSS @keyframes the concept uses, which St can't run.
export const EqBars = GObject.registerClass(
class EqBars extends St.BoxLayout {
    _init() {
        super._init({ style_class: 'nook-eq', y_align: Clutter.ActorAlign.END });
        this._bars = [];
        this._running = false;
        let delays = [100, 500, 800, 300];
        // Tint the bars with the live accent (CSS hardcodes blue). EqBars is
        // rebuilt on each media render, so reading accent here keeps it current.
        let accentStyle = `background-color: ${accentHex()};`;
        for (let i = 0; i < 4; i++) {
            let bar = new St.Widget({ style_class: 'nook-eq-bar', y_align: Clutter.ActorAlign.END });
            bar.set_style(accentStyle);
            bar.set_pivot_point(0.5, 1.0);
            bar.scale_y = 0.3;
            this.add_child(bar);
            this._bars.push({ actor: bar, delay: delays[i] });
        }
    }

    // Re-tint the bars to the current accent. Used for the persistent pill EQ,
    // which is built once and must recolour live when the accent changes.
    setAccentColor() {
        let style = `background-color: ${accentHex()};`;
        for (let b of this._bars) b.actor.set_style(style);
    }

    start() {
        if (this._running) return;
        this._running = true;
        for (let b of this._bars) {
            b._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, b.delay, () => {
                this._bounce(b.actor);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _bounce(actor) {
        if (!this._running) return;
        actor.ease({
            scale_y: 0.25 + Math.random() * 0.75,
            duration: 260 + Math.random() * 220,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                if (!this._running) return;
                actor._bounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                    actor._bounceId = 0;
                    this._bounce(actor);
                    return GLib.SOURCE_REMOVE;
                });
            },
        });
    }

    stop() {
        this._running = false;
        for (let b of this._bars) {
            if (b._id) { GLib.Source.remove(b._id); b._id = 0; }
            if (b.actor._bounceId) { GLib.Source.remove(b.actor._bounceId); b.actor._bounceId = 0; }
            b.actor.remove_all_transitions();
            b.actor.scale_y = 0.3;
        }
    }
});

// ============================================================
// Rounded-corner masking effect
// ============================================================
// A GLSL fragment shader that discards fragments falling outside a rounded
// rectangle, so pushed pixel content (St.ImageContent) can honour a corner
// radius the way CSS border-radius would. `size` is the (square) actor edge in
// px and `radius` the corner radius in px; both map into 0..1 texture space.
export const RoundedCornerEffect = GObject.registerClass(
class RoundedCornerEffect extends Clutter.ShaderEffect {
    _init(size, radius) {
        // Clutter.ShaderType was removed in modern Clutter (GNOME 47+, still
        // gone in Clutter 18 / GNOME 50) even though ShaderEffect itself
        // survives. The property's default is already the fragment shader, so
        // only pass shader_type on the older shells that still expose the enum.
        let params = {};
        if (Clutter.ShaderType && Clutter.ShaderType.FRAGMENT_SHADER !== undefined)
            params.shader_type = Clutter.ShaderType.FRAGMENT_SHADER;
        super._init(params);
        // Corner radius as a fraction of the edge (uv is 0..1 across the actor).
        let r = radius / size;
        this.set_shader_source(`
            uniform sampler2D tex;
            void main() {
                vec2 uv = cogl_tex_coord_in[0].xy;
                float r = ${r.toFixed(6)};
                // Distance from uv into the nearest corner's rounded region.
                vec2 d = max(vec2(r) - min(uv, 1.0 - uv), 0.0);
                if (length(d) > r)
                    discard;
                cogl_color_out = texture2D(tex, uv) * cogl_color_in;
            }
        `);
    }

    vfunc_paint_target(node, paint_context) {
        this.set_uniform_value('tex', 0);
        super.vfunc_paint_target(node, paint_context);
    }
});

// ============================================================
// Live camera preview surface (Studio tab)
// ============================================================
// A rounded square that shows raw webcam frames. Clutter/St has no video
// widget, so frames are pushed in as pixel bytes via St.ImageContent.set_bytes
// (the same mechanism the appindicator extension uses for tray pixmaps). The
// MediaHelper feeds RGB buffers to setFrame(); when idle we just show a dark
// face with a placeholder icon.
export const CameraView = GObject.registerClass(
class CameraView extends St.Widget {
    _init(size = 150) {
        super._init({
            style_class: 'nook-cam-view',
            width: size, height: size,
            layout_manager: new Clutter.BinLayout() });
        this._size = size;
        this._content = new St.ImageContent({ preferredWidth: 320, preferredHeight: 240 });
        // Fill the square edge-to-edge (crop the overflow) rather than
        // letterboxing, and mirror horizontally so the preview reads like a
        // selfie. RESIZE_ASPECT_COVER scales to cover; the negative x-scale
        // flips it, and the pivot keeps the flip centred.
        this._surface = new St.Widget({ x_expand: true, y_expand: true });
        this._surface.set_content(this._content);
        this._surface.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT_COVER);
        this._surface.set_pivot_point(0.5, 0.5);
        this._surface.scale_x = -1;
        this.add_child(this._surface);

        // Clip the (over-scaled, mirrored) surface to the rounded square. A
        // plain rectangular clip (set_clip_to_allocation) would leave the video
        // filling the corners and hide the 18px CSS rounding, so round the feed
        // in a fragment shader that discards pixels outside the rounded rect.
        // (St's border-radius only rounds the actor's own paint, not pushed
        // ImageContent, so we mask the surface itself.)
        //
        // RoundedCornerEffect handles the enum-removal across shell versions
        // itself; still wrap it so any shader-compile failure degrades to a
        // rectangular clip (square corners) rather than crashing the whole
        // Studio render.
        try {
            this._round = new RoundedCornerEffect(size, 18);
            this._surface.add_effect(this._round);
        } catch (e) {
            console.error('NotchNux: rounded camera mask unavailable', e);
        }
        this.set_clip_to_allocation(true);

        // Placeholder shown until the first frame lands.
        this._placeholder = new St.Icon({
            icon_name: 'camera-disabled-symbolic',
            icon_size: 40,
            style_class: 'nook-cam-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this._placeholder);

        // set_bytes gained a leading cogl-context arg on newer GNOME; detect it
        // once (same probe the appindicator extension uses).
        this._coglCtx = [];
        try {
            if (this._content.set_bytes.length === 6) {
                let backend = global.stage?.context?.get_backend?.();
                if (backend?.get_cogl_context)
                    this._coglCtx = [backend.get_cogl_context()];
            }
        } catch (e) { /* fall back to 5-arg form */ }
    }

    // Push one RGB frame (Uint8Array, 3 bytes/px) into the preview.
    setFrame(bytes, width, height, stride) {
        try {
            let glibBytes = GLib.Bytes.new(bytes);
            this._content.set_bytes(
                ...this._coglCtx,
                glibBytes,
                Cogl.PixelFormat.RGB_888,
                width, height, stride);
            if (this._placeholder.visible) this._placeholder.visible = false;
        } catch (e) {
            console.error('NotchNux: camera setFrame failed', e);
        }
    }

    // Drop back to the idle placeholder (camera stopped / no device).
    clearFrame() {
        this._placeholder.visible = true;
    }
});
