import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import UPower from 'gi://UPowerGlib';
import Gvc from 'gi://Gvc';

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

        // Initialize UPower Client
        try {
            this._upowerClient = UPower.Client.new_full(null);
        } catch (e) {
            console.error('NotchNux: Failed to initialize UPower Client', e);
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

        // Mic/camera "in use" state, refreshed from PipeWire on the poll below.
        this._micInUse = false;
        this._camInUse = false;
        this.onPrivacyChanged = null;
        this._pwCancellable = null;

        try {
            this._initVolumeControl();
        } catch (e) {
            console.error('NotchNux: Failed to initialize Gvc volume control', e);
        }

        // Start background CPU + network + privacy polling (every 2.5 seconds)
        this._updateCpuUsage();
        this._updateNetUsage();
        this._updatePrivacyState();
        this._cpuTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._updateCpuUsage();
            this._updateNetUsage();
            this._updatePrivacyState();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._cpuTimeout) {
            GLib.Source.remove(this._cpuTimeout);
            this._cpuTimeout = null;
        }
        if (this._pwCancellable) {
            this._pwCancellable.cancel();
            this._pwCancellable = null;
        }
        if (this._mixerControl) {
            this._mixerControl.close();
            this._mixerControl = null;
        }
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

    // --- RAM Usage ---
    getRamUsage() {
        try {
            let file = Gio.File.new_for_path('/proc/meminfo');
            let [success, contents] = file.load_contents(null);
            if (!success) return 0;

            let lines = ByteArrayToString(contents).split('\n');
            let memTotal = 0;
            let memAvailable = 0;

            for (let line of lines) {
                if (line.startsWith('MemTotal:')) {
                    memTotal = Number(line.replace(/\D/g, ''));
                } else if (line.startsWith('MemAvailable:')) {
                    memAvailable = Number(line.replace(/\D/g, ''));
                }
            }

            if (memTotal > 0) {
                let used = memTotal - memAvailable;
                return Math.round((used / memTotal) * 100);
            }
        } catch (e) {
            console.error('NotchNux: Error updating RAM usage', e);
        }
        return 0;
    }

    // --- Swap Usage --- (percentage of swap in use; 0 when no swap configured)
    getSwapUsage() {
        try {
            let file = Gio.File.new_for_path('/proc/meminfo');
            let [success, contents] = file.load_contents(null);
            if (!success) return 0;
            let lines = ByteArrayToString(contents).split('\n');
            let swapTotal = 0, swapFree = 0;
            for (let line of lines) {
                if (line.startsWith('SwapTotal:')) swapTotal = Number(line.replace(/\D/g, ''));
                else if (line.startsWith('SwapFree:')) swapFree = Number(line.replace(/\D/g, ''));
            }
            if (swapTotal > 0)
                return Math.round(((swapTotal - swapFree) / swapTotal) * 100);
        } catch (e) {
            console.error('NotchNux: Error reading swap usage', e);
        }
        return 0;
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
            if (!this._upowerClient) return { percentage: 100, isCharging: false };
            let displayDevice = this._upowerClient.get_display_device();
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
        
        this._mixerControl.connect('state-changed', (control, state) => {
            if (state === Gvc.MixerControlState.READY) {
                this._updateAudioStream();
                this._updateSourceStream();
            }
        });

        this._mixerControl.connect('default-sink-changed', () => {
            this._updateAudioStream();
        });

        this._mixerControl.connect('default-source-changed', () => {
            this._updateSourceStream();
        });

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

    _updatePrivacyState() {
        // Cancel any in-flight dump so slow calls can't stack up on the poll.
        if (this._pwCancellable) this._pwCancellable.cancel();
        this._pwCancellable = new Gio.Cancellable();
        let cancellable = this._pwCancellable;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['pw-dump', '--no-colors'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            // pw-dump unavailable (no PipeWire): treat as never-in-use.
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            let out;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                return; // cancelled or failed; keep last known state
            }
            this._parsePrivacyDump(out);
        });
    }

    _parsePrivacyDump(jsonText) {
        let micInUse = false, camInUse = false;
        try {
            let nodes = JSON.parse(jsonText);
            for (let o of nodes) {
                if (o.type !== 'PipeWire:Interface:Node') continue;
                let info = o.info;
                if (!info) continue;
                let props = info.props || {};
                let mediaClass = props['media.class'] || '';
                let running = info.state === 'running';
                if (!running) continue;

                // A running audio/video capture stream, or a running source that
                // isn't our own monitoring, means the device is live.
                if (mediaClass.includes('Stream/Input/Audio') ||
                    mediaClass === 'Audio/Source')
                    micInUse = true;
                if (mediaClass.includes('Stream/Input/Video') ||
                    mediaClass === 'Video/Source')
                    camInUse = true;
            }
        } catch (e) {
            return; // malformed output; keep last known state
        }

        // Many apps open the webcam straight through V4L2 (/dev/video*) without
        // ever creating a PipeWire video node, so PipeWire alone under-reports
        // the camera. Fold in a V4L2 open-handle check before committing.
        this._checkV4l2Camera(camPipeWire => {
            this._commitPrivacyState(micInUse, camInUse || camPipeWire);
        });
    }

    _commitPrivacyState(micInUse, camInUse) {
        if (micInUse !== this._micInUse || camInUse !== this._camInUse) {
            this._micInUse = micInUse;
            this._camInUse = camInUse;
            if (this.onPrivacyChanged) this.onPrivacyChanged();
        }
    }

    // Detect a camera opened via V4L2 by asking `fuser` whether any process
    // holds a /dev/video* capture device open. Metadata-only nodes are never
    // held open by capture apps, so a live handle is a reliable "in use" signal.
    // Calls back with true/false; on any failure it reports false (no override).
    _checkV4l2Camera(cb) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['sh', '-c', 'fuser /dev/video* 2>/dev/null'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            cb(false);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch (e) {
                cb(false);
                return;
            }
            // `fuser` prints PIDs when a device is open; empty output means idle.
            cb(out.trim().length > 0);
        });
    }

    _updateAudioStream() {
        if (!this._mixerControl) return;

        let sink = this._mixerControl.get_default_sink();
        if (sink === this._audioStream) return;

        if (this._audioStream) {
            // Unbind old listeners
            if (this._volNotifyId) this._audioStream.disconnect(this._volNotifyId);
            if (this._muteNotifyId) this._audioStream.disconnect(this._muteNotifyId);
        }

        this._audioStream = sink;

        if (this._audioStream) {
            this._volNotifyId = this._audioStream.connect('notify::volume', () => {
                this._readVolume();
            });
            this._muteNotifyId = this._audioStream.connect('notify::is-muted', () => {
                this._readVolume();
            });
            this._readVolume();
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

    _ensureBrightnessProxy() {
        if (this._brightnessProxy !== undefined) return this._brightnessProxy;
        try {
            const BrightnessIface =
                '<node><interface name="org.gnome.SettingsDaemon.Power.Screen">' +
                '<property name="Brightness" type="i" access="readwrite"/>' +
                '</interface></node>';
            const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessIface);
            this._brightnessProxy = BrightnessProxy(
                Gio.DBus.session,
                'org.gnome.SettingsDaemon.Power',
                '/org/gnome/SettingsDaemon/Power');
        } catch (e) {
            this._brightnessProxy = null;
        }
        return this._brightnessProxy;
    }

    _getGsdBrightness() {
        try {
            let proxy = this._ensureBrightnessProxy();
            if (proxy && typeof proxy.Brightness === 'number' && proxy.Brightness >= 0)
                return Math.round(proxy.Brightness);
        } catch (e) {
            // ignore
        }
        return null;
    }

    // --- Airplane mode --- (via gnome-settings-daemon Rfkill, the same
    // interface GNOME's own quick toggle drives; flips all radios at once).
    _ensureRfkillProxy() {
        if (this._rfkillProxy !== undefined) return this._rfkillProxy;
        try {
            const RfkillIface =
                '<node><interface name="org.gnome.SettingsDaemon.Rfkill">' +
                '<property name="AirplaneMode" type="b" access="readwrite"/>' +
                '<property name="HasAirplaneMode" type="b" access="read"/>' +
                '</interface></node>';
            const RfkillProxy = Gio.DBusProxy.makeProxyWrapper(RfkillIface);
            this._rfkillProxy = RfkillProxy(
                Gio.DBus.session,
                'org.gnome.SettingsDaemon.Rfkill',
                '/org/gnome/SettingsDaemon/Rfkill');
        } catch (e) {
            this._rfkillProxy = null;
        }
        return this._rfkillProxy;
    }

    getAirplaneMode() {
        try {
            let proxy = this._ensureRfkillProxy();
            if (proxy) return proxy.AirplaneMode === true;
        } catch (e) {
            // ignore
        }
        return false;
    }

    setAirplaneMode(on) {
        try {
            let proxy = this._ensureRfkillProxy();
            if (proxy) proxy.AirplaneMode = !!on;
        } catch (e) {
            console.warn('NotchNux: airplane-mode control unavailable', e.message);
        }
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
            let sessionPath = this._logindSessionPath();
            if (!sessionPath) return;
            Gio.DBus.system.call(
                'org.freedesktop.login1',
                sessionPath,
                'org.freedesktop.login1.Session',
                'SetBrightness',
                new GLib.Variant('(ssu)', ['backlight', dev.name, raw]),
                null, Gio.DBusCallFlags.NONE, 1000, null,
                (conn, res) => {
                    try { conn.call_finish(res); }
                    catch (e) { console.warn('NotchNux: logind SetBrightness failed', e.message); }
                });
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

    // Resolve the graphical logind session object path. First try the caller's
    // own session (works inside gnome-shell); if that fails — e.g. the caller
    // isn't tied to a session — fall back to this user's "Display" session,
    // which logind reports directly and doesn't depend on the caller's PID.
    _logindSessionPath() {
        if (this._logindPath !== undefined) return this._logindPath;
        this._logindPath = null;
        try {
            let res = Gio.DBus.system.call_sync(
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'GetSessionByPID',
                new GLib.Variant('(u)', [0]), new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            this._logindPath = res.deep_unpack()[0];
            return this._logindPath;
        } catch (e) {
            // Not fatal — try the User.Display route below.
        }
        try {
            let uid = this._selfUid();
            let userRes = Gio.DBus.system.call_sync(
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'GetUser',
                new GLib.Variant('(u)', [uid]), new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            let userPath = userRes.deep_unpack()[0];
            let disp = Gio.DBus.system.call_sync(
                'org.freedesktop.login1', userPath,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.login1.User', 'Display']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 1000, null);
            // Display is a variant of (so): (session_id, object_path).
            let [sessionId, objectPath] = disp.deep_unpack()[0].deep_unpack();
            this._logindPath = objectPath;
        } catch (e) {
            console.warn('NotchNux: could not resolve logind session', e.message);
        }
        return this._logindPath;
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
    getBluetoothDevices() {
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
            let bluezDevices = this._getBluezDevices();
            for (let d of bluezDevices)
                addDevice(d);
        } catch (e) {
            console.error('NotchNux: Error listing BlueZ devices', e);
        }

        try {
            if (this._upowerClient) {
                let devices = this._upowerClient.get_devices();
                for (let device of devices) {
                    // kind: UPower.DeviceKind
                    // Type values: 1 = Line Power, 2 = Battery, 3 = UPS, 4 = Monitor, 5 = Mouse, 6 = Keyboard, 7 = PDA, 8 = Phone, 11 = Headphones, 12 = Audio, 13 = Tablet
                    let kind = device.kind;
                    if (kind === 2) {
                        // Check if it's external battery (not laptop battery)
                        // Laptop battery usually starts with 'BAT' or 'battery' in object path or is_present/kind.
                        let path = device.get_object_path() || '';
                        if (path.includes('battery_BAT') || path.includes('DisplayDevice')) {
                            continue;
                        }
                    }

                    // Let's filter out laptop internal battery and only include external accessories
                    if (kind === 5 || kind === 6 || kind === 11 || kind === 12 || kind === 13 || kind === 2) {
                        let typeStr = 'Battery';
                        let iconStr = 'battery-symbolic';
                        if (kind === 5) { typeStr = 'Mouse'; iconStr = 'input-mouse-symbolic'; }
                        else if (kind === 6) { typeStr = 'Keyboard'; iconStr = 'input-keyboard-symbolic'; }
                        else if (kind === 11 || kind === 12) { typeStr = 'Audio Device'; iconStr = 'audio-headset-symbolic'; }
                        else if (kind === 13) { typeStr = 'Tablet'; iconStr = 'input-tablet-symbolic'; }

                        addDevice({
                            name: device.model || 'Wireless Device',
                            type: typeStr,
                            percentage: Number.isFinite(device.percentage) ? Math.round(device.percentage) : null,
                            icon: iconStr
                        });
                    }
                }
            }
        } catch (e) {
            console.error('NotchNux: Error listing Bluetooth/UPower devices', e);
        }
        return [...byKey.values()].sort((a, b) => {
            if (a.connected !== b.connected) return a.connected ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
    }

    _getBluezDevices() {
        let list = [];
        let result = Gio.DBus.system.call_sync(
            'org.bluez',
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            2000,
            null);

        let [objects] = result.recursiveUnpack();
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

// Helper to convert GBytes/ByteArray to Javascript string
function ByteArrayToString(byteArray) {
    if (byteArray instanceof Uint8Array) {
        return new TextDecoder().decode(byteArray);
    }
    // GJS legacy support
    return String.fromCharCode.apply(null, byteArray);
}
