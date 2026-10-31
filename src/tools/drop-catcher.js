// Invisible drop target for NotchNux's Shelf.
//
// On Wayland a dragged file's data is only ever offered to client *windows*;
// shell chrome (the notch) can see that a drag is happening but can never read
// what is being dragged. So while a file drag hovers the notch, NotchNux shows
// this tiny transparent GTK4 window underneath its dashboard (its own actors go
// non-reactive so the pointer "falls through" to us). The user drops onto what
// looks like the notch; we receive the files and report them back.
//
// Spawned through Meta.WaylandClient, so the shell can recognise, position and
// hide this window from the window list. Talks line-based JSON:
//
//   stdin   show <width> <height>   map the window at this size
//           hide                    unmap it
//           quit                    exit
//   stdout  {"ready":true}          started, waiting for commands
//           {"over":true|false}     a drag entered / left the window
//           {"drop":["file:///…"]}  files were dropped
//
// No shell libraries — plain gjs + GTK4.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const TITLE = 'NotchNux Drop Target';

// We never draw anything visible, so skip the GPU renderer: it is slower to
// start, and a Vulkan swapchain created mid-drag was seen never presenting its
// first frame (the window then never maps). Set by the shell too; these are a
// fallback for running the script by hand.
if (!GLib.getenv('GSK_RENDERER'))
    GLib.setenv('GSK_RENDERER', 'cairo', true);
if (!GLib.getenv('GTK_A11Y'))
    GLib.setenv('GTK_A11Y', 'none', true);

Gtk.init();

const loop = new GLib.MainLoop(null, false);
const stdout = new Gio.DataOutputStream({
    base_stream: new GioUnix.OutputStream({ fd: 1, close_fd: false }),
});

function send(obj) {
    try {
        stdout.put_string(`${JSON.stringify(obj)}\n`, null);
        stdout.flush(null);
    } catch (e) {
        // Parent went away: nothing left to do.
        loop.quit();
    }
}

// Effectively invisible: the notch, drawn above us, is the visible target.
// Not *fully* transparent — GTK never commits a buffer for an undecorated
// window with nothing to draw, and a window without a buffer never maps.
// 1/255 alpha is imperceptible (and sits under the notch anyway).
const css = new Gtk.CssProvider();
css.load_from_string('window { background: rgba(0, 0, 0, 0.004); box-shadow: none; border: none; outline: none; } ' +
    'window * { background: transparent; outline: none; border: none; box-shadow: none; }');
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);

let win = null;

function buildWindow(w, h) {
    let window = new Gtk.Window({
        title: TITLE,
        decorated: false,
        resizable: true,
        default_width: w,
        default_height: h,
    });
    // An empty child that fills the window so the whole surface takes input.
    let area = new Gtk.Box({ hexpand: true, vexpand: true });
    window.set_child(area);

    let target = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY });
    target.set_gtypes([Gdk.FileList.$gtype]);
    target.connect('enter', () => {
        send({ over: true });
        return Gdk.DragAction.COPY;
    });
    target.connect('leave', () => send({ over: false }));
    target.connect('drop', (t, value) => {
        let uris = [];
        try {
            for (let f of value.get_files())
                uris.push(f.get_uri());
        } catch (e) {
            printerr(`drop-catcher: ${e.message}`);
        }
        send({ drop: uris });
        return uris.length > 0;
    });
    area.add_controller(target);

    window.connect('close-request', () => {
        window.set_visible(false);
        return true; // keep the object; the shell decides when we exit
    });
    return window;
}

function handle(line) {
    let [cmd, ...args] = line.trim().split(/\s+/);
    switch (cmd) {
    case 'show': {
        let w = Math.max(1, parseInt(args[0]) || 400);
        let h = Math.max(1, parseInt(args[1]) || 200);
        // A fresh window per drag: re-mapping a hidden one keeps its old size
        // hints, and a new surface is what the compositor positions anyway.
        if (win)
            win.destroy();
        win = buildWindow(w, h);
        win.present();
        break;
    }
    case 'hide':
        if (win) {
            win.destroy();
            win = null;
        }
        break;
    case 'quit':
        loop.quit();
        break;
    }
}

const stdin = new Gio.DataInputStream({
    base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }),
});

function readNext() {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch (e) {
            line = null;
        }
        if (line === null) {
            // EOF: the shell closed our stdin (extension disabled / crashed).
            loop.quit();
            return;
        }
        handle(line);
        readNext();
    });
}

readNext();
send({ ready: true });
loop.run();
