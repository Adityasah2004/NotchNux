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

        // Initialize UPower Client
        try {
            this._upowerClient = UPower.Client.new_full(null);
        } catch (e) {
            console.error('NotchNux: Failed to initialize UPower Client', e);
        }

        // NetworkManager client for WiFi state + hotspot control. Created async
        // so we never block the shell; getWifiInfo/toggles no-op until it's up.
        // `onWifiChanged` (set by the shell) fires once the client is ready and
        // whenever WiFi state changes, so a Tray tab open before NM was up still
        // gets a populated WiFi row as soon as it becomes available.
        this._nmClient = null;
        this.onWifiChanged = null;
        try {
            NM.Client.new_async(null, (obj, res) => {
                try {
                    this._nmClient = NM.Client.new_finish(res);
                    // NM.Client has no custom signals in this version — watch the
                    // relevant properties instead. wireless-enabled covers the
                    // radio toggle; active-connections covers connect/disconnect
                    // and hotspot activation; state is a catch-all.
                    this._nmClient.connect('notify::wireless-enabled', () => this._emitWifiChanged());
                    this._nmClient.connect('notify::active-connections', () => this._emitWifiChanged());
                    this._nmClient.connect('notify::state', () => this._emitWifiChanged());
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

    // 8-char alphanumeric password (avoids ambiguous 0/O/1/l for readability).
    _genHotspotPassword() {
        const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < 8; i++)
            out += chars[Math.floor(Math.random() * chars.length)];
        return out;
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
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                cb(this._wifiSsidInRange(ssid));
                return GLib.SOURCE_REMOVE;
            });
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

    // Serve the last snapshot and refresh it in the background: a synchronous
    // GetManagedObjects against a busy bluetoothd can stall the shell for
    // hundreds of ms, and this runs every 3s while the Tray tab is open. The
    // first call returns [] and the list pops in on the next repaint tick.
    // `onUpdate` (optional) fires when the async refresh lands a changed
    // snapshot, so the caller can re-render once the (initially empty) list
    // actually populates instead of waiting for its next poll tick.
    _getBluezDevices(onUpdate) {
        this._refreshBluezDevices(onUpdate);
        return this._bluezCache ?? [];
    }

    _refreshBluezDevices(onUpdate) {
        if (this._bluezRefreshing) return;
        this._bluezRefreshing = true;
        Gio.DBus.system.call(
            'org.bluez',
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            2000,
            null,
            (conn, res) => {
                this._bluezRefreshing = false;
                try {
                    let result = conn.call_finish(res);
                    let next = this._parseBluezObjects(result);
                    // Only notify when the snapshot actually changed, so an
                    // unchanged poll doesn't rebuild the card out from under a
                    // scroll/hover.
                    let changed = this._bluezSignature(next) !== this._bluezSignature(this._bluezCache);
                    this._bluezCache = next;
                    if (changed && onUpdate) onUpdate();
                } catch (e) {
                    // BlueZ unavailable or timed out; keep the last snapshot.
                }
            });
    }

    // Compact fingerprint of a bluez snapshot: name + connected + battery per
    // device. Used to detect whether an async refresh changed anything.
    _bluezSignature(list) {
        if (!Array.isArray(list)) return '';
        return list.map(d => `${d.name}:${d.connected ? 1 : 0}:${d.percentage}`).sort().join('|');
    }

    _parseBluezObjects(result) {
        let list = [];
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

    // --- Bluetooth radio + discovery (BlueZ Adapter1) ---

    // Object path of the first BlueZ adapter, cached. Resolved synchronously
    // once (a single small GetManagedObjects); callers below are all async.
    _bluezAdapterPath() {
        if (this._btAdapterPath !== undefined) return this._btAdapterPath;
        this._btAdapterPath = null;
        try {
            let res = Gio.DBus.system.call_sync(
                'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects', null, null,
                Gio.DBusCallFlags.NONE, 2000, null);
            let [objects] = res.recursiveUnpack();
            for (let [path, ifaces] of Object.entries(objects)) {
                if (ifaces['org.bluez.Adapter1']) { this._btAdapterPath = path; break; }
            }
        } catch (e) {
            // BlueZ unavailable — leave null so callers no-op gracefully.
        }
        return this._btAdapterPath;
    }

    // Whether the Bluetooth adapter is powered on. Reads the cached snapshot
    // refreshed by _refreshBtPowered(); returns false until the first read.
    getBluetoothPowered() {
        this._refreshBtPowered();
        return this._btPowered === true;
    }

    _refreshBtPowered() {
        if (this._btPoweredRefreshing) return;
        let path = this._bluezAdapterPath();
        if (!path) return;
        this._btPoweredRefreshing = true;
        Gio.DBus.system.call(
            'org.bluez', path, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.bluez.Adapter1', 'Powered']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null,
            (conn, res) => {
                this._btPoweredRefreshing = false;
                try { this._btPowered = conn.call_finish(res).recursiveUnpack()[0]; }
                catch (e) { /* keep last */ }
            });
    }

    // Power the Bluetooth adapter on/off (Adapter1.Powered). `cb(ok)` on return.
    setBluetoothRadio(on, cb) {
        let done = (ok) => { if (cb) cb(!!ok); };
        let path = this._bluezAdapterPath();
        if (!path) { done(false); return; }
        Gio.DBus.system.call(
            'org.bluez', path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.bluez.Adapter1', 'Powered',
                new GLib.Variant('b', !!on)]),
            null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try { conn.call_finish(res); this._btPowered = !!on; done(true); }
                catch (e) { console.warn('NotchNux: BT power toggle failed', e.message); done(false); }
            });
    }

    // Begin scanning for nearby devices (Adapter1.StartDiscovery). `cb(ok)`.
    startBluetoothDiscovery(cb) {
        let done = (ok) => { if (cb) cb(!!ok); };
        let path = this._bluezAdapterPath();
        if (!path) { done(false); return; }
        Gio.DBus.system.call(
            'org.bluez', path, 'org.bluez.Adapter1', 'StartDiscovery',
            null, null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => {
                try { conn.call_finish(res); done(true); }
                catch (e) {
                    // "InProgress" just means discovery was already running.
                    done(/InProgress/.test(e.message));
                }
            });
    }

    // Stop scanning (Adapter1.StopDiscovery). Best-effort; errors are ignored.
    stopBluetoothDiscovery() {
        let path = this._bluezAdapterPath();
        if (!path) return;
        Gio.DBus.system.call(
            'org.bluez', path, 'org.bluez.Adapter1', 'StopDiscovery',
            null, null, Gio.DBusCallFlags.NONE, 5000, null,
            (conn, res) => { try { conn.call_finish(res); } catch (e) { /* ignore */ } });
    }

    // Snapshot of ALL nearby Device1 objects (unlike getBluetoothDevices, which
    // filters to paired/connected). Serves the last snapshot and refreshes in
    // the background so a busy bluetoothd never stalls the shell. Each entry:
    // { name, address, dbusPath, paired, connected, icon }.
    getDiscoveredBluetoothDevices() {
        this._refreshDiscoveredBt();
        return this._btDiscoveredCache ?? [];
    }

    _refreshDiscoveredBt() {
        if (this._btDiscoveredRefreshing) return;
        this._btDiscoveredRefreshing = true;
        Gio.DBus.system.call(
            'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects', null, null,
            Gio.DBusCallFlags.NONE, 2000, null,
            (conn, res) => {
                this._btDiscoveredRefreshing = false;
                try {
                    let [objects] = conn.call_finish(res).recursiveUnpack();
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
                    list.sort((a, b) => {
                        let an = /^([0-9A-F]{2}:){5}/i.test(a.name) ? 1 : 0;
                        let bn = /^([0-9A-F]{2}:){5}/i.test(b.name) ? 1 : 0;
                        if (an !== bn) return an - bn;
                        return a.name.localeCompare(b.name);
                    });
                    this._btDiscoveredCache = list;
                } catch (e) { /* keep last snapshot */ }
            });
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

// Helper to convert GBytes/ByteArray to Javascript string
function ByteArrayToString(byteArray) {
    if (byteArray instanceof Uint8Array) {
        return new TextDecoder().decode(byteArray);
    }
    // GJS legacy support
    return String.fromCharCode.apply(null, byteArray);
}
