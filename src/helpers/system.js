import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import UPower from 'gi://UPowerGlib';
import Gvc from 'gi://Gvc';
import NM from 'gi://NM';

// We import Main to control screen brightness and check layout
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class SystemHelper {
    constructor() {
        // Initialize CPU stat tracking variables
        this._lastCpuTotal = 0;
        this._lastCpuIdle = 0;
        this._cpuUsage = 0;
        this._cpuTimeout = null;

        // Network throughput tracking: bytes counters + timestamp from the
        // previous sample, so we can turn deltas into a download/upload rate.
        this._lastNetRx = null;
        this._lastNetTx = null;
        this._lastNetStamp = 0;
        this._netRxRate = 0; // bytes/sec down
        this._netTxRate = 0; // bytes/sec up

        // One cancellable for every async call/subprocess we start, so
        // destroy() can stop all of them at once.
        this._cancellable = new Gio.Cancellable();
        this._timeouts = new Set();

        // UPower client, created asynchronously (the sync constructor blocks on
        // the system bus on every enable, i.e. every unlock). `onPowerReady`
        // fires once it's up. The display device and accessory list are cached:
        // libupower's getters make synchronous D-Bus calls of their own.
        this._upowerClient = null;
        this._displayDevice = null;
        this._upowerAccessories = [];
        this.onPowerReady = null;
        try {
            UPower.Client.new_async(this._cancellable, (o, res) => {
                try {
                    this._upowerClient = UPower.Client.new_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error('NotchNux: Failed to initialize UPower Client', e);
                    return;
                }
                // One-time lookup, cached: the display device's properties
                // update live, so the clock tick never re-queries it.
                this._displayDevice = this._upowerClient.get_display_device();
                this.onPowerReady?.();
            });
        } catch (e) {
            console.error('NotchNux: Failed to initialize UPower Client', e);
        }

        // NetworkManager client for WiFi state + hotspot control. Created async
        // so we never block the shell; getWifiInfo/toggles no-op until it's up.
        // `onWifiChanged` (set by the shell) fires once the client is ready and
        // whenever WiFi state changes, so a Tray tab open before NM was up still
        // gets a populated WiFi row as soon as it becomes available.
        this._nmClient = null;
        this._nmSignalIds = [];
        this.onWifiChanged = null;
        try {
            NM.Client.new_async(this._cancellable, (obj, res) => {
                try {
                    this._nmClient = NM.Client.new_finish(res);
                    // NM.Client has no custom signals in this version — watch the
                    // relevant properties instead. wireless-enabled covers the
                    // radio toggle; active-connections covers connect/disconnect
                    // and hotspot activation; state is a catch-all.
                    for (let prop of ['wireless-enabled', 'active-connections', 'state']) {
                        this._nmSignalIds.push(this._nmClient.connect(`notify::${prop}`,
                            () => this._emitWifiChanged()));
                    }
                    this._emitWifiChanged();
                } catch (e) {
                    console.warn('NotchNux: NetworkManager unavailable', e.message);
                }
            });
        } catch (e) {
            console.warn('NotchNux: failed to start NetworkManager client', e.message);
        }

        // Initialize Gio Volume Monitor
        try {
            this._volumeMonitor = Gio.VolumeMonitor.get();
        } catch (e) {
            console.error('NotchNux: Failed to initialize Gio Volume Monitor', e);
        }

        // Initialize Volume Controller (Gvc)
        this._mixerControl = null;
        this._audioStream = null;
        this._micStream = null;
        this.volume = 0;
        this.isMuted = false;
        this.onVolumeChanged = null;
        this.onMicChanged = null;
        // Fires when the audio output switches to another device or port
        // (not for the first one found at start-up).
        this.onOutputChanged = null;
        this._outputKey = null;

        // Mic/camera "in use" state, refreshed from PipeWire on the poll below.
        this._micInUse = false;
        this._camInUse = false;
        this.onPrivacyChanged = null;

        try {
            this._initVolumeControl();
        } catch (e) {
            console.error('NotchNux: Failed to initialize Gvc volume control', e);
        }

        // System throughput/CPU polling is started on demand when the System tab is open
        this._sysPollingTimeout = null;

        // Privacy monitors start via setPrivacyPolling() — only while the
        // pill's mic/camera dots are enabled.
        this._privacyOn = false;
        this._pwNodes = new Map();      // PipeWire node id -> { mediaClass, state }
        this._camV4l2 = false;
        this._privacyProcs = {};        // name -> { proc, cancellable, restartId, restarts }
    }

    // Watch for mic/camera use while the privacy indicators are on. Both
    // sources are long-lived processes that *push* changes: polling spawned
    // pw-dump + fuser from the compositor every 6 s and parsed ~230 KB of JSON
    // each time (~100 ms of main-thread work per poll).
    setPrivacyPolling(enabled) {
        if (enabled === this._privacyOn)
            return;
        this._privacyOn = enabled;
        if (enabled) {
            this._startPrivacyProc('pw', ['pw-dump', '--monitor', '--no-colors'],
                chunk => this._applyPipewireChunk(chunk), '\n]\n');
            let script = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
                .get_child('tools').get_child('v4l2-watch.sh').get_path();
            this._startPrivacyProc('v4l2', ['sh', script], line => {
                this._camV4l2 = line.trim() === '1';
                this._recomputePrivacy();
            }, '\n');
        } else {
            for (let name of Object.keys(this._privacyProcs))
                this._stopPrivacyProc(name);
            this._pwNodes.clear();
            this._camV4l2 = false;
            this._commitPrivacyState(false, false);
        }
    }

    // Spawn `argv`, read its stdout asynchronously and hand every complete
    // record (text up to `sep`) to `onRecord`. Restarts with backoff if the
    // process dies (e.g. PipeWire restarted), a few times at most.
    _startPrivacyProc(name, argv, onRecord, sep) {
        this._stopPrivacyProc(name);
        let entry = { proc: null, cancellable: new Gio.Cancellable(), restartId: 0,
            restarts: this._privacyProcs[name]?.restarts ?? 0 };
        this._privacyProcs[name] = entry;
        try {
            entry.proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            // Tool not installed: that source simply never reports "in use".
            return;
        }
        let stream = entry.proc.get_stdout_pipe();
        let decoder = new TextDecoder();
        let sepBytes = new TextEncoder().encode(sep);
        // Raw bytes until a full record arrives: GJS's TextDecoder has no
        // streaming mode, and the separators are ASCII, so decoding whole
        // records never splits a multi-byte character.
        let buf = new Uint8Array(0);
        let read = () => stream.read_bytes_async(65536, GLib.PRIORITY_LOW, entry.cancellable, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch (e) {
                return; // cancelled
            }
            if (bytes.get_size() === 0) {
                // EOF: the monitor died. Retry a few times, then give up.
                if (this._privacyOn && entry.restarts < 5 && this._privacyProcs[name] === entry) {
                    entry.restarts++;
                    entry.restartId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5 * entry.restarts, () => {
                        entry.restartId = 0;
                        if (this._privacyOn && this._privacyProcs[name] === entry)
                            this._startPrivacyProc(name, argv, onRecord, sep);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
            let chunk = bytes.toArray();
            let merged = new Uint8Array(buf.length + chunk.length);
            merged.set(buf);
            merged.set(chunk, buf.length);
            buf = merged;
            let idx;
            while ((idx = indexOfBytes(buf, sepBytes)) >= 0) {
                let record = decoder.decode(buf.subarray(0, idx + sepBytes.length - 1));
                buf = buf.slice(idx + sepBytes.length);
                try {
                    onRecord(record);
                } catch (e) {
                    console.warn(`NotchNux: privacy monitor ${name}: ${e.message}`);
                }
            }
            read();
        });
        read();
    }

    _stopPrivacyProc(name) {
        let entry = this._privacyProcs[name];
        if (!entry) return;
        delete this._privacyProcs[name];
        entry.cancellable.cancel();
        if (entry.restartId) GLib.Source.remove(entry.restartId);
        entry.proc?.force_exit();
    }

    startSysPolling() {
        if (this._sysPollingTimeout) return;
        this._updateCpuUsage();
        this._updateNetUsage();
        this._sysPollingTimeout = GLib.timeout_add(GLib.PRIORITY_LOW, 2500, () => {
            this._updateCpuUsage();
            this._updateNetUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopSysPolling() {
        if (this._sysPollingTimeout) {
            GLib.Source.remove(this._sysPollingTimeout);
            this._sysPollingTimeout = null;
        }
    }

    // One-shot timer that destroy() can cancel.
    _later(ms, fn) {
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // The cached UPower display device (laptop battery aggregate), or null
    // until the client is up.
    get displayDevice() {
        return this._displayDevice;
    }

    destroy() {
        this.onWifiChanged = null;
        this.onPowerReady = null;
        this._displayDevice = null;
        this.onVolumeChanged = null;
        this.onMicChanged = null;
        this.onPrivacyChanged = null;
        this.onOutputChanged = null;
        if (this._audioStream && this._portNotifyId) {
            this._audioStream.disconnect(this._portNotifyId);
            this._portNotifyId = 0;
        }
        this._cancellable.cancel();
        for (let id of this._timeouts)
            GLib.Source.remove(id);
        this._timeouts.clear();
        this.stopSysPolling();
        this._privacyOn = false;
        for (let name of Object.keys(this._privacyProcs))
            this._stopPrivacyProc(name);
        if (this._audioStream) {
            if (this._volNotifyId) this._audioStream.disconnect(this._volNotifyId);
            if (this._muteNotifyId) this._audioStream.disconnect(this._muteNotifyId);
            this._audioStream = null;
        }
        if (this._micStream && this._micMuteNotifyId) {
            this._micStream.disconnect(this._micMuteNotifyId);
            this._micStream = null;
        }
        if (this._mixerControl) {
            for (let id of this._mixerSignalIds ?? [])
                this._mixerControl.disconnect(id);
            this._mixerControl.close();
            this._mixerControl = null;
        }
        if (this._nmClient) {
            for (let id of this._nmSignalIds)
                this._nmClient.disconnect(id);
            this._nmSignalIds = [];
        }
        this._nmClient = null;
    }

    // --- CPU Usage ---
    _updateCpuUsage() {
        try {
            let file = Gio.File.new_for_path('/proc/stat');
            let [success, contents] = file.load_contents(null);
            if (!success) return;

            let lines = ByteArrayToString(contents).split('\n');
            let cpuLine = lines.find(line => line.startsWith('cpu '));
            if (!cpuLine) return;

            let parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
            // parts: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
            let idle = parts[3] + parts[4];
            let nonIdle = parts[0] + parts[1] + parts[2] + parts[5] + parts[6] + parts[7];
            let total = idle + nonIdle;

            let totalDelta = total - this._lastCpuTotal;
            let idleDelta = idle - this._lastCpuIdle;

            if (totalDelta > 0) {
                this._cpuUsage = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
            }

            this._lastCpuTotal = total;
            this._lastCpuIdle = idle;
        } catch (e) {
            console.error('NotchNux: Error updating CPU usage', e);
        }
    }

    getCpuUsage() {
        return this._cpuUsage;
    }

    // --- Network throughput ---
    // Sum rx/tx bytes across all real interfaces (skip loopback and virtual
    // bridges/veth) from /proc/net/dev, then divide the delta by elapsed time
    // to get a live rate. First sample only seeds the counters.
    _updateNetUsage() {
        try {
            let file = Gio.File.new_for_path('/proc/net/dev');
            let [success, contents] = file.load_contents(null);
            if (!success) return;

            let lines = ByteArrayToString(contents).split('\n');
            let rx = 0, tx = 0;
            for (let line of lines) {
                let idx = line.indexOf(':');
                if (idx < 0) continue;
                let iface = line.slice(0, idx).trim();
                if (iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker') ||
                    iface.startsWith('br-') || iface.startsWith('virbr'))
                    continue;
                let cols = line.slice(idx + 1).trim().split(/\s+/).map(Number);
                // cols[0] = rx bytes, cols[8] = tx bytes
                if (cols.length >= 9) {
                    rx += cols[0];
                    tx += cols[8];
                }
            }

            let now = GLib.get_monotonic_time() / 1e6; // seconds
            if (this._lastNetRx !== null && this._lastNetStamp > 0) {
                let dt = now - this._lastNetStamp;
                if (dt > 0) {
                    this._netRxRate = Math.max(0, (rx - this._lastNetRx) / dt);
                    this._netTxRate = Math.max(0, (tx - this._lastNetTx) / dt);
                }
            }
            this._lastNetRx = rx;
            this._lastNetTx = tx;
            this._lastNetStamp = now;
        } catch (e) {
            console.error('NotchNux: Error updating network usage', e);
        }
    }

    // Download rate in bytes/sec.
    getNetDownRate() {
        return this._netRxRate;
    }

    // Upload rate in bytes/sec.
    getNetUpRate() {
        return this._netTxRate;
    }

    // Human-readable download rate, e.g. "1.2 MB/s" / "84 KB/s".
    getNetDownLabel() {
        return SystemHelper.formatRate(this._netRxRate);
    }

    // Human-readable upload rate.
    getNetUpLabel() {
        return SystemHelper.formatRate(this._netTxRate);
    }

    static formatRate(bytesPerSec) {
        if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '0 KB/s';
        let kb = bytesPerSec / 1024;
        if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB/s`;
        let mb = kb / 1024;
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
    }

    // --- RAM and Swap Usage ---
    _readMeminfo() {
        let now = GLib.get_monotonic_time();
        if (this._meminfoCache && (now - (this._meminfoStamp || 0)) < 1500000) {
            return this._meminfoCache;
        }
        let cache = { ram: 0, swap: 0 };
        try {
            let file = Gio.File.new_for_path('/proc/meminfo');
            let [success, contents] = file.load_contents(null);
            if (!success) return cache;

            let lines = ByteArrayToString(contents).split('\n');
            let memTotal = 0, memAvailable = 0, swapTotal = 0, swapFree = 0;
            for (let line of lines) {
                if (line.startsWith('MemTotal:')) memTotal = Number(line.replace(/\D/g, ''));
                else if (line.startsWith('MemAvailable:')) memAvailable = Number(line.replace(/\D/g, ''));
                else if (line.startsWith('SwapTotal:')) swapTotal = Number(line.replace(/\D/g, ''));
                else if (line.startsWith('SwapFree:')) swapFree = Number(line.replace(/\D/g, ''));
            }
            if (memTotal > 0) cache.ram = Math.round(((memTotal - memAvailable) / memTotal) * 100);
            if (swapTotal > 0) cache.swap = Math.round(((swapTotal - swapFree) / swapTotal) * 100);
            this._meminfoCache = cache;
            this._meminfoStamp = now;
        } catch (e) {
            console.error('NotchNux: Error reading meminfo', e);
        }
        return cache;
    }

    getRamUsage() {
        return this._readMeminfo().ram;
    }

    // --- Swap Usage --- (percentage of swap in use; 0 when no swap configured)
    getSwapUsage() {
        return this._readMeminfo().swap;
    }

    // --- Disk Usage --- (percentage used on the root filesystem)
    getDiskUsage() {
        try {
            let info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::used', null);
            let size = info.get_attribute_uint64('filesystem::size');
            let used = info.get_attribute_uint64('filesystem::used');
            if (size > 0)
                return Math.round((used / size) * 100);
        } catch (e) {
            console.error('NotchNux: Error reading disk usage', e);
        }
        return 0;
    }

    // --- Battery Level ---
    getBatteryInfo() {
        try {
            let displayDevice = this._displayDevice;
            if (displayDevice) {
                // state values: 1 = charging, 2 = discharging, 3 = empty, 4 = fully charged, 5 = pending charge
                let state = displayDevice.state;
                return {
                    percentage: Math.round(displayDevice.percentage),
                    isCharging: (state === 1 || state === 4 || state === 5)
                };
            }
        } catch (e) {
            console.error('NotchNux: Error reading battery', e);
        }
        return { percentage: 100, isCharging: false };
    }

    // --- Volume Control (Gvc) ---
    _initVolumeControl() {
        this._mixerControl = new Gvc.MixerControl({ name: 'NotchNux Volume Control' });
        this._mixerSignalIds = [
            this._mixerControl.connect('state-changed', (control, state) => {
                if (state === Gvc.MixerControlState.READY) {
                    this._updateAudioStream();
                    this._updateSourceStream();
                }
            }),
            this._mixerControl.connect('default-sink-changed', () => this._updateAudioStream()),
            this._mixerControl.connect('default-source-changed', () => this._updateSourceStream()),
        ];

        this._mixerControl.open();
    }

    // Track the default input (microphone) so we know its mute state.
    _updateSourceStream() {
        if (!this._mixerControl) return;
        let source = this._mixerControl.get_default_source();
        if (source === this._micStream) return;

        if (this._micStream && this._micMuteNotifyId)
            this._micStream.disconnect(this._micMuteNotifyId);

        this._micStream = source;
        if (this._micStream) {
            this._micMuteNotifyId = this._micStream.connect('notify::is-muted', () => {
                if (this.onMicChanged) this.onMicChanged();
            });
            if (this.onMicChanged) this.onMicChanged();
        }
    }

    // True when the microphone is muted at the source level.
    isMicMuted() {
        return this._micStream ? this._micStream.is_muted : false;
    }

    // --- Mic / camera "in use" detection (via PipeWire) ---
    // An app actively capturing audio/video creates a running Stream/Input node
    // (or drives the Source node into the running state). We snapshot PipeWire
    // with `pw-dump` and look for those, then flip _micInUse / _camInUse.
    isMicInUse() { return this._micInUse; }
    isCameraInUse() { return this._camInUse; }

    // One `pw-dump --monitor` record: a JSON array of added/changed objects
    // (removed ones arrive as { id, info: null }). Track just the nodes'
    // media class + state; the very first record is the full graph.
    _applyPipewireChunk(text) {
        let objects = JSON.parse(text);
        for (let o of objects) {
            if (o.info === null) {
                this._pwNodes.delete(o.id);
                continue;
            }
            if (o.type !== 'PipeWire:Interface:Node' || !o.info)
                continue;
            let node = this._pwNodes.get(o.id) ?? { mediaClass: '', state: '' };
            if (o.info.props?.['media.class'] !== undefined)
                node.mediaClass = o.info.props['media.class'];
            if (o.info.state !== undefined)
                node.state = o.info.state;
            this._pwNodes.set(o.id, node);
        }
        this._recomputePrivacy();
    }

    // A running capture stream (or a running source node) means in use.
    _recomputePrivacy() {
        let mic = false, cam = false;
        for (let { mediaClass, state } of this._pwNodes.values()) {
            if (state !== 'running')
                continue;
            if (mediaClass.includes('Stream/Input/Audio') || mediaClass === 'Audio/Source')
                mic = true;
            if (mediaClass.includes('Stream/Input/Video') || mediaClass === 'Video/Source')
                cam = true;
        }
        this._commitPrivacyState(mic, cam || this._camV4l2);
    }

    _commitPrivacyState(micInUse, camInUse) {
        if (micInUse !== this._micInUse || camInUse !== this._camInUse) {
            this._micInUse = micInUse;
            this._camInUse = camInUse;
            if (this.onPrivacyChanged) this.onPrivacyChanged();
        }
    }

    _updateAudioStream() {
        if (!this._mixerControl) return;

        let sink = this._mixerControl.get_default_sink();
        if (sink === this._audioStream) return;

        if (this._audioStream) {
            // Unbind old listeners
            if (this._volNotifyId) this._audioStream.disconnect(this._volNotifyId);
            if (this._muteNotifyId) this._audioStream.disconnect(this._muteNotifyId);
            if (this._portNotifyId) this._audioStream.disconnect(this._portNotifyId);
            this._portNotifyId = 0;
        }

        this._audioStream = sink;

        if (this._audioStream) {
            this._volNotifyId = this._audioStream.connect('notify::volume', () => {
                this._readVolume();
            });
            this._muteNotifyId = this._audioStream.connect('notify::is-muted', () => {
                this._readVolume();
            });
            this._portNotifyId = this._audioStream.connect('notify::port', () => this._checkOutput());
            this._readVolume();
            this._checkOutput();
        }
    }

    // Describe the current output and report a change of device/port.
    _checkOutput() {
        let sink = this._audioStream;
        if (!sink)
            return;
        let name = '', port = '', form = '', bluetooth = false;
        try {
            name = sink.get_description() ?? '';
            form = sink.get_form_factor?.() ?? '';
            bluetooth = (sink.get_name() ?? '').startsWith('bluez');
            let p = sink.get_port?.();
            port = p?.port ?? '';
            if (p?.human_port && !bluetooth)
                name = p.human_port;
        } catch (e) {}
        let key = `${sink.get_id?.()}|${port}`;
        let first = this._outputKey === null;
        if (key === this._outputKey)
            return;
        this._outputKey = key;
        if (first)
            return;
        let headphones = bluetooth || /head(phone|set)|handsfree|hands-free|earpiece/i.test(`${form} ${port}`);
        try {
            this.onOutputChanged?.({ name, port, bluetooth, headphones });
        } catch (e) {
            console.error('NotchNux: output change handler failed', e);
        }
    }

    _readVolume() {
        if (!this._audioStream || !this._mixerControl) return;

        let vol = this._audioStream.get_volume();
        let max = this._mixerControl.get_vol_max_norm();
        this.volume = Math.round((vol / max) * 100);
        this.isMuted = this._audioStream.is_muted;

        if (this.onVolumeChanged) {
            this.onVolumeChanged(this.volume, this.isMuted);
        }
    }

    setVolume(value) {
        if (!this._audioStream || !this._mixerControl) return;

        let max = this._mixerControl.get_vol_max_norm();
        let vol = Math.min(Math.max((value / 100) * max, 0), max);
        
        this._audioStream.set_volume(vol);
        this._audioStream.push_volume();
    }

    setMuted(muted) {
        if (!this._audioStream) return;
        this._audioStream.change_is_muted(muted);
    }

    // --- Brightness Control ---
    // Prefer the Shell's own brightnessManager (GS 47+); fall back to the
    // classic org.gnome.SettingsDaemon.Power Screen proxy for older shells or
    // when brightnessManager exposes no usable value. Returns null when no
    // backend reports a brightness (so callers can hide the tile cleanly
    // instead of rendering "NaN%").
    getBrightness() {
        try {
            if (Main.brightnessManager && typeof Main.brightnessManager.globalScale === 'number') {
                let scale = Main.brightnessManager.globalScale;
                if (!Number.isNaN(scale)) return Math.round(scale * 100);
            }
        } catch (e) {
            console.error('NotchNux: Error getting brightness from brightnessManager', e);
        }
        // Read the real backlight level from sysfs (world-readable), so the
        // knob reflects changes made via logind on shells without a gsd Screen
        // proxy. This is authoritative when it works.
        try {
            let dev = this._backlightDevice();
            if (dev) {
                let [ok, contents] = Gio.File.new_for_path(
                    `/sys/class/backlight/${dev.name}/brightness`).load_contents(null);
                if (ok) {
                    let raw = Number(ByteArrayToString(contents).trim());
                    if (Number.isFinite(raw) && dev.max > 0)
                        return Math.round((raw / dev.max) * 100);
                }
            }
        } catch (e) {
            // fall through
        }
        // Fallback: gsd Power brightness proxy (0..100, -1 when unsupported).
        let b = this._getGsdBrightness();
        if (b !== null) return b;
        return null;
    }

    // gnome-settings-daemon's Power.Screen Brightness (pre-GS 47 shells). Read
    // asynchronously and cached; GNOME 49+ has no such interface, so after the
    // first failure we stop asking.
    _getGsdBrightness() {
        if (!this._gsdBrightnessGone && !this._gsdBrightnessBusy) {
            this._gsdBrightnessBusy = true;
            Gio.DBus.session.call('org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NO_AUTO_START, 1000, this._cancellable,
                (c, res) => {
                    this._gsdBrightnessBusy = false;
                    try {
                        let v = c.call_finish(res).recursiveUnpack()[0];
                        this._gsdBrightness = typeof v === 'number' && v >= 0 ? Math.round(v) : null;
                    } catch (e) {
                        this._gsdBrightnessGone = true;
                    }
                });
        }
        return this._gsdBrightness ?? null;
    }

    // --- Airplane mode --- (via gnome-settings-daemon Rfkill, the same
    // interface GNOME's own quick toggle drives; flips all radios at once).
    // Read asynchronously and cached; the old synchronous proxy wrapper
    // blocked the shell on gnome-settings-daemon during Tray renders.
    getAirplaneMode() {
        if (!this._rfkillBusy) {
            this._rfkillBusy = true;
            Gio.DBus.session.call('org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.gnome.SettingsDaemon.Rfkill', 'AirplaneMode']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable,
                (c, res) => {
                    this._rfkillBusy = false;
                    try { this._airplane = c.call_finish(res).recursiveUnpack()[0] === true; } catch (e) {}
                });
        }
        return this._airplane === true;
    }

    setAirplaneMode(on, cb = null) {
        this._airplane = !!on;
        Gio.DBus.session.call('org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Rfkill', 'AirplaneMode', new GLib.Variant('b', !!on)]),
            null, Gio.DBusCallFlags.NONE, 5000, this._cancellable,
            (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    console.warn('NotchNux: airplane-mode control unavailable', e.message);
                }
                cb?.();
            });
    }

    // --- WiFi / Hotspot (NetworkManager) ---

    _emitWifiChanged() {
        try { if (this.onWifiChanged) this.onWifiChanged(); }
        catch (e) { /* ignore */ }
    }

    // The first managed WiFi device, or null if there's no WiFi hardware / NM
    // isn't up yet. Cached lookups are cheap; NM keeps the device list live.
    _wifiDevice() {
        if (!this._nmClient) return null;
        try {
            let devices = this._nmClient.get_devices();
            for (let d of devices) {
                if (d.get_device_type() === NM.DeviceType.WIFI)
                    return d;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Snapshot of WiFi state for the Tray row:
    //   { available, enabled, connected, ssid, signal, hotspot }
    // `available` is false when there's no WiFi hardware or NM is unavailable —
    // callers should hide the row in that case.
    getWifiInfo() {
        let info = { available: false, enabled: false, connected: false,
            ssid: null, signal: 0, hotspot: false };
        if (!this._nmClient) return info;
        let dev = this._wifiDevice();
        if (!dev) return info;
        info.available = true;
        try {
            info.enabled = this._nmClient.wireless_get_enabled();
        } catch (e) { /* ignore */ }
        if (!info.enabled) return info;

        try {
            // Access-point mode = an active hotspot on this device. The 802.11
            // mode enum name starts with a digit, so it's reached by bracket
            // access in GJS; NM_802_11_MODE_AP === 3.
            const AP_MODE = NM['80211Mode'] ? NM['80211Mode'].AP : 3;
            if (dev.get_mode && dev.get_mode() === AP_MODE)
                info.hotspot = true;
        } catch (e) { /* ignore */ }

        try {
            let ap = dev.get_active_access_point();
            if (ap) {
                let ssidVariant = ap.get_ssid();
                if (ssidVariant)
                    info.ssid = NM.utils_ssid_to_utf8(ssidVariant.get_data());
                info.signal = ap.get_strength(); // 0..100
                info.connected = !info.hotspot;
            }
        } catch (e) { /* ignore */ }
        return info;
    }

    // Describe the currently-connected AP's channel for hotspot placement:
    //   { band, channel, apCapable }  or  null when not connected.
    // Single-radio chips can only run AP + client on ONE shared channel, and in
    // practice only 2.4 GHz channels can host an AP (5 GHz/DFS channels like 149
    // /153 reject AP mode). So `apCapable` is true only on 2.4 GHz — the caller
    // pins the hotspot to the active channel then, and otherwise knows the
    // client will have to drop.
    _getActiveWifiChannel() {
        try {
            let dev = this._wifiDevice();
            if (!dev || !dev.get_active_access_point) return null;
            let ap = dev.get_active_access_point();
            if (!ap || !ap.get_frequency) return null;
            let freq = ap.get_frequency(); // MHz
            if (!freq) return null;
            if (freq >= 2412 && freq <= 2484) {
                let ch = freq === 2484 ? 14 : (freq - 2407) / 5;
                return { band: 'bg', channel: Math.round(ch), apCapable: true };
            }
            if (freq >= 5000 && freq < 5900) {
                return { band: 'a', channel: Math.round((freq - 5000) / 5), apCapable: false };
            }
            return { band: null, channel: 0, apCapable: false };
        } catch (e) { return null; }
    }

    // Turn WiFi radio on/off. No-op if NM isn't available.
    setWifiEnabled(on) {
        if (!this._nmClient) return;
        try {
            this._nmClient.wireless_set_enabled(!!on);
        } catch (e) {
            console.warn('NotchNux: WiFi toggle failed', e.message);
        }
    }

    // Toggle a WiFi hotspot (AP mode). When enabling, reuse an existing
    // connection whose id/type marks it a hotspot; otherwise create a WPA2 AP
    // connection with a generated SSID + password. When disabling, deactivate
    // whatever AP-mode connection is active on the WiFi device.
    // `cb(ok, detail)` is invoked on completion; `detail` carries {ssid,password}
    // for a freshly created hotspot so the UI can surface the credentials.
    setHotspotEnabled(on, cb) {
        let done = (ok, detail) => { if (cb) cb(ok, detail ?? null); };
        if (!this._nmClient) { done(false); return; }
        let dev = this._wifiDevice();
        if (!dev) { done(false); return; }

        if (!on) {
            // Deactivate the active connection if it's our AP.
            try {
                let active = dev.get_active_connection();
                if (active)
                    this._nmClient.deactivate_connection_async(active, null, (c, res) => {
                        try { c.deactivate_connection_finish(res); done(true); }
                        catch (e) { console.warn('NotchNux: hotspot off failed', e.message); done(false); }
                    });
                else
                    done(true);
            } catch (e) { console.warn('NotchNux: hotspot off failed', e.message); done(false); }
            return;
        }

        // Enabling: WiFi must be on for AP mode to come up.
        this.setWifiEnabled(true);

        // Look for an existing hotspot connection to reuse.
        let existing = null;
        try {
            for (let c of this._nmClient.get_connections()) {
                let s = c.get_setting_wireless();
                if (s && s.get_mode && s.get_mode() === 'ap') { existing = c; break; }
                // Fall back to matching by id for connections created elsewhere.
                if (!existing && /hotspot/i.test(c.get_id())) existing = c;
            }
        } catch (e) { /* ignore */ }

        // Decide where to put the AP. If connected on an AP-capable channel
        // (2.4 GHz), pin the hotspot there so it runs concurrently with the
        // client. Otherwise (5 GHz/DFS, e.g. ch149/153) the AP can't share that
        // channel, so put it on 2.4 GHz ch1 — the AP starts, but a 5 GHz-only
        // single-radio client will drop. `concurrent` tells the UI which case.
        let chan = this._getActiveWifiChannel();
        let apPin, concurrent;
        if (chan && chan.apCapable) {
            apPin = { band: chan.band, channel: chan.channel };
            concurrent = true;
        } else if (chan) {
            apPin = { band: 'bg', channel: 1 };
            concurrent = false;         // was connected, but on a non-AP channel
        } else {
            apPin = null;               // not connected — let NM pick
            concurrent = true;
        }

        if (existing) {
            let activateExisting = () => {
                this._nmClient.activate_connection_async(existing, dev, null, null, (c, res) => {
                    try { c.activate_connection_finish(res); done(true, { concurrent }); }
                    catch (e) { console.warn('NotchNux: hotspot activate failed', e.message); done(false); }
                });
            };
            try {
                let s = existing.get_setting_wireless();
                if (s) {
                    if (apPin) {
                        s.set_property('band', apPin.band);
                        s.set_property('channel', apPin.channel);
                    } else {
                        s.set_property('band', null);
                        s.set_property('channel', 0);
                    }
                    existing.commit_changes_async(true, null, (c, res) => {
                        try { c.commit_changes_finish(res); } catch (e) { /* activate anyway */ }
                        activateExisting();
                    });
                    return;
                }
            } catch (e) { /* fall through to plain activate */ }
            activateExisting();
            return;
        }

        // No existing hotspot — build a fresh WPA2 AP connection pinned as above.
        let ssid = GLib.get_host_name() || 'NotchNux';
        let password = this._genHotspotPassword();
        let connection = this._buildHotspotConnection(ssid, password, apPin);
        if (!connection) { done(false); return; }
        this._nmClient.add_and_activate_connection_async(connection, dev, null, null, (c, res) => {
            try {
                c.add_and_activate_connection_finish(res);
                done(true, { ssid, password, concurrent });
            } catch (e) {
                console.warn('NotchNux: hotspot create failed', e.message);
                done(false);
            }
        });
    }

    // Build an NM.SimpleConnection for a WPA2-PSK access point. When `chan`
    // ({band, channel}) is given, the AP is pinned to that band+channel so the
    // adapter can run it concurrently with an active client on the same channel.
    _buildHotspotConnection(ssid, password, chan) {
        try {
            let connection = new NM.SimpleConnection();

            let sCon = new NM.SettingConnection({
                id: 'Hotspot',
                type: '802-11-wireless',
                autoconnect: false,
                uuid: NM.utils_uuid_generate(),
            });
            connection.add_setting(sCon);

            let wifiProps = { mode: 'ap' };
            if (chan && chan.band && chan.channel) {
                wifiProps.band = chan.band;      // 'bg' (2.4GHz) or 'a' (5GHz)
                wifiProps.channel = chan.channel;
            }
            let sWifi = new NM.SettingWireless(wifiProps);
            sWifi.set_property('ssid',
                new GLib.Bytes(new TextEncoder().encode(ssid)));
            connection.add_setting(sWifi);

            let sWsec = new NM.SettingWirelessSecurity({
                key_mgmt: 'wpa-psk',
                psk: password,
            });
            connection.add_setting(sWsec);

            // Share the connection so clients get IPs/NAT (like GNOME's hotspot).
            connection.add_setting(new NM.SettingIP4Config({ method: 'shared' }));
            connection.add_setting(new NM.SettingIP6Config({ method: 'ignore' }));
            return connection;
        } catch (e) {
            console.warn('NotchNux: could not build hotspot connection', e.message);
            return null;
        }
    }

    // 12-char password from the kernel CSPRNG (Math.random is not one). The
    // 32-symbol alphabet skips look-alikes (0/O, 1/l) and divides 256 evenly,
    // so `byte & 31` is unbiased: 12 × 5 bits = 60 bits of entropy.
    _genHotspotPassword() {
        const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
        let stream = Gio.File.new_for_path('/dev/urandom').read(null);
        let bytes = stream.read_bytes(12, null).toArray();
        stream.close(null);
        return Array.from(bytes, b => chars[b & 31]).join('');
    }

    // --- WiFi networks (saved list, scan, connect) ---

    // Saved WiFi connections as { uuid, ssid, connected }, skipping AP-mode
    // (hotspot) profiles. `connected` marks the one whose SSID matches the
    // active AP so the UI can badge it. Used to populate the WiFi card list.
    getSavedWifiConnections() {
        let out = [];
        if (!this._nmClient) return out;
        let activeSsid = null;
        try { activeSsid = this.getWifiInfo().ssid; } catch (e) { /* ignore */ }
        try {
            for (let c of this._nmClient.get_connections()) {
                let sWifi = c.get_setting_wireless && c.get_setting_wireless();
                if (!sWifi) continue;
                // Skip hotspot/AP profiles — those are surfaced via the hotspot button.
                if (sWifi.get_mode && sWifi.get_mode() === 'ap') continue;
                let ssid = null;
                try {
                    let raw = sWifi.get_ssid();
                    if (raw) ssid = NM.utils_ssid_to_utf8(raw.get_data());
                } catch (e) { /* ignore */ }
                if (!ssid) ssid = c.get_id();
                out.push({ uuid: c.get_uuid(), ssid,
                    connected: !!activeSsid && ssid === activeSsid });
            }
        } catch (e) { /* ignore */ }
        // Connected first, then alphabetical.
        out.sort((a, b) => {
            if (a.connected !== b.connected) return a.connected ? -1 : 1;
            return a.ssid.localeCompare(b.ssid);
        });
        return out;
    }

    // Ask the WiFi device to rescan for access points. `cb()` fires when the
    // request returns (success or failure); the caller then re-reads
    // getWifiAccessPoints() — NM populates the AP list asynchronously, so a
    // short delay before reading usually yields a fuller list.
    requestWifiScan(cb) {
        let done = () => { if (cb) cb(); };
        let dev = this._wifiDevice();
        if (!dev || !dev.request_scan_async) { done(); return; }
        try {
            dev.request_scan_async(null, (d, res) => {
                try { d.request_scan_finish(res); } catch (e) { /* rate-limited etc. */ }
                done();
            });
        } catch (e) { done(); }
    }

    // Visible access points as { ssid, signal, secure, active }, deduped by SSID
    // (strongest kept), sorted strongest first. `secure` is true when the AP
    // advertises any WPA/RSN/privacy flags. `active` marks the connected AP.
    getWifiAccessPoints() {
        let dev = this._wifiDevice();
        if (!dev || !dev.get_access_points) return [];
        let activeAp = null;
        try { activeAp = dev.get_active_access_point(); } catch (e) { /* ignore */ }
        let byName = new Map();
        try {
            for (let ap of dev.get_access_points()) {
                let ssid = null;
                try {
                    let raw = ap.get_ssid();
                    if (raw) ssid = NM.utils_ssid_to_utf8(raw.get_data());
                } catch (e) { /* ignore */ }
                if (!ssid) continue; // hidden SSID — nothing to show/connect by name
                let signal = ap.get_strength();
                let secure = false;
                try {
                    const NONE = NM['80211ApSecurityFlags']
                        ? NM['80211ApSecurityFlags'].NONE : 0;
                    let wpa = ap.get_wpa_flags();
                    let rsn = ap.get_rsn_flags();
                    secure = (wpa !== NONE) || (rsn !== NONE);
                } catch (e) { /* ignore */ }
                let active = !!(activeAp && ap.get_path && activeAp.get_path
                    && ap.get_path() === activeAp.get_path());
                let existing = byName.get(ssid);
                // Keep the strongest AP for the SSID, but the "active" flag must
                // survive across duplicates regardless of which is strongest —
                // the connected AP is often not the loudest broadcaster.
                if (!existing || signal > existing.signal) {
                    byName.set(ssid, { ssid, signal, secure, active: active || (existing ? existing.active : false) });
                } else if (active) {
                    existing.active = true;
                }
            }
        } catch (e) { /* ignore */ }
        return [...byName.values()].sort((a, b) => b.signal - a.signal);
    }

    // True when an AP for `ssid` is present in the latest scan results.
    _wifiSsidInRange(ssid) {
        if (!ssid) return false;
        return this.getWifiAccessPoints().some(ap => ap.ssid === ssid);
    }

    // Resolve `cb(inRange)` for `ssid`. Checks the current AP list first; if the
    // SSID isn't there, triggers a rescan and re-checks after a short settle
    // delay before giving up, so a stale list doesn't yield a false negative.
    _ensureWifiSsidInRange(ssid, cb) {
        if (!ssid) { cb(false); return; }
        if (this._wifiSsidInRange(ssid)) { cb(true); return; }
        this.requestWifiScan(() => {
            // NM populates the AP list asynchronously after the scan returns;
            // wait briefly so get_access_points() reflects the fresh results.
            this._later(1500, () => cb(this._wifiSsidInRange(ssid)));
        });
    }

    // Activate an already-saved WiFi connection by UUID. `cb(ok, err)` on
    // completion. Refuses if the saved profile's SSID is not currently in range.
    activateSavedWifi(uuid, cb) {
        let done = (ok, err) => { if (cb) cb(!!ok, err ?? null); };
        if (!this._nmClient || !uuid) { done(false, 'no connection'); return; }
        let dev = this._wifiDevice();
        if (!dev) { done(false, 'no wifi device'); return; }
        let conn = null;
        try { conn = this._nmClient.get_connection_by_uuid(uuid); } catch (e) { /* ignore */ }
        if (!conn) { done(false, 'no connection'); return; }
        // Gate on the profile's SSID still being visible (rescan if stale).
        let ssid = null;
        try {
            let sWifi = conn.get_setting_wireless && conn.get_setting_wireless();
            let raw = sWifi && sWifi.get_ssid && sWifi.get_ssid();
            if (raw) ssid = NM.utils_ssid_to_utf8(raw.get_data());
        } catch (e) { /* ignore */ }
        let activate = () => {
            try {
                this._nmClient.activate_connection_async(conn, dev, null, null, (c, res) => {
                    try { c.activate_connection_finish(res); done(true); }
                    catch (e) { console.warn('NotchNux: WiFi activate failed', e.message); done(false, e.message); }
                });
            } catch (e) { console.warn('NotchNux: WiFi activate failed', e.message); done(false, e.message); }
        };
        if (!ssid) { activate(); return; } // no SSID to gate on — proceed
        this._ensureWifiSsidInRange(ssid, (inRange) => {
            if (!inRange) { done(false, 'not in range'); return; }
            activate();
        });
    }

    // Connect to a WiFi network by SSID, creating a new profile. When `password`
    // is a non-empty string a WPA-PSK secured connection is built; otherwise an
    // open connection. If a saved profile for the SSID already exists it's
    // activated instead of duplicated. `cb(ok, err)` on completion.
    connectWifi(ssid, password, cb) {
        let done = (ok, err) => { if (cb) cb(!!ok, err ?? null); };
        if (!this._nmClient || !ssid) { done(false, 'no ssid'); return; }
        let dev = this._wifiDevice();
        if (!dev) { done(false, 'no wifi device'); return; }
        // Refuse to activate/create a profile for an SSID that isn't currently
        // broadcasting — NM would otherwise sit indefinitely trying to associate.
        // Rescan once if the current AP list is stale before giving up.
        this._ensureWifiSsidInRange(ssid, (inRange) => {
            if (!inRange) { done(false, 'not in range'); return; }
            this._connectWifiInRange(ssid, password, dev, done);
        });
    }

    // Second half of connectWifi, entered once the SSID is confirmed in range:
    // reuse a saved profile for the SSID if one exists, else build a new one.
    // Range has already been verified, so the saved-profile branch activates
    // directly rather than re-entering activateSavedWifi (avoids a second scan).
    _connectWifiInRange(ssid, password, dev, done) {
        // Reuse a saved profile for this SSID rather than piling up duplicates.
        try {
            for (let c of this._nmClient.get_connections()) {
                let sWifi = c.get_setting_wireless && c.get_setting_wireless();
                if (!sWifi || (sWifi.get_mode && sWifi.get_mode() === 'ap')) continue;
                let name = null;
                try {
                    let raw = sWifi.get_ssid();
                    if (raw) name = NM.utils_ssid_to_utf8(raw.get_data());
                } catch (e) { /* ignore */ }
                if (name === ssid) {
                    try {
                        this._nmClient.activate_connection_async(c, dev, null, null, (cl, res) => {
                            try { cl.activate_connection_finish(res); done(true); }
                            catch (e) { console.warn('NotchNux: WiFi activate failed', e.message); done(false, e.message); }
                        });
                    } catch (e) { console.warn('NotchNux: WiFi activate failed', e.message); done(false, e.message); }
                    return;
                }
            }
        } catch (e) { /* fall through to create */ }

        let connection;
        try {
            connection = new NM.SimpleConnection();
            connection.add_setting(new NM.SettingConnection({
                id: ssid,
                type: '802-11-wireless',
                uuid: NM.utils_uuid_generate(),
            }));
            let sWifi = new NM.SettingWireless({ mode: 'infrastructure' });
            sWifi.set_property('ssid',
                new GLib.Bytes(new TextEncoder().encode(ssid)));
            connection.add_setting(sWifi);
            if (typeof password === 'string' && password.length > 0) {
                connection.add_setting(new NM.SettingWirelessSecurity({
                    key_mgmt: 'wpa-psk',
                    psk: password,
                }));
            }
        } catch (e) {
            console.warn('NotchNux: could not build WiFi connection', e.message);
            done(false, e.message); return;
        }
        try {
            this._nmClient.add_and_activate_connection_async(connection, dev, null, null, (c, res) => {
                try { c.add_and_activate_connection_finish(res); done(true); }
                catch (e) { console.warn('NotchNux: WiFi connect failed', e.message); done(false, e.message); }
            });
        } catch (e) { console.warn('NotchNux: WiFi connect failed', e.message); done(false, e.message); }
    }

    setBrightness(value) {
        let clamped = Math.min(Math.max(Math.round(value), 0), 100);
        // Preferred path: the Shell brightnessManager (writable on some shells).
        if (!this._brightnessWriteUnsupported) {
            try {
                if (Main.brightnessManager) {
                    Main.brightnessManager.globalScale = clamped / 100;
                    return;
                }
            } catch (e) {
                this._brightnessWriteUnsupported = true;
                console.warn('NotchNux: brightnessManager write unavailable; using logind', e.message);
            }
        }
        // Fallback: systemd-logind Session.SetBrightness. Unlike the gsd Power
        // "Screen" proxy (absent on GNOME 49+), logind lets the active session
        // set the backlight unprivileged. It wants an absolute raw value, so we
        // scale the percent against the device's max_brightness from sysfs.
        try {
            let dev = this._backlightDevice();
            if (!dev) return;
            let raw = Math.round((clamped / 100) * dev.max);
            this._withLogindSession(sessionPath => Gio.DBus.system.call(
                'org.freedesktop.login1',
                sessionPath,
                'org.freedesktop.login1.Session',
                'SetBrightness',
                new GLib.Variant('(ssu)', ['backlight', dev.name, raw]),
                null, Gio.DBusCallFlags.NONE, 1000, null,
                (conn, res) => {
                    try { conn.call_finish(res); }
                    catch (e) { console.warn('NotchNux: logind SetBrightness failed', e.message); }
                }));
        } catch (e) {
            console.warn('NotchNux: brightness control unavailable on this shell', e.message);
        }
    }

    // Locate a backlight device under /sys/class/backlight (first one found)
    // and cache its name + max_brightness. Returns null when none exists.
    _backlightDevice() {
        if (this._backlight !== undefined) return this._backlight;
        this._backlight = null;
        try {
            let dir = Gio.File.new_for_path('/sys/class/backlight');
            let en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                let name = info.get_name();
                try {
                    let [ok, contents] = Gio.File.new_for_path(
                        `/sys/class/backlight/${name}/max_brightness`).load_contents(null);
                    if (ok) {
                        let max = Number(ByteArrayToString(contents).trim());
                        if (max > 0) { this._backlight = { name, max }; break; }
                    }
                } catch (e) { /* try next */ }
            }
        } catch (e) {
            console.warn('NotchNux: no backlight device found', e.message);
        }
        return this._backlight;
    }

    // Resolve the graphical logind session object path asynchronously, then
    // run `cb(path)` (cached after the first success). First try the caller's
    // own session (works inside gnome-shell); if that fails fall back to this
    // user's "Display" session, which doesn't depend on the caller's PID.
    _withLogindSession(cb) {
        if (this._logindPath) {
            cb(this._logindPath);
            return;
        }
        let call = (path, iface, method, params, type, next) => Gio.DBus.system.call(
            'org.freedesktop.login1', path, iface, method, params, new GLib.VariantType(type),
            Gio.DBusCallFlags.NONE, 1000, this._cancellable, (c, res) => {
                let reply = null;
                try { reply = c.call_finish(res); } catch (e) {}
                next(reply);
            });
        let done = path => {
            if (!path) {
                console.warn('NotchNux: could not resolve logind session');
                return;
            }
            this._logindPath = path;
            cb(path);
        };
        call('/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'GetSessionByPID',
            new GLib.Variant('(u)', [0]), '(o)', reply => {
                if (reply) {
                    done(reply.deepUnpack()[0]);
                    return;
                }
                call('/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'GetUser',
                    new GLib.Variant('(u)', [this._selfUid()]), '(o)', userReply => {
                        if (!userReply) { done(null); return; }
                        call(userReply.deepUnpack()[0], 'org.freedesktop.DBus.Properties', 'Get',
                            new GLib.Variant('(ss)', ['org.freedesktop.login1.User', 'Display']), '(v)',
                            disp => {
                                // Display is a variant of (so): (session_id, object_path).
                                done(disp ? disp.deepUnpack()[0].deepUnpack()[1] : null);
                            });
                    });
            });
    }

    // Best-effort uid lookup (gjs lacks a direct getuid binding). We read it
    // from the process's own /proc status, which is always our own uid.
    _selfUid() {
        try {
            let [ok, contents] = Gio.File.new_for_path('/proc/self/status').load_contents(null);
            if (ok) {
                let m = ByteArrayToString(contents).match(/^Uid:\s*(\d+)/m);
                if (m) return Number(m[1]);
            }
        } catch (e) { /* ignore */ }
        return 1000;
    }

    // --- Connected Devices (Bluetooth & Battery) ---
    getBluetoothDevices(onUpdate) {
        let byKey = new Map();
        // Track which map key a given device name already lives under, so a
        // second source reporting the same device (BlueZ keys by address,
        // UPower has no address and keys by name) merges into one row instead
        // of producing a duplicate.
        let nameToKey = new Map();
        let addDevice = (device) => {
            let nameKey = (device.name || '').toLowerCase();
            let key = (device.address || device.name || '').toLowerCase();
            if (!key) key = `${device.type}:${byKey.size}`;
            // If we've already seen this name under a different key (e.g. an
            // address key from BlueZ), fold this record into that entry.
            if (!byKey.has(key) && nameKey && nameToKey.has(nameKey))
                key = nameToKey.get(nameKey);
            let existing = byKey.get(key);
            if (existing) {
                byKey.set(key, {
                    ...existing,
                    ...device,
                    // Prefer whichever source actually reported a battery level.
                    percentage: Number.isFinite(device.percentage) ? device.percentage : existing.percentage
                });
            } else {
                byKey.set(key, device);
            }
            if (nameKey) nameToKey.set(nameKey, key);
        };

        try {
            let bluezDevices = this._getBluezDevices(onUpdate);
            for (let d of bluezDevices)
                addDevice(d);
        } catch (e) {
            console.error('NotchNux: Error listing BlueZ devices', e);
        }

        // Wireless accessories UPower knows a battery for (mice, keyboards,
        // headsets…), from an async snapshot — see _refreshUpowerAccessories.
        this._refreshUpowerAccessories(onUpdate);
        for (let acc of this._upowerAccessories)
            addDevice({ ...acc });
        return [...byKey.values()].sort((a, b) => {
            if (a.connected !== b.connected) return a.connected ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    }

    // UPower accessories (anything with its own battery that isn't the
    // laptop's power supply) as plain data, read over D-Bus asynchronously.
    // libupower's get_devices2() hands GJS objects it later frees underneath
    // us, and is a synchronous call besides.
    _refreshUpowerAccessories(onUpdate = null) {
        if (this._upowerBusy) return;
        this._upowerBusy = true;
        const UP = 'org.freedesktop.UPower';
        let finish = list => {
            this._upowerBusy = false;
            let sig = l => l.map(d => `${d.name}:${d.percentage}`).sort().join('|');
            let changed = sig(list) !== sig(this._upowerAccessories);
            this._upowerAccessories = list;
            if (changed && onUpdate) onUpdate();
        };
        Gio.DBus.system.call(UP, '/org/freedesktop/UPower', UP, 'EnumerateDevices', null,
            new GLib.VariantType('(ao)'), Gio.DBusCallFlags.NONE, 2000, this._cancellable, (c, res) => {
                let paths;
                try {
                    [paths] = c.call_finish(res).deepUnpack();
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._upowerBusy = false;
                    return;
                }
                let out = [];
                let pending = paths.length;
                if (pending === 0) { finish(out); return; }
                for (let path of paths) {
                    Gio.DBus.system.call(UP, path, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', [`${UP}.Device`]), new GLib.VariantType('(a{sv})'),
                        Gio.DBusCallFlags.NONE, 2000, this._cancellable, (c2, r2) => {
                            try {
                                let [p] = c2.call_finish(r2).recursiveUnpack();
                                let acc = this._upowerAccessory(p);
                                if (acc) out.push(acc);
                            } catch (e) {
                                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                    return;
                            }
                            if (--pending === 0) finish(out);
                        });
                }
            });
    }

    // UPower Device properties -> accessory row, or null for the laptop's own
    // supply / mains / devices without a battery reading. Type values follow
    // UpDeviceKind (5 mouse, 6 keyboard, 8 phone, 10 tablet, 12 gamepad,
    // 13 pen, 14 touchpad, 17 headset, 18 speakers, 19 headphones, 21 audio).
    _upowerAccessory(p) {
        if (p.PowerSupply === true || p.Type === 1 || p.IsPresent === false)
            return null;
        const KINDS = {
            2: ['Battery', 'battery-symbolic'],
            5: ['Mouse', 'input-mouse-symbolic'],
            6: ['Keyboard', 'input-keyboard-symbolic'],
            8: ['Phone', 'phone-symbolic'],
            10: ['Tablet', 'input-tablet-symbolic'],
            12: ['Controller', 'input-gaming-symbolic'],
            13: ['Pen', 'input-tablet-symbolic'],
            14: ['Touchpad', 'input-touchpad-symbolic'],
            17: ['Audio Device', 'audio-headset-symbolic'],
            18: ['Audio Device', 'audio-speakers-symbolic'],
            19: ['Audio Device', 'audio-headphones-symbolic'],
            21: ['Audio Device', 'audio-headset-symbolic'],
        };
        let kind = KINDS[p.Type];
        if (!kind || !Number.isFinite(p.Percentage))
            return null;
        return {
            name: p.Model || kind[0],
            type: kind[0],
            percentage: Math.round(p.Percentage),
            icon: kind[1],
        };
    }

    // Serve the last snapshot and refresh it in the background: a synchronous
    // GetManagedObjects against a busy bluetoothd can stall the shell for
    // hundreds of ms. The first call returns [] and `onUpdate` (optional) fires
    // when the refresh lands a changed snapshot, so the caller can re-render.
    _getBluezDevices(onUpdate) {
        this._refreshBluez(onUpdate ? changed => { if (changed) onUpdate(); } : null);
        return this._bluezCache ?? [];
    }

    // One async GetManagedObjects feeds every Bluetooth view: the paired /
    // connected list, the scan overlay, the adapter path and its power state.
    _refreshBluez(onUpdate = null) {
        if (onUpdate)
            (this._bluezWaiters ??= new Set()).add(onUpdate);
        if (this._bluezRefreshing) return;
        this._bluezRefreshing = true;
        Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', null, null, Gio.DBusCallFlags.NONE, 2000, this._cancellable,
            (conn, res) => {
                this._bluezRefreshing = false;
                let waiters = this._bluezWaiters ?? new Set();
                this._bluezWaiters = null;
                let objects;
                try {
                    [objects] = conn.call_finish(res).recursiveUnpack();
                } catch (e) {
                    // BlueZ unavailable or timed out; keep the last snapshot.
                    this._btAdapterPath ??= null;
                    for (let cb of waiters) cb(false);
                    return;
                }
                let adapter = Object.entries(objects).find(([, ifaces]) => ifaces['org.bluez.Adapter1']);
                let powered = adapter ? adapter[1]['org.bluez.Adapter1'].Powered === true : false;
                this._btAdapterPath = adapter ? adapter[0] : null;
                this._btDiscoveredCache = this._parseDiscovered(objects);
                let next = this._parseBluezObjects(objects);
                // Only report a change when the paired/connected snapshot or
                // the radio state actually moved, so an unchanged poll doesn't
                // rebuild the card out from under a scroll/hover.
                let changed = powered !== this._btPowered ||
                    this._bluezSignature(next) !== this._bluezSignature(this._bluezCache);
                this._btPowered = powered;
                this._bluezCache = next;
                for (let cb of waiters) cb(changed);
            });
    }

    // Compact fingerprint of a bluez snapshot: name + connected + battery per
    // device. Used to detect whether an async refresh changed anything.
    _bluezSignature(list) {
        if (!Array.isArray(list)) return '';
        return list.map(d => `${d.name}:${d.connected ? 1 : 0}:${d.percentage}`).sort().join('|');
    }

    _parseBluezObjects(objects) {
        let list = [];
        for (let [path, ifaces] of Object.entries(objects)) {
            let dev = ifaces['org.bluez.Device1'];
            if (!dev) continue;

            let connected = dev.Connected === true;
            let paired = dev.Paired === true;
            if (!connected && !paired) continue;

            let battery = ifaces['org.bluez.Battery1'];
            let icon = this._bluezIcon(dev.Icon, dev.UUIDs || []);
            list.push({
                name: dev.Alias || dev.Name || 'Bluetooth Device',
                type: this._bluezType(dev.Icon, dev.UUIDs || []),
                percentage: battery && Number.isFinite(battery.Percentage) ? Math.round(battery.Percentage) : null,
                icon,
                address: dev.Address || path,
                // BlueZ object path — needed to call Connect/Disconnect on the
                // org.bluez.Device1 interface for this device.
                dbusPath: path,
                connected
            });
        }
        return list;
    }

    // Connect or disconnect a paired Bluetooth device by its BlueZ object
    // path. Async: BlueZ Connect can take several seconds, so `onDone(ok, err)`
    // fires on the main loop when the call returns.
    setBluetoothConnected(dbusPath, connect, onDone) {
        if (!dbusPath) {
            if (onDone) onDone(false, 'no device path');
            return;
        }
        Gio.DBus.system.call(
            'org.bluez',
            dbusPath,
            'org.bluez.Device1',
            connect ? 'Connect' : 'Disconnect',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            15000,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                    if (onDone) onDone(true, null);
                } catch (e) {
                    console.error(`NotchNux: Bluetooth ${connect ? 'connect' : 'disconnect'} failed`, e);
                    if (onDone) onDone(false, e.message || String(e));
                }
            });
    }

    _bluezType(iconName, uuids) {
        let icon = iconName || '';
        let uuidText = uuids.join(' ').toLowerCase();
        if (icon.includes('audio') || uuidText.includes('110b') || uuidText.includes('110e') || uuidText.includes('1108'))
            return 'Audio Device';
        if (icon.includes('mouse')) return 'Mouse';
        if (icon.includes('keyboard')) return 'Keyboard';
        if (icon.includes('phone')) return 'Phone';
        if (icon.includes('tablet')) return 'Tablet';
        return 'Bluetooth Device';
    }

    _bluezIcon(iconName, uuids) {
        let type = this._bluezType(iconName, uuids);
        if (type === 'Audio Device') return 'audio-headset-symbolic';
        if (type === 'Mouse') return 'input-mouse-symbolic';
        if (type === 'Keyboard') return 'input-keyboard-symbolic';
        if (type === 'Phone') return 'phone-symbolic';
        if (type === 'Tablet') return 'input-tablet-symbolic';
        return 'bluetooth-active-symbolic';
    }

    // --- Bluetooth radio + discovery (BlueZ Adapter1) ---

    // Run `cb(adapterPath | null)` once the adapter path is known, fetching
    // the BlueZ snapshot asynchronously the first time.
    _withAdapter(cb) {
        if (this._btAdapterPath !== undefined && this._btAdapterPath !== null) {
            cb(this._btAdapterPath);
            return;
        }
        this._refreshBluez(() => cb(this._btAdapterPath ?? null));
    }

    // Whether the Bluetooth adapter is powered on, from the cached snapshot
    // (refreshed in the background); false until the first read lands.
    getBluetoothPowered() {
        this._refreshBluez();
        return this._btPowered === true;
    }

    // Power the Bluetooth adapter on/off (Adapter1.Powered). `cb(ok)` on return.
    setBluetoothRadio(on, cb) {
        let done = (ok) => { if (cb) cb(!!ok); };
        this._withAdapter(path => {
            if (!path) { done(false); return; }
            Gio.DBus.system.call(
                'org.bluez', path, 'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered',
                    new GLib.Variant('b', !!on)]),
                null, Gio.DBusCallFlags.NONE, 5000, this._cancellable,
                (conn, res) => {
                    try { conn.call_finish(res); this._btPowered = !!on; done(true); }
                    catch (e) { console.warn('NotchNux: BT power toggle failed', e.message); done(false); }
                });
        });
    }

    // Begin scanning for nearby devices (Adapter1.StartDiscovery). `cb(ok)`.
    startBluetoothDiscovery(cb) {
        let done = (ok) => { if (cb) cb(!!ok); };
        this._withAdapter(path => {
            if (!path) { done(false); return; }
            Gio.DBus.system.call(
                'org.bluez', path, 'org.bluez.Adapter1', 'StartDiscovery',
                null, null, Gio.DBusCallFlags.NONE, 5000, this._cancellable,
                (conn, res) => {
                    try { conn.call_finish(res); done(true); }
                    catch (e) {
                        // "InProgress" just means discovery was already running.
                        done(/InProgress/.test(e.message));
                    }
                });
        });
    }

    // Stop scanning (Adapter1.StopDiscovery). Best-effort; errors are ignored.
    // Not tied to our cancellable: it must still go out during teardown.
    stopBluetoothDiscovery() {
        let path = this._btAdapterPath;
        if (!path) return;
        Gio.DBus.system.call(
            'org.bluez', path, 'org.bluez.Adapter1', 'StopDiscovery',
            null, null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => { try { conn.call_finish(res); } catch (e) { /* ignore */ } });
    }

    // Snapshot of ALL nearby Device1 objects (unlike getBluetoothDevices, which
    // filters to paired/connected), refreshed in the background. Each entry:
    // { name, address, dbusPath, paired, connected, icon }.
    getDiscoveredBluetoothDevices() {
        this._refreshBluez();
        return this._btDiscoveredCache ?? [];
    }

    _parseDiscovered(objects) {
        let list = [];
        for (let [path, ifaces] of Object.entries(objects)) {
            let dev = ifaces['org.bluez.Device1'];
            if (!dev) continue;
            list.push({
                name: dev.Alias || dev.Name || dev.Address || 'Unknown device',
                address: dev.Address || path,
                dbusPath: path,
                paired: dev.Paired === true,
                connected: dev.Connected === true,
                icon: this._bluezIcon(dev.Icon, dev.UUIDs || []),
            });
        }
        // Named devices first (unnamed are usually noise), then A–Z.
        let unnamed = d => (/^([0-9A-F]{2}[:-]){5}/i.test(d.name) ? 1 : 0);
        list.sort((a, b) => unnamed(a) - unnamed(b) || a.name.localeCompare(b.name));
        return list;
    }

    // Pair (if needed) then connect a discovered device by BlueZ path.
    // No PIN/passkey agent is registered, so this completes for "Just Works"
    // devices (headsets, mice, most speakers) and fails for ones needing
    // interactive confirmation. `cb(ok, err)` on completion.
    pairBluetoothDevice(dbusPath, cb) {
        let done = (ok, err) => { if (cb) cb(!!ok, err ?? null); };
        if (!dbusPath) { done(false, 'no device path'); return; }
        let connect = () => {
            Gio.DBus.system.call(
                'org.bluez', dbusPath, 'org.bluez.Device1', 'Connect',
                null, null, Gio.DBusCallFlags.NONE, 20000, null,
                (conn, res) => {
                    try { conn.call_finish(res); done(true); }
                    catch (e) { console.warn('NotchNux: BT connect failed', e.message); done(false, e.message); }
                });
        };
        // Pair first; if already paired BlueZ returns AlreadyExists — treat that
        // as success and go straight to Connect.
        Gio.DBus.system.call(
            'org.bluez', dbusPath, 'org.bluez.Device1', 'Pair',
            null, null, Gio.DBusCallFlags.NONE, 30000, null,
            (conn, res) => {
                try { conn.call_finish(res); connect(); }
                catch (e) {
                    if (/AlreadyExists|Already Exists/.test(e.message)) { connect(); return; }
                    console.warn('NotchNux: BT pair failed', e.message);
                    done(false, e.message);
                }
            });
    }

    // --- Connected Drives (USB/Mounted Volumes) ---
    getMountedDrives() {
        let list = [];
        try {
            if (!this._volumeMonitor) return list;
            let mounts = this._volumeMonitor.get_mounts();
            for (let mount of mounts) {
                // Filter out system mounts (we only want actual user storage, e.g. /run/media/)
                let path = mount.get_root().get_path();
                if (!path || (!path.startsWith('/run/media/') && !path.startsWith('/media/'))) {
                    continue;
                }

                let name = mount.get_name() || 'External Volume';
                let freeBytes = 0;
                let totalBytes = 0;
                let freeStr = 'Unknown Space';

                try {
                    let file = Gio.File.new_for_path(path);
                    let info = file.query_filesystem_info('filesystem::free,filesystem::size', null);
                    if (info) {
                        freeBytes = info.get_attribute_uint64('filesystem::free');
                        totalBytes = info.get_attribute_uint64('filesystem::size');
                        
                        let freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
                        let totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(0);
                        freeStr = `${freeGB} GB free of ${totalGB} GB`;
                    }
                } catch (err) {
                    // Ignore info query errors
                }

                list.push({
                    name: name,
                    path: path,
                    space: freeStr,
                    mountObj: mount,
                    canEject: mount.can_eject()
                });
            }
        } catch (e) {
            console.error('NotchNux: Error listing mounted volumes', e);
        }
        return list;
    }

    ejectDrive(drive) {
        if (!drive.mountObj) return;
        try {
            drive.mountObj.eject_with_operation(Gio.MountUnmountFlags.NONE, null, null, (mount, res) => {
                try {
                    mount.eject_with_operation_finish(res);
                } catch (err) {
                    console.error('NotchNux: Failed to complete eject operation', err);
                }
            });
        } catch (e) {
            console.error('NotchNux: Error ejecting drive', e);
        }
    }
}

// Index of the byte sequence `seq` in `arr`, or -1.
function indexOfBytes(arr, seq) {
    let first = seq[0];
    for (let i = arr.indexOf(first); i >= 0 && i <= arr.length - seq.length; i = arr.indexOf(first, i + 1)) {
        let k = 1;
        while (k < seq.length && arr[i + k] === seq[k]) k++;
        if (k === seq.length) return i;
    }
    return -1;
}

// Helper to convert GBytes/ByteArray to Javascript string
function ByteArrayToString(byteArray) {
    if (byteArray instanceof Uint8Array) {
        return new TextDecoder().decode(byteArray);
    }
    // GJS legacy support
    return String.fromCharCode.apply(null, byteArray);
}
