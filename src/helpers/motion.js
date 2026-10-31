// Motion primitives for NotchNux.
//
// Clutter's ease() only offers fixed curves, and a custom progress function on
// its transitions is ignored on Clutter 18. The notch's signature open — a
// short, slightly springy bloom like a phone's dynamic island — is therefore
// driven by a plain Clutter.Timeline that evaluates a damped spring per frame.
// That costs the same as ease(), which also writes the property every frame.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Normalised step response of a damped spring: 0 at t=0, settled at 1 by t=1.
// `damping` < 1 overshoots slightly (0.76 ≈ 2.5 %); 1 is critically damped.
export function springProgress(t, damping = 0.76) {
    if (t >= 1)
        return 1;
    const omega = 9;   // fast enough to settle inside the duration
    if (damping >= 1)
        return 1 - Math.exp(-omega * t) * (1 + omega * t);
    let wd = omega * Math.sqrt(1 - damping * damping);
    let decay = Math.exp(-damping * omega * t);
    return 1 - decay * (Math.cos(wd * t) + (damping * omega / wd) * Math.sin(wd * t));
}

// Longest spring-time step one frame may take (≈ two 60 Hz frames).
const MAX_STEP = 34;

function animationsEnabled() {
    let s = St.Settings.get();
    return s.enable_animations;
}

function scaledDuration(ms) {
    return Math.round(ms * (St.Settings.get().slow_down_factor || 1));
}

// Displacement x and velocity v (per unit of normalised time) of a damped
// spring released from displacement x0 with velocity v0. Same omega as
// springProgress, so an uninterrupted spring traces exactly that curve.
function springState(x0, v0, damping, t) {
    const w = 9;
    if (damping >= 1) {
        let e = Math.exp(-w * t), c = v0 + w * x0;
        return [e * (x0 + c * t), e * (c - w * (x0 + c * t))];
    }
    let wd = w * Math.sqrt(1 - damping * damping);
    let e = Math.exp(-damping * w * t);
    let B = (v0 + damping * w * x0) / wd;
    let cos = Math.cos(wd * t), sin = Math.sin(wd * t);
    let x = e * (x0 * cos + B * sin);
    return [x, -damping * w * x + e * wd * (B * cos - x0 * sin)];
}

// Spring `actor`'s numeric properties (x, y, width, height, opacity…) to
// `target`. A running spring on the same actor is replaced from its current
// values *and velocity*, so a hover-out mid-open turns around smoothly
// instead of stopping dead and restarting (no velocity "brick wall").
export function springTo(actor, target, { duration = 460, damping = 0.76, onComplete = null } = {}) {
    let inherited = actor._nnSpring ? (actor._nnSpringVel ?? {}) : {};
    stopSpring(actor);
    for (let k of Object.keys(target))
        actor.remove_transition(k);
    let keys = Object.keys(target);
    let from = {};
    for (let k of keys)
        from[k] = actor[k];
    let apply = p => {
        for (let k of keys)
            actor[k] = from[k] + (target[k] - from[k]) * p;
    };
    duration = scaledDuration(duration);
    if (!animationsEnabled() || duration <= 0) {
        apply(1);
        actor._onSpringSettled?.();
        onComplete?.();
        return;
    }
    // Lets the owner prepare for the whole flight up front (the glass sizes
    // its blur buffers to cover it once instead of reallocating per frame).
    actor._onSpringStart?.(from, target);
    // Inherited velocity is stored per ms; convert to this spring's time base.
    let v0 = {};
    for (let k of keys)
        v0[k] = (inherited[k] ?? 0) * duration;
    let vel = {};
    actor._nnSpringVel = vel;
    // Spring time advances by at most MAX_STEP per frame. The first frame
    // after an open is often late (the tab renders synchronously), and a
    // purely clock-driven spring would skip its first quarter — the box
    // visibly jumped. A stall now pauses the motion instead of skipping it.
    // The timeline runs long only as a backstop; we stop it ourselves.
    let elapsed = 0, last = 0, done = false;
    let tl = new Clutter.Timeline({ actor, duration: duration * 4 });
    let finish = () => {
        if (done) return;
        done = true;
        tl.stop();
        apply(1);
        if (actor._nnSpring === tl) {
            actor._nnSpring = null;
            actor._nnSpringVel = null;
            actor._onSpringSettled?.();
        }
        onComplete?.();
    };
    tl.connect('new-frame', () => {
        let now = tl.get_elapsed_time();
        elapsed += Math.min(now - last, MAX_STEP);
        last = now;
        if (elapsed >= duration) {
            finish();
            return;
        }
        let t = elapsed / duration;
        for (let k of keys) {
            let [x, v] = springState(from[k] - target[k], v0[k], damping, t);
            actor[k] = target[k] + x;
            vel[k] = v / duration;
        }
    });
    tl.connect('completed', finish);
    actor._nnSpring = tl;
    tl.start();
}

export function stopSpring(actor) {
    if (actor._nnSpring) {
        actor._nnSpring.stop();
        actor._nnSpring = null;
        actor._onSpringSettled?.();
    }
}

// Tactile press: the button dips to 96 % while held and springs back on
// release. Purely a transform, so it never triggers relayout.
export function addPressFeedback(button, scale = 0.96) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        button.ease({
            scale_x: button.pressed ? scale : 1,
            scale_y: button.pressed ? scale : 1,
            duration: button.pressed ? 90 : 220,
            mode: button.pressed ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    });
}
