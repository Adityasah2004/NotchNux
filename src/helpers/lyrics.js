// Timed lyrics for the playing song, from lrclib.net (free, no account).
//
// Only the song's title, artist, album and length are sent. Results — found or
// not — are cached on disk (~/.cache/notchnux/lyrics) so a song is looked up
// once, not every time it plays; a miss is retried after a week.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const API = 'https://lrclib.net/api';
const USER_AGENT = 'NotchNux (https://github.com/Adityasah2004/NotchNux)';
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

// "[mm:ss.xx] text" lines → [{ t: ms, text }], sorted. A line may carry
// several time tags ("[00:12.00][01:30.00]chorus"). Metadata tags such as
// [ar:…] are ignored.
export function parseLrc(lrc) {
    let out = [];
    for (let raw of String(lrc ?? '').split(/\r?\n/)) {
        let tags = [];
        let rest = raw;
        let m;
        while ((m = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest))) {
            let secs = parseFloat(m[2].replace(':', '.'));
            tags.push(Math.round((parseInt(m[1], 10) * 60 + secs) * 1000));
            rest = rest.slice(m[0].length);
        }
        let text = rest.trim();
        for (let t of tags)
            out.push({ t, text });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

// Index of the line being sung at `ms` (-1 before the first line).
export function lineAt(lines, ms) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        let mid = (lo + hi) >> 1;
        if (lines[mid].t <= ms) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function cacheKey(track) {
    let id = `${track.artist}\u0001${track.title}\u0001${track.album ?? ''}`.toLowerCase();
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, id, -1);
}

export class LyricsService {
    constructor() {
        this._session = new Soup.Session({ timeout: 12, user_agent: USER_AGENT });
        this._cancellable = new Gio.Cancellable();
        this._memo = new Map();
        // key -> callbacks waiting on a lookup already on the wire, so the
        // Music tab's availability check and the lyrics view share one request.
        this._inflight = new Map();
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchnux', 'lyrics']);
        GLib.mkdir_with_parents(this._dir, 0o700);
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._memo.clear();
        this._inflight.clear();
    }

    // Calls back with { synced: [{t,text}] | null, plain: string | null } or
    // null when nothing was found / the lookup failed. `allowNetwork` false
    // answers from the cache only.
    lookup(track, allowNetwork, cb) {
        if (!track?.title || track.title === 'Unknown Title') {
            cb(null);
            return;
        }
        let key = cacheKey(track);
        if (this._memo.has(key)) {
            cb(this._memo.get(key));
            return;
        }
        let cached = this._readCache(key);
        if (cached !== undefined) {
            this._memo.set(key, cached);
            cb(cached);
            return;
        }
        if (!allowNetwork) {
            cb(null);
            return;
        }
        let waiting = this._inflight.get(key);
        if (waiting) {
            waiting.push(cb);
            return;
        }
        waiting = [cb];
        this._inflight.set(key, waiting);
        let done = result => {
            this._inflight.delete(key);
            for (let fn of waiting)
                fn(result);
        };
        this._fetch(key, track, done);
    }

    _fetch(key, track, cb) {
        let params = {
            track_name: track.title,
            artist_name: track.artist && track.artist !== 'Unknown Artist' ? track.artist : '',
        };
        if (track.album)
            params.album_name = track.album;
        if (track.length > 0)
            params.duration = String(Math.round(track.length / 1e6));
        this._get('get', params, (status, json) => {
            if (status === 200 && json) {
                this._finish(key, json, cb);
                return;
            }
            if (status !== 404) {
                // Network trouble: don't cache, maybe next time.
                cb(null);
                return;
            }
            // No exact match (album/length differ): fall back to search.
            this._get('search', { track_name: params.track_name, artist_name: params.artist_name }, (s2, list) => {
                let hit = Array.isArray(list)
                    ? list.find(r => r.syncedLyrics) ?? list.find(r => r.plainLyrics) : null;
                if (s2 === 200)
                    this._finish(key, hit, cb);
                else
                    cb(null);
            });
        });
    }

    _finish(key, json, cb) {
        let result = null;
        if (json && !json.instrumental) {
            let synced = json.syncedLyrics ? parseLrc(json.syncedLyrics) : null;
            let plain = typeof json.plainLyrics === 'string' ? json.plainLyrics : null;
            if ((synced && synced.length) || plain)
                result = { synced: synced?.length ? synced : null, plain };
        }
        this._writeCache(key, result);
        this._memo.set(key, result);
        cb(result);
    }

    _get(path, params, cb) {
        let query = Object.entries(params)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`)
            .join('&');
        let msg;
        try {
            msg = Soup.Message.new('GET', `${API}/${path}?${query}`);
        } catch (e) {
            cb(0, null);
            return;
        }
        this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
            let bytes;
            try {
                bytes = s.send_and_read_finish(res);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    cb(0, null);
                return;
            }
            let status = msg.get_status();
            let json = null;
            if (status === 200) {
                try {
                    json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (e) {
                    status = 0;
                }
            }
            cb(status, json);
        });
    }

    // undefined = not cached; null = cached miss (still fresh).
    _readCache(key) {
        try {
            let [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([this._dir, `${key}.json`]));
            if (!ok)
                return undefined;
            let entry = JSON.parse(new TextDecoder().decode(bytes));
            if (!entry.result && Date.now() - (entry.at ?? 0) > MISS_TTL_MS)
                return undefined;
            return entry.result ?? null;
        } catch (e) {
            return undefined;
        }
    }

    _writeCache(key, result) {
        try {
            GLib.file_set_contents(GLib.build_filenamev([this._dir, `${key}.json`]),
                JSON.stringify({ at: Date.now(), result }));
        } catch (e) {}
    }
}
