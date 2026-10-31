// Slit deck — the Wallpaper tab's picker.
//
// Every image is a thin slanted slit (a parallelogram); the active one opens
// out to its full width. Scrolling slides the whole row so the active slit
// stays centred, and the slits on either side narrow/widen continuously as
// they pass through the middle (an accordion rather than a list).
//
// Motion is one number, `pos` (a fractional index), driven by motion.js's
// velocity-preserving spring. Everything else is derived from it each frame:
// x position, visible width, brightness and a little parallax of the image
// inside its slit. So a fast scroll that retargets mid-flight just keeps
// gliding instead of stopping and restarting.
//
// Performance: each slit is a FIXED-size actor (full active width) whose
// visible window is cut out by a small GLSL mask, and only the mask uniforms
// change while animating. The offscreen buffer behind the effect is therefore
// allocated once instead of every frame (the lesson from the glass blur), and
// nothing relayouts mid-flight except child positions in a FixedLayout. Slits
// outside the deck are hidden so they never paint.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { springTo, stopSpring } from './motion.js';

export const DECK_HEIGHT = 138;
const SLIT_W = 30;         // a resting slit's width
const ACTIVE_W = 224;      // the open slit (≈ the thumbnails' 1.6 aspect)
const GAP = 7;
const SKEW = 24;           // top edge leans this many px right of the bottom
const PARALLAX = 18;       // max image drift inside a slit, px
const EDGE_FADE = 44;      // slits fade out over this distance at the ends
const ACTOR_W = ACTIVE_W + SKEW + 2 * PARALLAX;

const DECLS = `
uniform vec2 size;
uniform float left;
uniform float wid;
uniform float skew;
uniform float dim;
`;

// Inside the parallelogram whose bottom edge spans [left, left + wid] and
// whose top edge is shifted right by `skew`. The two slanted edges are
// anti-aliased over one pixel measured perpendicular to the edge; the colour
// is premultiplied, so scaling every channel by coverage fades it cleanly.
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
float l = left + skew * (1.0 - p.y / size.y);
float k = size.y / sqrt(size.y * size.y + skew * skew);
float a = clamp((p.x - l) * k + 0.5, 0.0, 1.0)
        * clamp((l + wid - p.x) * k + 0.5, 0.0, 1.0);
cogl_color_out.rgb *= dim;
cogl_color_out *= a;
`;

const SlitMask = GObject.registerClass(
class SlitMask extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._loc = {};
        for (let u of ['size', 'left', 'wid', 'skew', 'dim'])
            this._loc[u] = this.get_uniform_location(u);
        this.set_uniform_float(this._loc.size, 2, [ACTOR_W, DECK_HEIGHT]);
        this.set_uniform_float(this._loc.skew, 1, [SKEW]);
        this._last = '';
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLS, CODE, false);
    }

    set(left, wid, dim) {
        // Most slits sit still while two or three move; skip redundant writes.
        let key = `${left.toFixed(2)}|${wid.toFixed(2)}|${dim.toFixed(3)}`;
        if (key === this._last)
            return;
        this._last = key;
        this.set_uniform_float(this._loc.left, 1, [left]);
        this.set_uniform_float(this._loc.wid, 1, [wid]);
        this.set_uniform_float(this._loc.dim, 1, [dim]);
        this.queue_repaint();
    }
});

// 0 → 1 as an item moves from one slot away to dead centre (smoothstepped so
// the width change eases in and out instead of kinking at the ends).
function openness(d) {
    let t = Math.max(0, 1 - Math.abs(d));
    return t * t * (3 - 2 * t);
}

export class SlitDeck {
    // items: [{path, name}]  thumbFor(item) → path|null
    // onPick(index): user clicked a slit.
    constructor({ items, activeIndex, thumbFor, onPick, accent }) {
        this._items = items;
        this._thumbFor = thumbFor;
        this._onPick = onPick;
        this._slits = new Map();   // index → { actor, mask }
        this._hover = -1;
        this._width = 0;
        this._pos = Math.max(0, activeIndex);
        this._target = this._pos;
        this._destroyed = false;

        this.actor = new St.Widget({
            style_class: 'nook-wp-deck',
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            height: DECK_HEIGHT + 14,
            clip_to_allocation: true,
            reactive: true,
        });

        // Accent tick under the open slit: tells you which one is current
        // even while a neighbour is mid-animation.
        this._tick = new St.Widget({ style_class: 'nook-wp-tick', height: 3, width: 28, y: DECK_HEIGHT + 8 });
        if (accent)
            this._tick.set_style(`background-color: ${accent};`);
        this.actor.add_child(this._tick);

        // `pos` as a JS property so springTo can drive it like any actor prop.
        Object.defineProperty(this.actor, 'nnDeckPos', {
            configurable: true,
            get: () => this._pos,
            set: v => { this._pos = v; this._layout(); },
        });

        this.actor.connect('notify::width', () => this._queueLayout());
        this.actor.connect('motion-event', (a, ev) => {
            let [x, y] = ev.get_coords();
            this._setHover(this._hitTest(x, y));
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this._setHover(-1);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('button-press-event', (a, ev) => {
            this._pressIdx = ev.get_button() === 1 ? this._hitTest(...ev.get_coords()) : -1;
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('button-release-event', (a, ev) => {
            let idx = this._hitTest(...ev.get_coords());
            if (ev.get_button() === 1 && idx >= 0 && idx === this._pressIdx)
                this._onPick?.(idx);
            this._pressIdx = -1;
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('destroy', () => {
            this._destroyed = true;
            stopSpring(this.actor);
            this._cancelLater();
            this._slits.clear();
        });
        this._entering = true;
    }

    get index() {
        return Math.round(this._target);
    }

    // Slide to item `index` (spring, interruptible, keeps velocity).
    slideTo(index, { instant = false } = {}) {
        if (this._destroyed)
            return;
        index = Math.max(0, Math.min(this._items.length - 1, index));
        this._target = index;
        this._positionTick();
        if (instant || !this.actor.get_stage()) {
            stopSpring(this.actor);
            this._pos = index;
            this._layout();
            return;
        }
        springTo(this.actor, { nnDeckPos: index }, { duration: 560, damping: 0.82 });
    }

    // A thumbnail finished generating: show it if that slit exists.
    setThumb(index, path) {
        let s = this._slits.get(index);
        if (s)
            this._applyImage(s.actor, path);
    }

    // ---- internals ----

    _queueLayout() {
        if (this._laterId || this._destroyed)
            return;
        let laters = global.compositor?.get_laters?.();
        let run = () => {
            this._laterId = 0;
            if (!this._destroyed) {
                this._width = this.actor.width;
                this._layout();
                if (this._entering && this._width > 0) {
                    this._entering = false;
                    this._enter();
                }
            }
            return GLib.SOURCE_REMOVE;
        };
        this._laterUsesLaters = !!laters;
        this._laterId = laters
            ? laters.add(Meta.LaterType.BEFORE_REDRAW, run)
            : GLib.idle_add(GLib.PRIORITY_DEFAULT, run);
    }

    _cancelLater() {
        if (!this._laterId)
            return;
        if (this._laterUsesLaters)
            global.compositor?.get_laters?.()?.remove(this._laterId);
        else
            GLib.Source.remove(this._laterId);
        this._laterId = 0;
    }

    // Left edge (at the bottom of the slit) and width of every item for the
    // current `pos`, laid out so that `pos` itself sits in the centre.
    _geometry() {
        let n = this._items.length;
        let xs = new Array(n), ws = new Array(n);
        let x = 0;
        for (let i = 0; i < n; i++) {
            ws[i] = SLIT_W + (ACTIVE_W - SLIT_W) * openness(i - this._pos);
            xs[i] = x;
            x += ws[i] + GAP;
        }
        // Centre of the (fractional) position, interpolated between slots.
        let lo = Math.max(0, Math.min(n - 1, Math.floor(this._pos)));
        let hi = Math.min(n - 1, lo + 1);
        let f = this._pos - lo;
        let cLo = xs[lo] + ws[lo] / 2, cHi = xs[hi] + ws[hi] / 2;
        let centre = cLo + (cHi - cLo) * f;
        let shift = this._width / 2 - centre - SKEW / 2;
        for (let i = 0; i < n; i++)
            xs[i] += shift;
        return [xs, ws];
    }

    _layout() {
        if (this._destroyed || this._width <= 0)
            return;
        let [xs, ws] = this._geometry();
        let W = this._width;
        this._geom = [xs, ws];
        for (let i = 0; i < this._items.length; i++) {
            let x = xs[i], w = ws[i];
            let onScreen = x + w + SKEW > -2 && x < W + 2;
            let s = this._slits.get(i);
            if (!onScreen) {
                if (s)
                    s.actor.visible = false;
                continue;
            }
            if (!s)
                s = this._createSlit(i);
            s.actor.visible = true;

            // Image drifts against the motion: slits left of centre show a bit
            // more of their image's right side, and vice versa.
            let c = x + (w + SKEW) / 2;
            let drift = Math.max(-PARALLAX, Math.min(PARALLAX, (W / 2 - c) * 0.08));
            let left = (ACTOR_W - SKEW - w) / 2 + drift;
            s.actor.x = Math.round((x - left) * 2) / 2;

            let open = openness(i - this._pos);
            let dim = 0.52 + 0.48 * open;
            if (i === this._hover && open < 0.98)
                dim = Math.min(1, dim + 0.28);
            s.mask.set(left, w, dim);

            let edge = Math.min(c, W - c);
            s.actor.opacity = Math.round(255 * Math.max(0, Math.min(1, edge / EDGE_FADE + 0.15)));
        }
        this._positionTick();
    }

    _positionTick() {
        if (!this._geom || this._width <= 0)
            return;
        // The tick follows the target (where you're going), centred under it.
        this._tick.x = Math.round(this._width / 2 - this._tick.width / 2);
    }

    _createSlit(i) {
        let actor = new St.Widget({
            style_class: 'nook-wp-slit',
            width: ACTOR_W, height: DECK_HEIGHT,
            y: 4,
            reactive: false,
        });
        let path = this._thumbFor(this._items[i]);
        if (path)
            this._applyImage(actor, path);
        let mask = new SlitMask();
        actor.add_effect(mask);
        this.actor.insert_child_below(actor, this._tick);
        let s = { actor, mask };
        this._slits.set(i, s);
        return s;
    }

    // Thumbnail paths are sha256-named files in our own cache dir: no quotes
    // or parentheses, so they can sit in a CSS url("…") as-is.
    _applyImage(actor, path) {
        let uri = Gio.File.new_for_path(path).get_uri();
        actor.add_style_class_name('nook-wp-slit-ready');
        actor.set_style(`background-image: url("${uri}"); background-size: cover; background-position: center;`);
    }

    // Which item's parallelogram is under stage point (sx, sy), or -1.
    _hitTest(sx, sy) {
        if (!this._geom)
            return -1;
        let [ok, x, y] = this.actor.transform_stage_point(sx, sy);
        if (!ok)
            return -1;
        y -= 4;
        if (y < 0 || y > DECK_HEIGHT)
            return -1;
        let lean = SKEW * (1 - y / DECK_HEIGHT);
        let [xs, ws] = this._geom;
        for (let i = 0; i < xs.length; i++) {
            let l = xs[i] + lean;
            if (x >= l - GAP / 2 && x <= l + ws[i] + GAP / 2)
                return i;
        }
        return -1;
    }

    _setHover(i) {
        if (i === this._hover)
            return;
        this._hover = i;
        this._layout();
    }

    // Opening the tab: slits rise into place one after another, fanning out
    // from the centre.
    _enter() {
        let s = St.Settings.get();
        if (!s.enable_animations)
            return;
        let centre = Math.round(this._pos);
        for (let [i, slit] of this._slits) {
            if (!slit.actor.visible)
                continue;
            let delay = Math.abs(i - centre) * 28;
            slit.actor.translation_y = 26 + Math.abs(i - centre) * 3;
            slit.actor.ease({
                translation_y: 0,
                delay,
                duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            });
        }
        this._tick.scale_x = 0;
        this._tick.set_pivot_point(0.5, 0.5);
        this._tick.ease({ scale_x: 1, delay: 160, duration: 360, mode: Clutter.AnimationMode.EASE_OUT_BACK });
    }
}
