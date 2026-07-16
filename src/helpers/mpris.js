import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const DBUS_SERVICE = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

export class MprisHelper {
    constructor() {
        this.players = new Map(); // busName -> DBusProxy
        this.activePlayerBus = null;
        this.onMetadataChanged = null;
        this.onPlaybackChanged = null;
        this.onPlayersListChanged = null;

        this._dbusProxy = null;
        this._nameOwnerChangedId = 0;
        this._pollId = 0;
        this._lastSnapshot = '';

        this._initDBus();
        this._startPolling();
    }

    destroy() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        if (this._dbusProxy && this._nameOwnerChangedId) {
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);
        }
        for (let proxy of this.players.values()) {
            // These are GObject signal handlers (proxy.connect), so they must
            // be released with disconnect(), not disconnectSignal().
            if (proxy._propertiesChangedId)
                proxy.disconnect(proxy._propertiesChangedId);
        }
        this.players.clear();
    }

    // Spotify (and some other players) are unreliable about emitting D-Bus
    // PropertiesChanged, so the proxy's cached PlaybackStatus/Metadata can go
    // stale — the extension would show "No Media" while music is playing.
    // Poll on a low-frequency timer, re-select the active player, and only
    // fire callbacks when something actually changed to avoid needless redraws.
    _startPolling() {
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            this._syncPlayers();
            if (this.players.size > 0) {
                this._refreshAllLiveProps(() => {
                    // Re-select after the async D-Bus reads complete. Reading
                    // immediately after scheduling GetAll used the previous
                    // cache, so Spotify could be playing while the UI still
                    // showed "No Media" until another event happened.
                    this._revaluateActivePlayer(true);
                    let info = this.getActiveTrackInfo();
                    let snap = `${info.status}|${info.title}|${info.artist}`;
                    if (snap !== this._lastSnapshot) {
                        this._lastSnapshot = snap;
                        if (this.onMetadataChanged) this.onMetadataChanged(info);
                        if (this.onPlaybackChanged) this.onPlaybackChanged(info.status);
                    }
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _syncPlayers() {
        if (!this._dbusProxy)
            return;

        try {
            let result = this._dbusProxy.call_sync(
                'ListNames',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            let [names] = result.deep_unpack();
            let livePlayers = new Set(names.filter(name => name.startsWith(MPRIS_PREFIX)));

            for (let name of livePlayers) {
                if (!this.players.has(name))
                    this._addPlayer(name);
            }

            for (let name of [...this.players.keys()]) {
                if (!livePlayers.has(name))
                    this._removePlayer(name);
            }
        } catch (e) {
            console.error('NotchNux: Failed to resync MPRIS players', e);
        }
    }

    _initDBus() {
        try {
            this._dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                DBUS_SERVICE,
                DBUS_PATH,
                DBUS_INTERFACE,
                null
            );

            // 1. Monitor new/removed players via NameOwnerChanged
            this._nameOwnerChangedId = this._dbusProxy.connectSignal(
                'NameOwnerChanged',
                (proxy, sender, [name, oldOwner, newOwner]) => {
                    if (name.startsWith(MPRIS_PREFIX)) {
                        if (newOwner === '') {
                            // Player closed
                            this._removePlayer(name);
                        } else {
                            // Player opened
                            this._addPlayer(name);
                        }
                    }
                }
            );

            // 2. Load existing players
            let result = this._dbusProxy.call_sync(
                'ListNames',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            let [names] = result.deep_unpack();
            for (let name of names) {
                if (name.startsWith(MPRIS_PREFIX)) {
                    this._addPlayer(name);
                }
            }
        } catch (e) {
            console.error('NotchNux: Failed to initialize D-Bus tracking for MPRIS', e);
        }
    }

    _addPlayer(busName) {
        if (this.players.has(busName)) return;

        try {
            let proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                MPRIS_PLAYER_INTERFACE,
                null
            );

            // Watch properties changed (track metadata, playback status)
            proxy._propertiesChangedId = proxy.connect(
                'g-properties-changed',
                (p, changed, invalidated) => {
                    this._onPlayerPropertiesChanged(busName, changed);
                }
            );

            this.players.set(busName, proxy);

            // A freshly-created proxy may not have its properties cached yet,
            // so the very first read shows "Unknown Title". Nudge a refresh on
            // the next idle tick once the cache has settled, and re-evaluate
            // which player should be active with real metadata in hand.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this.players.has(busName)) {
                    this._refreshLiveProps(busName, proxy, () => {
                        this._revaluateActivePlayer();
                        this._triggerCallbacks();
                    });
                }
                return GLib.SOURCE_REMOVE;
            });

            // Select active player if we don't have one, or if this one is playing
            this._revaluateActivePlayer();

            if (this.onPlayersListChanged) {
                this.onPlayersListChanged();
            }
        } catch (e) {
            console.error(`NotchNux: Error setting up MPRIS proxy for ${busName}`, e);
        }
    }

    _removePlayer(busName) {
        let proxy = this.players.get(busName);
        if (proxy) {
            if (proxy._propertiesChangedId) {
                proxy.disconnect(proxy._propertiesChangedId);
            }
            this.players.delete(busName);
        }

        if (this.activePlayerBus === busName) {
            this.activePlayerBus = null;
            this._revaluateActivePlayer();
        }

        if (this.onPlayersListChanged) {
            this.onPlayersListChanged();
        }
    }

    _onPlayerPropertiesChanged(busName, changed) {
        let unpacked = changed.deep_unpack();
        
        // If this player is now playing, switch active player to it
        if (unpacked.PlaybackStatus && unpacked.PlaybackStatus.deep_unpack() === 'Playing') {
            this.activePlayerBus = busName;
        }

        if (this.activePlayerBus === busName) {
            let proxy = this.players.get(busName);
            if (proxy) proxy._liveProps = null;
            this._triggerCallbacks();
        }
    }

    // When `silent` is true, select the active player without firing the
    // change callbacks (used by the poll loop, which dispatches them itself).
    _revaluateActivePlayer(silent = false) {
        let fire = () => { if (!silent) this._triggerCallbacks(); };

        if (this.players.size === 0) {
            this.activePlayerBus = null;
            fire();
            return;
        }

        // 1. Try to find a player that is currently 'Playing'
        for (let [busName, proxy] of this.players.entries()) {
            let status = this._getProxyProperty(proxy, 'PlaybackStatus');
            if (status === 'Playing') {
                this.activePlayerBus = busName;
                fire();
                return;
            }
        }

        // 2. Otherwise prefer a paused player that actually has a track loaded
        // (has a title in its metadata) over an idle one, so we don't show
        // "Unknown Title" while another player has real media.
        for (let [busName, proxy] of this.players.entries()) {
            let metadata = this._getProxyProperty(proxy, 'Metadata');
            if (metadata && metadata['xesam:title']) {
                this.activePlayerBus = busName;
                fire();
                return;
            }
        }

        // 3. Fall back to the first available player in our list
        if (!this.activePlayerBus || !this.players.has(this.activePlayerBus)) {
            this.activePlayerBus = this.players.keys().next().value;
        }

        fire();
    }

    // Asynchronously pull the current Player properties straight from the bus
    // and stash them on the proxy, bypassing the (possibly stale) proxy cache.
    _refreshAllLiveProps(done) {
        let pending = this.players.size;
        if (pending === 0) {
            done();
            return;
        }

        let finishOne = () => {
            pending--;
            if (pending === 0)
                done();
        };

        for (let [busName, proxy] of this.players.entries())
            this._refreshLiveProps(busName, proxy, finishOne);
    }

    _refreshLiveProps(busName, proxy, done = null) {
        try {
            Gio.DBus.session.call(
                busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', [MPRIS_PLAYER_INTERFACE]),
                null, Gio.DBusCallFlags.NONE, 2000, null,
                (conn, res) => {
                    try {
                        let reply = conn.call_finish(res);
                        let [props] = reply.deep_unpack();
                        proxy._liveProps = props; // { name -> GLib.Variant }
                    } catch (e) {
                        // Player may have vanished mid-call; ignore.
                    } finally {
                        if (done) done();
                    }
                }
            );
        } catch (e) {
            // ignore transient bus errors
            if (done) done();
        }
    }

    _getProxyProperty(proxy, propName) {
        // Prefer freshly-fetched live properties over the proxy's cache, since
        // the cache can be stale for players that skip PropertiesChanged.
        try {
            let live = proxy._liveProps?.[propName];
            if (live !== undefined) {
                // GetAll returns an a{sv}: deep_unpack() peels only the outer
                // container, leaving each value (and every nested dict value in
                // Metadata) as a GLib.Variant. recursiveUnpack() fully unwraps
                // it so callers get plain strings/arrays/booleans — matching
                // what the proxy cache path below yields. Without this, e.g.
                // metadata['xesam:title'] is a Variant, not the title string.
                if (live instanceof GLib.Variant)
                    return live.recursiveUnpack();
                return live;
            }
        } catch (e) {
            // fall through to cache
        }
        try {
            // GJS exposes the cached property as a GLib.Variant via
            // get_cached_property() — note there is no *_value() variant, so
            // calling that (as this code used to) throws and silently drops
            // every cached read, leaving us stuck on "No Media".
            let val = proxy.get_cached_property(propName);
            // recursiveUnpack (not deep_unpack) so nested a{sv} values — every
            // Metadata entry like xesam:title/xesam:artist — come out as plain
            // strings/arrays instead of GLib.Variants. Passing a Variant as an
            // St.Label `text:` throws "Wrong type GObject_Struct; string
            // expected", which used to bubble out of _renderMediaTab and wedge
            // the dashboard open (isExpanded stuck true → hover stops opening).
            if (val) return val.recursiveUnpack();
        } catch (e) {
            // Property not cached yet
        }
        return null;
    }

    _triggerCallbacks() {
        let info = this.getActiveTrackInfo();
        if (this.onMetadataChanged) {
            this.onMetadataChanged(info);
        }
        if (this.onPlaybackChanged) {
            this.onPlaybackChanged(info.status);
        }
    }

    getActiveTrackInfo() {
        if (!this.activePlayerBus) {
            return {
                title: 'No Media',
                artist: 'Nothing playing',
                albumArt: '',
                status: 'Stopped',
                hasMedia: false,
                canPlay: false,
                canNext: false,
                canPrev: false
            };
        }

        let proxy = this.players.get(this.activePlayerBus);
        if (!proxy) {
            return {
                title: 'No Media',
                artist: 'Nothing playing',
                albumArt: '',
                status: 'Stopped',
                hasMedia: false,
                canPlay: false,
                canNext: false,
                canPrev: false
            };
        }

        let status = this._getProxyProperty(proxy, 'PlaybackStatus') || 'Stopped';
        let metadata = this._getProxyProperty(proxy, 'Metadata') || {};
        let canPlay = this._getProxyProperty(proxy, 'CanPlay') !== false;
        let canNext = this._getProxyProperty(proxy, 'CanGoNext') !== false;
        let canPrev = this._getProxyProperty(proxy, 'CanGoPrevious') !== false;
        let canSeek = this._getProxyProperty(proxy, 'CanSeek') === true;
        // Optional properties: not every player implements Shuffle/LoopStatus.
        // Track whether they're present so the UI can dim unsupported buttons.
        let rawShuffle = this._getProxyProperty(proxy, 'Shuffle');
        let hasShuffle = rawShuffle !== null && rawShuffle !== undefined;
        let shuffle = rawShuffle === true;
        let rawLoop = this._getProxyProperty(proxy, 'LoopStatus');
        let hasLoop = typeof rawLoop === 'string';
        let loopStatus = hasLoop ? rawLoop : 'None';

        // Track length (µs) and the current track id, both from metadata. The
        // length feeds the timeline scrubber; the track id is required by
        // SetPosition so a seek is rejected if the track changed underneath us.
        let length = Number(metadata['mpris:length'] ?? 0) || 0;
        let trackId = metadata['mpris:trackid'] ?? null;

        let title = metadata['xesam:title'] || 'Unknown Title';
        let artist = metadata['xesam:artist'];
        if (Array.isArray(artist)) {
            artist = artist.join(', ');
        } else {
            artist = artist || 'Unknown Artist';
        }

        let artUrl = metadata['mpris:artUrl'] || '';
        
        // Shorten only at the helper boundary enough to prevent pathological
        // labels; the media tab applies its own layout-sized cap.
        if (title.length > 64) title = title.substring(0, 61) + '...';
        if (artist.length > 64) artist = artist.substring(0, 61) + '...';

        return {
            title: title,
            artist: artist,
            albumArt: artUrl,
            status: status,
            hasMedia: true,
            canPlay: canPlay,
            canNext: canNext,
            canPrev: canPrev,
            canSeek: canSeek,
            length: length,
            trackId: trackId,
            hasShuffle: hasShuffle,
            shuffle: shuffle,
            hasLoop: hasLoop,
            loopStatus: loopStatus
        };
    }

    // Read the active player's current playback position in microseconds.
    // Position is intentionally NOT emitted via PropertiesChanged by the MPRIS
    // spec, so it must be fetched live rather than read from the proxy cache.
    // Returns 0 if unavailable.
    getPosition() {
        if (!this.activePlayerBus) return 0;
        try {
            let reply = Gio.DBus.session.call_sync(
                this.activePlayerBus, MPRIS_PATH, 'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                null, Gio.DBusCallFlags.NONE, 800, null);
            let [variant] = reply.deep_unpack();
            let pos = variant instanceof GLib.Variant ? variant.deep_unpack() : variant;
            return Number(pos) || 0;
        } catch (e) {
            // Player may not implement Position, or vanished mid-call.
            return 0;
        }
    }

    // --- Control API ---
    playPause() {
        if (!this.activePlayerBus) return;
        let proxy = this.players.get(this.activePlayerBus);
        if (proxy) {
            proxy.call('PlayPause', null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    next() {
        if (!this.activePlayerBus) return;
        let proxy = this.players.get(this.activePlayerBus);
        if (proxy) {
            proxy.call('Next', null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    previous() {
        if (!this.activePlayerBus) return;
        let proxy = this.players.get(this.activePlayerBus);
        if (proxy) {
            proxy.call('Previous', null, Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    // Seek by a relative offset in microseconds (may be negative to rewind).
    seek(offsetUs) {
        if (!this.activePlayerBus) return;
        let proxy = this.players.get(this.activePlayerBus);
        if (proxy) {
            proxy.call('Seek', new GLib.Variant('(x)', [Math.round(offsetUs)]),
                Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    // Jump to an absolute position (µs) within the given track. trackId comes
    // from getActiveTrackInfo().trackId; the player ignores the call if the
    // current track no longer matches, which guards against races.
    setPosition(trackId, positionUs) {
        if (!this.activePlayerBus || !trackId) return;
        let proxy = this.players.get(this.activePlayerBus);
        if (proxy) {
            proxy.call('SetPosition',
                new GLib.Variant('(ox)', [trackId, Math.round(positionUs)]),
                Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    // Shuffle and LoopStatus are writable Player *properties*, not methods, so
    // they're set through the standard Properties interface.
    _setPlayerProperty(name, value) {
        if (!this.activePlayerBus) return;
        Gio.DBus.session.call(
            this.activePlayerBus, MPRIS_PATH, 'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [MPRIS_PLAYER_INTERFACE, name, value]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    toggleShuffle() {
        let info = this.getActiveTrackInfo();
        if (!info.hasShuffle) return;
        this._setPlayerProperty('Shuffle', GLib.Variant.new_boolean(!info.shuffle));
    }

    // Cycle None → Playlist → Track → None, matching how most players present
    // "repeat off / repeat all / repeat one".
    cycleLoop() {
        let info = this.getActiveTrackInfo();
        if (!info.hasLoop) return;
        let next = info.loopStatus === 'None' ? 'Playlist'
            : info.loopStatus === 'Playlist' ? 'Track' : 'None';
        this._setPlayerProperty('LoopStatus', GLib.Variant.new_string(next));
    }
}
