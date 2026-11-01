// Drag-and-drop of files from other apps (Files, the desktop, a browser…) onto
// the notch.
//
// Two halves, because Wayland splits them:
//   1. *Seeing* the drag. Mutter reports every client drag to the shell through
//      global.backend.get_dnd() (dnd-enter / dnd-position-change / dnd-leave) —
//      the same hook GNOME's overview uses. We use it to open the notch when a
//      drag reaches it.
//   2. *Receiving* the files. Drag data is only offered to client windows, never
//      to shell actors. So while the drag hovers the open notch we map an
//      invisible GTK4 window (src/tools/drop-catcher.js) under the dashboard and
//      make the notch's own actors non-reactive, so the drop lands on it. The
//      helper reports the dropped URIs back over stdout.
//
// The helper is spawned lazily on the first drag (through Meta.WaylandClient,
// which lets us recognise its window and hide it from the window list) and
// exits after a few idle minutes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { logError } from './log.js';

const CATCHER = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('tools').get_child('drop-catcher.js').get_path();

const IDLE_EXIT_S = 300;
// After the button is released the drop's data still has to travel to the
// helper; keep its window mapped this long unless the files arrive first.
const DROP_GRACE_MS = 1500;

export class FileDropBridge {
    // hooks:
    //   hitTest(x, y)      → true when a drag at (x, y) should open the shelf
    //   onArm()            → open the notch on the shelf (sync)
    //   targetRect()       → {x, y, width, height} the catcher should cover
    //   setPassThrough(on) → make the notch's actors (non-)reactive
    //   onOver(inside)     → the drag is over the drop target / left it
    //   onFiles(uris)      → files were dropped
    //   onDragEnd(dropped) → the drag finished (dropped: got files)
    constructor(hooks) {
        this._hooks = hooks;
        this._dragging = false;
        this._armed = false;
        this._dropped = false;
        this._client = null;
        this._proc = null;
        this._stdin = null;
        this._ready = false;
        this._pendingShow = false;
        this._win = null;
        this._cancellable = new Gio.Cancellable();

        let dnd = global.backend.get_dnd();
        this._dnd = dnd;
        this._dndIds = [
            dnd.connect('dnd-enter', () => this._onEnter()),
            dnd.connect('dnd-position-change', (o, x, y) => this._onMove(x, y)),
            dnd.connect('dnd-leave', () => this._onLeave()),
        ];
        this._windowCreatedId = global.display.connect('window-created',
            (d, win) => this._onWindowCreated(win));
    }

    get active() {
        return this._armed;
    }

    destroy() {
        for (let id of this._dndIds)
            this._dnd.disconnect(id);
        this._dndIds = [];
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        this._clearTimer('_graceId');
        this._clearTimer('_idleId');
        if (this._armed)
            this._hooks.setPassThrough(false);
        this._armed = false;
        this._stopHelper();
        this._cancellable.cancel();
    }

    // ------------------------------------------------------------ drag events
    _onEnter() {
        this._dragging = true;
        this._dropped = false;
        this._clearTimer('_graceId');
        this._clearTimer('_idleId');
        this._ensureHelper();
    }

    _onMove(x, y) {
        if (!this._dragging || this._armed)
            return;
        if (!this._hooks.hitTest(x, y))
            return;
        this._armed = true;
        this._hooks.onArm();
        this._showCatcher();
    }

    _onLeave() {
        this._dragging = false;
        if (!this._armed) {
            this._scheduleIdleExit();
            return;
        }
        // Released (dropped or cancelled). The drop payload may still be in
        // flight to the helper, so give it a moment before tearing down.
        if (this._dropped) {
            this._finish();
            return;
        }
        this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DROP_GRACE_MS, () => {
            this._graceId = 0;
            this._finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish() {
        this._clearTimer('_graceId');
        if (!this._armed)
            return;
        this._armed = false;
        this._hideCatcher();
        this._hooks.setPassThrough(false);
        this._hooks.onOver(false);
        this._hooks.onDragEnd(this._dropped);
        this._scheduleIdleExit();
    }

    // ------------------------------------------------------------ catcher window
    _showCatcher() {
        if (!this._ready) {
            this._pendingShow = true;
            return;
        }
        this._pendingShow = false;
        let r = this._hooks.targetRect();
        if (!r)
            return;
        this._rect = r;
        this._send(`show ${Math.round(r.width)} ${Math.round(r.height)}`);
    }

    _hideCatcher() {
        this._pendingShow = false;
        this._win = null;
        this._send('hide');
    }

    _onWindowCreated(win) {
        if (!this._client || !this._client.owns_window(win))
            return;
        this._win = win;
        try {
            if (win.hide_from_window_list)
                win.hide_from_window_list();
            else
                this._client.hide_from_window_list(win); // mutter < 47
        } catch (e) {
            // It just shows in the window list for the drag.
        }
        let place = () => {
            if (this._win !== win || !this._rect)
                return;
            let r = this._rect;
            // Raising is only valid once the window is in the stack.
            if (win.get_compositor_private()?.visible && !win.is_above())
                win.make_above();
            win.move_resize_frame(true, Math.round(r.x), Math.round(r.y),
                Math.round(r.width), Math.round(r.height));
        };
        place();
        // The first configure may land before the client has a buffer; place
        // it again once it is actually on screen.
        let shownId = win.connect('shown', () => {
            win.disconnect(shownId);
            place();
            // Only now can the drop land on it: stop the notch eating the pick.
            if (this._armed && this._win === win)
                this._hooks.setPassThrough(true);
        });
    }

    // ------------------------------------------------------------ helper process
    _ensureHelper() {
        if (this._client)
            return;
        try {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            // Software rendering: the window is invisible, and a GPU swapchain
            // created mid-drag can stall before its first frame.
            launcher.setenv('GSK_RENDERER', 'cairo', true);
            launcher.setenv('GTK_A11Y', 'none', true);
            this._client = Meta.WaylandClient.new_subprocess(global.context, launcher,
                ['gjs', '-m', CATCHER]);
            this._proc = this._client.get_subprocess();
        } catch (e) {
            logError('drop helper failed to start', e);
            this._client = null;
            this._proc = null;
            return;
        }
        this._ready = false;
        this._stdin = this._proc.get_stdin_pipe();
        let out = new Gio.DataInputStream({ base_stream: this._proc.get_stdout_pipe() });
        let proc = this._proc;
        let readNext = () => {
            out.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                let line = null;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch (e) {
                    line = null;
                }
                if (line === null) {
                    if (this._proc === proc)
                        this._resetHelper();
                    return;
                }
                this._onHelperLine(line);
                readNext();
            });
        };
        readNext();
        proc.wait_async(null, () => {
            if (this._proc === proc)
                this._resetHelper();
        });
    }

    _onHelperLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (msg.ready) {
            this._ready = true;
            if (this._pendingShow && this._armed)
                this._showCatcher();
        } else if ('over' in msg) {
            if (this._armed)
                this._hooks.onOver(!!msg.over);
        } else if (Array.isArray(msg.drop)) {
            let uris = msg.drop.filter(u => typeof u === 'string');
            if (uris.length) {
                this._dropped = true;
                this._hooks.onFiles(uris);
            }
            // Payload is in: the drag is over even if dnd-leave hasn't fired.
            if (!this._dragging)
                this._finish();
        }
    }

    _send(cmd) {
        if (!this._stdin)
            return;
        try {
            this._stdin.write_all(new TextEncoder().encode(`${cmd}\n`), null);
            this._stdin.flush(null);
        } catch (e) {
            this._resetHelper();
        }
    }

    _scheduleIdleExit() {
        this._clearTimer('_idleId');
        if (!this._client)
            return;
        this._idleId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, IDLE_EXIT_S, () => {
            this._idleId = 0;
            if (!this._dragging && !this._armed)
                this._stopHelper();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopHelper() {
        let proc = this._proc;
        this._send('quit');
        this._resetHelper();
        if (proc) {
            // Closing stdin also makes it exit; make sure it does.
            GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
                try {
                    proc.force_exit();
                } catch (e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _resetHelper() {
        if (this._stdin) {
            try {
                this._stdin.close(null);
            } catch (e) {}
        }
        this._stdin = null;
        this._proc = null;
        this._client = null;
        this._ready = false;
        this._win = null;
    }

    _clearTimer(key) {
        if (this[key]) {
            GLib.Source.remove(this[key]);
            this[key] = 0;
        }
    }
}
