// Clipboard history: the last few bits of text you copied, so one can be
// copied again from the notch.
//
// Event-driven: Meta.Selection emits 'owner-changed' whenever any client takes
// the clipboard, and only then do we read the text. Nothing polls.
//
// Privacy:
//   - Copies a password manager marks as secret (the KDE hint mime type that
//     KeePassXC, Bitwarden, 1Password etc. set) are never read.
//   - History lives in memory only. Pinned clips are the one thing written to
//     disk (~/.local/share/notchnux/clips.json, 0600) so they survive a
//     restart.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { DATA_DIR, readText, writeText } from './productivity.js';

const CLIPS_PATH = GLib.build_filenamev([DATA_DIR, 'clips.json']);
const MAX_RECENT = 20;
const MAX_PINNED = 20;
const MAX_TEXT = 20000;
const SECRET_MIMES = ['x-kde-passwordManagerHint'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

export class ClipboardHistory {
    constructor() {
        this.onChanged = null;
        this._items = [];
        this._seq = 0;
        this._selection = null;
        this._ownerId = 0;
        this._readId = 0;
        this._loadPinned();
    }

    get items() {
        return this._items;
    }

    get running() {
        return this._ownerId !== 0;
    }

    start() {
        if (this._ownerId)
            return;
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (sel, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onOwnerChanged(source);
        });
    }

    stop() {
        if (this._ownerId) {
            this._selection.disconnect(this._ownerId);
            this._ownerId = 0;
        }
        if (this._readId) {
            GLib.Source.remove(this._readId);
            this._readId = 0;
        }
        this._selection = null;
        // Forget unpinned history the moment the feature is turned off.
        this._items = this._items.filter(i => i.pinned);
        this._emit();
    }

    destroy() {
        this.stop();
        this.onChanged = null;
    }

    _onOwnerChanged(source) {
        if (!source)
            return;
        let mimes = [];
        try {
            mimes = source.get_mimetypes() ?? [];
        } catch (e) {}
        if (mimes.some(m => SECRET_MIMES.includes(m)))
            return;
        if (!mimes.some(m => TEXT_MIMES.includes(m)))
            return;
        // Apps often set the clipboard several times in a row; read once.
        if (this._readId)
            GLib.Source.remove(this._readId);
        let app = '';
        try {
            app = Shell.WindowTracker.get_default().focus_app?.get_name() ?? '';
        } catch (e) {}
        this._readId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._readId = 0;
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (c, text) => {
                if (this._ownerId && typeof text === 'string')
                    this._add(text, app);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _add(text, app) {
        if (!text.trim())
            return;
        if (text.length > MAX_TEXT)
            text = text.slice(0, MAX_TEXT);
        let existing = this._items.find(i => i.text === text);
        if (existing) {
            // Copying something again moves it to the top.
            this._items = [existing, ...this._items.filter(i => i !== existing)];
            existing.at = Date.now();
        } else {
            this._items.unshift({ id: ++this._seq, text, app, at: Date.now(), pinned: false });
            let recent = 0;
            this._items = this._items.filter(i => i.pinned || ++recent <= MAX_RECENT);
        }
        this._emit();
    }

    copy(id) {
        let item = this._items.find(i => i.id === id);
        if (item)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
        return !!item;
    }

    togglePin(id) {
        let item = this._items.find(i => i.id === id);
        if (!item)
            return;
        if (!item.pinned && this._items.filter(i => i.pinned).length >= MAX_PINNED)
            return;
        item.pinned = !item.pinned;
        this._savePinned();
        this._emit();
    }

    remove(id) {
        let item = this._items.find(i => i.id === id);
        this._items = this._items.filter(i => i.id !== id);
        if (item?.pinned)
            this._savePinned();
        this._emit();
    }

    // Clears the unpinned history; pinned clips stay.
    clear() {
        this._items = this._items.filter(i => i.pinned);
        this._emit();
    }

    _loadPinned() {
        try {
            let list = JSON.parse(readText(CLIPS_PATH) ?? '[]');
            for (let p of Array.isArray(list) ? list.slice(0, MAX_PINNED) : []) {
                if (typeof p?.text === 'string' && p.text)
                    this._items.push({ id: ++this._seq, text: p.text.slice(0, MAX_TEXT), app: String(p.app ?? ''), at: Number(p.at) || 0, pinned: true });
            }
        } catch (e) {
            // A corrupt file just means no pinned clips.
        }
    }

    _savePinned() {
        let pinned = this._items.filter(i => i.pinned).map(({ text, app, at }) => ({ text, app, at }));
        writeText(CLIPS_PATH, JSON.stringify(pinned));
    }

    _emit() {
        try {
            this.onChanged?.();
        } catch (e) {
            console.error('NotchNux: clipboard listener failed', e);
        }
    }
}
