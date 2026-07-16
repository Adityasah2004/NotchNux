import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export class ShelfHelper {
    constructor() {
        this.shelfDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchnux', 'shelf']);
        this.notesFile = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchnux', 'notes.txt']);
        
        this._ensureDirectories();
    }

    _ensureDirectories() {
        try {
            GLib.mkdir_with_parents(this.shelfDir, 0o755);
            
            // Ensure notes file exists
            let file = Gio.File.new_for_path(this.notesFile);
            if (!file.query_exists(null)) {
                file.replace_contents('', null, false, Gio.FileCreateFlags.NONE, null);
            }
        } catch (e) {
            console.error('NotchNux: Error creating storage directories', e);
        }
    }

    // --- Files Shelf API ---
    getFiles() {
        let list = [];
        try {
            let directory = Gio.File.new_for_path(this.shelfDir);
            let enumerator = directory.enumerate_children(
                'standard::name,standard::size,standard::content-type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                let size = info.get_size();
                let contentType = info.get_content_type() || 'unknown';
                let filePath = GLib.build_filenamev([this.shelfDir, name]);
                let uri = `file://${filePath}`;

                // Resolve matching GIcon
                let iconName = 'text-x-generic-symbolic';
                let gicon = info.get_icon();
                if (gicon) {
                    let names = gicon.to_string().split(' ');
                    // Standard icon name fallback
                    iconName = names.find(n => n.endsWith('-symbolic')) || names[0] || 'text-x-generic-symbolic';
                }

                list.push({
                    name: name,
                    path: filePath,
                    uri: uri,
                    sizeStr: this._formatSize(size),
                    icon: iconName
                });
            }
        } catch (e) {
            console.error('NotchNux: Error enumerating shelf files', e);
        }
        return list;
    }

    addFile(srcPath) {
        try {
            // Support raw paths or file:// URIs
            if (srcPath.startsWith('file://')) {
                srcPath = srcPath.replace('file://', '');
            }
            
            // URI decoding for URL-encoded characters (like %20 for space)
            srcPath = GLib.uri_unescape_string(srcPath, null);

            let srcFile = Gio.File.new_for_path(srcPath);
            if (!srcFile.query_exists(null)) {
                return false;
            }

            let basename = srcFile.get_basename();
            let destPath = GLib.build_filenamev([this.shelfDir, basename]);
            let destFile = Gio.File.new_for_path(destPath);

            srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            return true;
        } catch (e) {
            console.error(`NotchNux: Failed to add file ${srcPath} to shelf`, e);
        }
        return false;
    }

    deleteFile(filePath) {
        try {
            let file = Gio.File.new_for_path(filePath);
            if (file.query_exists(null)) {
                file.delete(null);
                return true;
            }
        } catch (e) {
            console.error(`NotchNux: Failed to delete shelf file ${filePath}`, e);
        }
        return false;
    }

    clearShelf() {
        try {
            let directory = Gio.File.new_for_path(this.shelfDir);
            let enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                let filePath = GLib.build_filenamev([this.shelfDir, name]);
                Gio.File.new_for_path(filePath).delete(null);
            }
        } catch (e) {
            console.error('NotchNux: Failed to clear shelf', e);
        }
    }

    openFile(filePath) {
        try {
            Gio.AppInfo.launch_default_for_uri(`file://${filePath}`, null);
        } catch (e) {
            console.error(`NotchNux: Failed to open file ${filePath}`, e);
        }
    }

    showInFiles(filePath) {
        try {
            // E.g. spawn nautilus select Command
            GLib.spawn_command_line_async(`nautilus --select "${filePath}"`);
        } catch (e) {
            console.error(`NotchNux: Failed to open Nautilus selection for ${filePath}`, e);
        }
    }

    copyToClipboard(text) {
        try {
            let clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {
            console.error('NotchNux: Failed to set clipboard text', e);
        }
    }

    // Put the actual file on the Wayland clipboard as a copied *file* (not just
    // its path) so it can be pasted into a file manager or attached in chat
    // apps. St.Clipboard can only carry text, so we shell out to wl-copy with
    // the file's real MIME type and its bytes on stdin.
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
            // wl-copy needs a concrete mime type to advertise; text/uri-list
            // is what file managers read for a "copied file" paste.
            let uri = file.get_uri();
            let [ok] = GLib.spawn_async(
                null,
                ['wl-copy', '--type', 'text/uri-list', uri + '\r\n'],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            return ok;
        } catch (e) {
            console.error(`NotchNux: Failed to copy file to clipboard ${filePath}`, e);
            return false;
        }
    }

    // Open the desktop portal's file chooser and add every selected file to
    // the shelf. Async: `callback(addedCount)` runs on the main loop once the
    // dialog closes. Uses org.freedesktop.portal.FileChooser directly so we
    // don't depend on an external picker binary.
    pickFilesIntoShelf(callback) {
        let bus = Gio.DBus.session;
        // The portal replies asynchronously on a Request object whose path it
        // returns; we must be subscribed to that object's Response signal
        // before (or right as) the call completes. The token makes the path
        // predictable per the portal spec, so we can subscribe up front.
        let token = 'notchnux_' + Math.floor(Math.random() * 0x7fffffff);
        let sender = bus.get_unique_name().replace(/^:/, '').replace(/\./g, '_');
        let requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

        let subId = 0;
        let finish = (added) => {
            if (subId) { bus.signal_unsubscribe(subId); subId = 0; }
            if (callback) callback(added);
        };

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
                if (responseCode !== 0) { finish(0); return; }
                let urisVariant = results['uris'];
                let uris = urisVariant ? urisVariant.deepUnpack() : [];
                let added = 0;
                for (let uri of uris)
                    if (this.addFile(uri)) added++;
                finish(added);
            }
        );

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
                    console.error('NotchNux: FileChooser portal call failed', e);
                    finish(0);
                }
            }
        );
    }

    // --- Sticky Notes API ---
    loadNotes() {
        try {
            let file = Gio.File.new_for_path(this.notesFile);
            let [success, contents] = file.load_contents(null);
            if (success) {
                return new TextDecoder('utf-8').decode(contents);
            }
        } catch (e) {
            console.error('NotchNux: Error loading notes file', e);
        }
        return '';
    }

    saveNotes(text) {
        try {
            let file = Gio.File.new_for_path(this.notesFile);
            file.replace_contents(
                text,
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
        } catch (e) {
            console.error('NotchNux: Error saving notes file', e);
        }
    }

    // --- Formatting Helper ---
    _formatSize(bytes) {
        if (bytes === 0) return '0 B';
        let k = 1024;
        let sizes = ['B', 'KB', 'MB', 'GB'];
        let i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}
