// The island's silhouette: concave "shoulders" that flare the top corners
// into the screen edge, and the optional glass backdrop.
//
// Glass used to be a Shell.BlurEffect in BACKGROUND mode on the surface. That
// mode re-reads the framebuffer under the actor, so (a) it always paints a
// square rectangle — the blur poked out past the rounded bottom corners — and
// (b) on a partial repaint the pixels it samples outside the clip are last
// frame's notch, so the tint fed back into itself as dark smears that a
// screenshot (a fresh full repaint) never shows. Here the blur instead runs in
// ACTOR mode over a clone of the window group (wallpaper + windows, never the
// notch itself) and a small shader masks it to the island's rounded shape.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

// Solid island fill. The shoulders are painted in Cairo and must match it.
export const ISLAND_RGB = [0, 0, 0];
// Collapsed pill height (the alert bar is a few px taller).
export const PILL_HEIGHT = 40;
export const SHOULDER_SIZE = 12;

const MASK_DECLARATIONS = `
uniform vec2 size;
uniform vec2 shape;
uniform float radius;
`;

// Rounded bottom corners only: the island's top edge is flush with the screen.
// The backdrop can be larger than the island (see GlassBackdrop.sync), so
// `shape` is the island's own size inside the `size`-sized texture and
// everything outside it is cut away.
// cogl_color_out is premultiplied, so scaling every channel fades it cleanly.
const MASK_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
if (p.x > shape.x || p.y > shape.y) {
    cogl_color_out = vec4(0.0);
} else if (p.y > shape.y - radius) {
    float cx = clamp(p.x, radius, shape.x - radius);
    float d = length(p - vec2(cx, shape.y - radius)) - radius;
    cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
}
`;

const RoundedMaskEffect = GObject.registerClass(
class RoundedMaskEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLoc = this.get_uniform_location('size');
        this._shapeLoc = this.get_uniform_location('shape');
        this._radiusLoc = this.get_uniform_location('radius');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, MASK_DECLARATIONS, MASK_CODE, false);
    }

    setShape(boxWidth, boxHeight, width, height, radius) {
        this.set_uniform_float(this._sizeLoc, 2, [boxWidth, boxHeight]);
        this.set_uniform_float(this._shapeLoc, 2, [width, height]);
        this.set_uniform_float(this._radiusLoc, 1, [radius]);
        this.queue_repaint();
    }
});

// One concave corner piece. `side` is -1 (left of the island) or 1 (right).
// The filled area is the square minus a quarter circle centred on its outer
// bottom corner, so the island's straight side curves out into the top edge.
export function createShoulder(side) {
    let s = SHOULDER_SIZE;
    let area = new St.DrawingArea({
        width: s, height: s,
        x_expand: true, y_expand: true,
        x_align: side < 0 ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.START,
        translation_x: side * s,
        reactive: false,
    });
    area.connect('repaint', () => {
        let cr = area.get_context();
        let [r, g, b] = ISLAND_RGB;
        cr.setSourceRGBA(r / 255, g / 255, b / 255, 1);
        if (side < 0) {
            cr.moveTo(0, 0);
            cr.lineTo(s, 0);
            cr.lineTo(s, s);
            cr.arcNegative(0, s, s, 0, -Math.PI / 2);
        } else {
            cr.moveTo(s, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, s);
            cr.arc(s, s, s, Math.PI, 3 * Math.PI / 2);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    });
    return area;
}

// Blurred copy of whatever is behind the island. Lives under the surface in
// the island's BinLayout, pinned to its top-left corner; the owner calls
// sync() whenever the island moves, resizes or changes corner radius.
//
// The blur keeps offscreen buffers the size of this actor and reallocates
// them whenever that size changes. Following the island's size during a
// spring meant new GPU buffers on every frame of every open/close/peek, which
// is what made the animations stutter with glass on. So while the island is
// in flight the backdrop holds one size big enough for the whole flight
// (setEnvelope) and only the mask uniforms follow the island; once it
// settles the backdrop shrinks back to the island's exact size.
export class GlassBackdrop {
    constructor() {
        // BinLayout would clamp the backdrop to the island's size, so it sits
        // in a FixedLayout holder that fills the island and lets it keep its
        // own (possibly larger) size.
        this.actor = new St.Widget({
            x_expand: true, y_expand: true,
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            visible: false,
        });
        this._backdrop = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
            // Sized explicitly in sync(); never the clone's full-screen size.
            width: 1, height: 1,
        });
        this.actor.add_child(this._backdrop);
        this._clone = new Clutter.Clone({ source: global.window_group, reactive: false });
        this._backdrop.add_child(this._clone);
        // Effects run outermost-first: the mask wraps the blur's output.
        this._mask = new RoundedMaskEffect();
        this._backdrop.add_effect(this._mask);
        this._blur = new Shell.BlurEffect({ mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1 });
        this._backdrop.add_effect(this._blur);
        this._envelope = null;
        this._shape = [0, 0, 0];
        this._box = [0, 0];
    }

    setBlur(radius, brightness) {
        if (this._blur.radius !== radius)
            this._blur.radius = radius;
        if (brightness !== undefined && this._blur.brightness !== brightness)
            this._blur.brightness = brightness;
    }

    // Hold a fixed backdrop size for a flight; null returns to exact sizing.
    setEnvelope(width, height) {
        this._envelope = width > 0 && height > 0
            ? [Math.ceil(width), Math.ceil(height)] : null;
    }

    // Stage position and size of the island + its bottom corner radius, and
    // the hover-swell scale. Translation (not position) offsets the clone so
    // moving never relayouts.
    sync(x, y, width, height, radius, scaleX = 1, scaleY = 1) {
        this._clone.translation_x = -x;
        this._clone.translation_y = -y;
        if (width <= 0 || height <= 0)
            return;
        let [bw, bh] = this._envelope ?? [Math.ceil(width), Math.ceil(height)];
        bw = Math.max(bw, Math.ceil(width));
        bh = Math.max(bh, Math.ceil(height));
        if (bw !== this._box[0] || bh !== this._box[1]) {
            this._box = [bw, bh];
            this._backdrop.set_size(bw, bh);
        }
        this._backdrop.set_pivot_point(width / 2 / bw, 0);
        this._backdrop.scale_x = scaleX;
        this._backdrop.scale_y = scaleY;
        let r = Math.min(radius, width / 2, height);
        let [sw, sh, sr] = this._shape;
        if (sw !== width || sh !== height || sr !== r || this._maskBox !== `${bw}x${bh}`) {
            this._shape = [width, height, r];
            this._maskBox = `${bw}x${bh}`;
            this._mask.setShape(bw, bh, width, height, r);
        }
    }

    destroy() {
        this.actor.destroy();
        this._backdrop = null;
        this._clone = null;
        this._mask = null;
        this._blur = null;
    }
}
