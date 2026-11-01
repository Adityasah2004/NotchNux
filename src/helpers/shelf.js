import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { logError } from './log.js';

// GNOME disables every extension while the screen is locked and re-enables it
// on unlock, which reconstructs ShelfHelper each time. The shelf is meant to be
// scratch space for one *login*, not one unlock, so remember at module scope
// (ES modules stay cached for the whole shell process) that we already wiped
// it — otherwise every screen lock silently threw the user's files away.
let _clearedThisSession = false;

// The portal FileChooser reply is a signal on a Request object; if the portal
// never answers (crashed, not installed) the subscription would live forever.
const PORTAL_TIMEOUT_S = 600;

export class ShelfHelper {
    constructor() {
        this.shelfDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchnux', 'shelf']);
        this._cancellable = new Gio.Cancellable();
        this._portalSubs = new Set();
        this._ensureDirectories();
    }

    destroy() {
        this._cancellable.cancel();
        for (let sub of this._portalSubs)
            sub.cancel();
        this._portalSubs.clear();
    }

    _ensureDirectories() {
        try {
            // 0700: shelf files are the user's private documents.
            GLib.mkdir_with_parents(this.shelfDir, 0o700);
        } catch (e) {
            logError('Error creating shelf directory', e);
        }
    }

    // Wipe the shelf once per login session (see _clearedThisSession).
    clearOncePerSession() {
        if (_clearedThisSession)
            return;
        _clearedThisSession = true;
        this.clearShelf();
    }

    // --- Files Shelf API ---
    getFiles() {
        let list = [];
        try {
            let directory = Gio.File.new_for_path(this.shelfDir);
            let enumerator = directory.enumerate_children(
                'standard::name,standard::size,standard::type,standard::symbolic-icon',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                let file = directory.get_child(info.get_name());
                list.push({
                    name: info.get_name(),
                    path: file.get_path(),
                    uri: file.get_uri(),
                    sizeStr: this._formatSize(info.get_size()),
                    gicon: info.get_symbolic_icon() ?? null,
                });
            }
            enumerator.close(null);
        } catch (e) {
            logError('Error enumerating shelf files', e);
        }
        list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        return list;
    }

    // Resolve a path or file:// URI into a Gio.File, or null if it isn't a
    // local regular file we should copy.
    _resolveSource(src) {
        try {
            let file = src.startsWith('file://')
                ? Gio.File.new_for_uri(src)
                : Gio.File.new_for_path(src);
            if (!file.get_path())
                return null;
            return file;
        } catch (e) {
            return null;
        }
    }

    // First free name in the shelf for `basename`: "a.txt", then "a (2).txt"…
    // Never overwrite an existing shelf file with an unrelated one.
    _uniqueDest(basename) {
        let dir = Gio.File.new_for_path(this.shelfDir);
        let dest = dir.get_child(basename);
        if (!dest.query_exists(null))
            return dest;
        let dot = basename.lastIndexOf('.');
        let stem = dot > 0 ? basename.slice(0, dot) : basename;
        let ext = dot > 0 ? basename.slice(dot) : '';
        for (let n = 2; n < 1000; n++) {
            dest = dir.get_child(`${stem} (${n})${ext}`);
            if (!dest.query_exists(null))
                return dest;
        }
        return dir.get_child(`${stem} (${GLib.uuid_string_random().slice(0, 8)})${ext}`);
    }

    // Copy a file into the shelf without blocking the compositor: the old
    // synchronous Gio.File.copy froze the whole desktop for as long as a large
    // file took to copy. `done(ok)` runs on the main loop.
    addFileAsync(src, done = null) {
        let finish = ok => { if (done) done(ok); };
        let srcFile = this._resolveSource(src);
        if (!srcFile) { finish(false); return; }

        srcFile.query_info_async('standard::type,standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (f, res) => {
                let info;
                try {
                    info = f.query_info_finish(res);
                } catch (e) {
                    finish(false);
                    return;
                }
                if (info.get_file_type() !== Gio.FileType.REGULAR) {
                    finish(false);
                    return;
                }
                // Already on the shelf (e.g. pasted a shelf file back): no-op.
                let parent = f.get_parent();
                if (parent && parent.get_path() === this.shelfDir) {
                    finish(false);
                    return;
                }
                let dest = this._uniqueDest(f.get_basename());
                f.copy_async(dest, Gio.FileCopyFlags.NONE, GLib.PRIORITY_LOW,
                    this._cancellable, null, (sf, cres) => {
                        try {
                            sf.copy_finish(cres);
                            finish(true);
                        } catch (e) {
                            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                logError(`Failed to add ${sf.get_basename()} to shelf`, e);
                            finish(false);
                        }
                    });
            });
    }

    // Add several sources; `done(addedCount)` once every copy has settled.
    addFilesAsync(sources, done = null) {
        let pending = sources.length;
        let added = 0;
        if (pending === 0) { if (done) done(0); return; }
        for (let src of sources) {
            this.addFileAsync(src, ok => {
                if (ok) added++;
                if (--pending === 0 && done) done(added);
            });
        }
    }

    deleteFile(filePath) {
        try {
            let file = Gio.File.new_for_path(filePath);
            // Only ever delete things that actually live in the shelf.
            let parent = file.get_parent();
            if (!parent || parent.get_path() !== this.shelfDir)
                return false;
            file.delete(null);
            return true;
        } catch (e) {
            logError(`Failed to delete shelf file ${filePath}`, e);
        }
        return false;
    }

    clearShelf() {
        try {
            let directory = Gio.File.new_for_path(this.shelfDir);
            let enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                try {
                    directory.get_child(info.get_name()).delete(null);
                } catch (e) {
                    // A subdirectory or a file that vanished — skip it.
                }
            }
            enumerator.close(null);
        } catch (e) {
            logError('Failed to clear shelf', e);
        }
    }

    openFile(filePath) {
        let uri = Gio.File.new_for_path(filePath).get_uri();
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                logError(`Failed to open ${filePath}`, e);
            }
        });
    }

    // Reveal the file in the user's file manager via the FileManager1 D-Bus
    // interface (Nautilus, Nemo, Dolphin… all implement it). Never builds a
    // command line from the filename — the old `nautilus --select "${path}"`
    // let a crafted filename inject extra arguments.
    showInFiles(filePath) {
        let uri = Gio.File.new_for_path(filePath).get_uri();
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1',
            'ShowItems',
            new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    // No FileManager1 service: open the containing folder.
                    let dirUri = Gio.File.new_for_path(this.shelfDir).get_uri();
                    try {
                        Gio.AppInfo.launch_default_for_uri(dirUri, null);
                    } catch (e2) {
                        logError('Failed to reveal shelf file', e2);
                    }
                }
            });
    }

    copyToClipboard(text) {
        try {
            let clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {
            logError('Failed to set clipboard text', e);
        }
    }

    // Put the actual file on the Wayland clipboard as a copied *file* (not just
    // its path) so it can be pasted into a file manager or attached in chat
    // apps. St.Clipboard can only carry text, so we shell out to wl-copy with
    // text/uri-list, which is what file managers read for a "copied file".
    //
    // Returns true if wl-copy was found and spawned, false otherwise (the
    // caller falls back to copying the URI as text). wl-copy must stay resident
    // to keep serving the selection, so it is left running (it exits when the
    // selection is replaced) — we don't wait on it.
    copyFileToClipboard(filePath) {
        try {
            let file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null))
                return false;
            Gio.Subprocess.new(
                ['wl-copy', '--type', 'text/uri-list', `${file.get_uri()}\r\n`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Pull whatever file(s) are on the Wayland clipboard (e.g. a Ctrl+C'd file
    // in Nautilus, which is advertised as text/uri-list) and add them to the
    // shelf. This is our stand-in for external drag-and-drop, which Wayland
    // won't route into a shell extension's own actors. `callback(addedCount)`
    // runs on the main loop; addedCount is -1 if wl-paste isn't available.
    pasteFilesFromClipboard(callback) {
        let done = (n) => { if (callback) callback(n); };
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['wl-paste', '--no-newline', '--type', 'text/uri-list'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            done(-1);
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            let uris = [];
            try {
                let [, stdout] = p.communicate_utf8_finish(res);
                // A uri-list is CRLF-separated URIs; comment lines start with '#'.
                uris = (stdout || '').split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(s => s.startsWith('file://'));
            } catch (e) {
                done(0);
                return;
            }
            this.addFilesAsync(uris, done);
        });
    }

    // Open the desktop portal's file chooser and add every selected file to
    // the shelf. Async: `callback(addedCount)` runs on the main loop once the
    // dialog closes and the copies finish. Uses org.freedesktop.portal.FileChooser
    // directly so we don't depend on an external picker binary.
    pickFilesIntoShelf(callback) {
        let bus = Gio.DBus.session;
        // The portal replies asynchronously on a Request object whose path it
        // returns; we must be subscribed to that object's Response signal
        // before (or right as) the call completes. The token makes the path
        // predictable per the portal spec, so we can subscribe up front.
        let token = `notchnux_${GLib.uuid_string_random().replace(/-/g, '')}`;
        let sender = bus.get_unique_name().replace(/^:/, '').replace(/\./g, '_');
        let requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

        let subId = 0;
        let timeoutId = 0;
        let entry = null;
        let finish = (added) => {
            if (!entry) return;
            this._portalSubs.delete(entry);
            entry = null;
            if (subId) { bus.signal_unsubscribe(subId); subId = 0; }
            if (timeoutId) { GLib.Source.remove(timeoutId); timeoutId = 0; }
            if (callback && added !== null) callback(added);
        };
        entry = { cancel: () => finish(null) };
        this._portalSubs.add(entry);

        subId = bus.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            requestPath,
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender_, path, iface, signal, params) => {
                let [responseCode, results] = params.deepUnpack();
                // responseCode: 0 = ok, 1 = cancelled, 2 = other error.
                let uris = responseCode === 0 && results['uris']
                    ? results['uris'].deepUnpack() : [];
                this.addFilesAsync(uris, added => finish(added));
            }
        );
        timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PORTAL_TIMEOUT_S, () => {
            timeoutId = 0;
            finish(0);
            return GLib.SOURCE_REMOVE;
        });

        let options = new GLib.Variant('a{sv}', {
            handle_token: new GLib.Variant('s', token),
            multiple: new GLib.Variant('b', true),
        });

        bus.call(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser',
            'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', 'Add to shelf', options]),
            new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (src, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    logError('FileChooser portal call failed', e);
                    finish(0);
                }
            }
        );
    }

    // --- Quick Share via GSConnect (the Linux "nearby share") ---
    // GSConnect exposes each paired device on the session bus as a GApplication
    // whose object path is .../Device/<id>. Device metadata lives on the
    // ...GSConnect.Device interface; file sending is the `shareFile` GAction
    // (param (sb) = path/uri + "open on device" bool) invoked through
    // org.gtk.Actions.Activate. We talk to it directly so we don't depend on
    // GSConnect's JS internals.
    static GSC_NAME = 'org.gnome.Shell.Extensions.GSConnect';
    static GSC_BASE = '/org/gnome/Shell/Extensions/GSConnect';

    // Fetch the reachable devices asynchronously: `done({ available, devices })`
    // where devices is [{ id, name, path, type }]. Only connected AND paired
    // devices can actually receive a file, so we filter to those. Async so a
    // busy/hung GSConnect can never stall a Shelf render.
    getShareDevicesAsync(done) {
        let bus = Gio.DBus.session;
        bus.call(
            ShelfHelper.GSC_NAME,
            ShelfHelper.GSC_BASE,
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})'),
            Gio.DBusCallFlags.NO_AUTO_START,
            1500,
            this._cancellable,
            (conn, res) => {
                let out = [];
                let available = true;
                try {
                    let [objects] = conn.call_finish(res).deepUnpack();
                    for (let path in objects) {
                        let dev = objects[path]['org.gnome.Shell.Extensions.GSConnect.Device'];
                        if (!dev) continue;
                        let get = (k, d) => dev[k] ? dev[k].deepUnpack() : d;
                        if (!get('Connected', false) || !get('Paired', false)) continue;
                        out.push({
                            id: get('Id', path),
                            name: get('Name', 'Device'),
                            type: get('Type', 'phone'),
                            path,
                        });
                    }
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // GSConnect not installed / not running — no devices, no error UI.
                    available = false;
                }
                done({ available, devices: out });
            });
    }

    // Send a shelf file to the given device path via GSConnect's shareFile
    // action. Fire-and-forget: GSConnect handles the transfer and its own
    // progress notification. Returns true if the call was dispatched.
    sendFileToDevice(devicePath, filePath) {
        try {
            let uri = Gio.File.new_for_path(filePath).get_uri();
            // shareFile param is (sb): (uri, openOnDevice). Wrapped as the
            // single tuple GVariant that org.gtk.Actions.Activate expects in
            // its parameter array.
            let param = new GLib.Variant('(sb)', [uri, false]);
            Gio.DBus.session.call(
                ShelfHelper.GSC_NAME,
                devicePath,
                'org.gtk.Actions',
                'Activate',
                new GLib.Variant('(sava{sv})', ['shareFile', [param], {}]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (src, res) => {
                    try { src.call_finish(res); }
                    catch (e) { logError('shareFile dispatch failed', e); }
                }
            );
            return true;
        } catch (e) {
            logError(`Failed to send ${filePath} to ${devicePath}`, e);
            return false;
        }
    }

    // --- Formatting Helper ---
    _formatSize(bytes) {
        if (!bytes) return '0 B';
        let k = 1024;
        let sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}
