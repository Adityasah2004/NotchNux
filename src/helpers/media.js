// Camera + microphone helper for the NotchNux "Studio" tab.
//
// GNOME Shell (Clutter/St) has no native video widget, so a live webcam
// preview is produced by running a GStreamer pipeline whose tail is an
// `appsink`: every decoded frame is pulled as a raw RGB buffer and handed to a
// callback, which the Studio tab paints into an St.DrawingArea via Cairo (the
// same Cairo-on-DrawingArea approach the clock/vinyl already use).
//
// Recording is a second, independent pipeline that tees the camera (plus the
// selected mic) to a WebM file, or — for audio-only — the mic to an Ogg/Opus
// file. Enumeration of cameras and mics uses Gst.DeviceMonitor, which reports
// friendly display names plus the underlying device node.

import Gst from 'gi://Gst';
import GstApp from 'gi://GstApp';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _gstReady = false;
function ensureGst() {
    if (_gstReady) return true;
    try {
        Gst.init(null);
        _gstReady = true;
    } catch (e) {
        console.error('NotchNux: Gst.init failed', e);
    }
    return _gstReady;
}

// One enumerated capture device: a stable id, a human label, and the bits the
// pipelines need to actually open it.
class MediaDevice {
    constructor(gstDevice) {
        this._dev = gstDevice;
        this.name = gstDevice.get_display_name();
        this.kind = gstDevice.get_device_class().startsWith('Video') ? 'video' : 'audio';
        let props = gstDevice.get_properties();
        // Gst.Structure.get_string() returns the string directly (or null).
        this.v4l2Path = props ? props.get_string('api.v4l2.path') : null;
        this.nodeName = props ? props.get_string('node.name') : null;
        // A stable id for the drop-down selection.
        this.id = this.nodeName || this.v4l2Path || this.name;
    }

    // Build the source-element launch fragment for this device. Prefer
    // pipewiresrc by node (works for both cameras and mics under PipeWire);
    // fall back to the raw v4l2 device path for cameras.
    sourceFragment() {
        if (this.nodeName)
            return `pipewiresrc target-object="${this.nodeName}"`;
        if (this.kind === 'video' && this.v4l2Path)
            return `v4l2src device=${this.v4l2Path}`;
        return this.kind === 'video' ? 'v4l2src' : 'pulsesrc';
    }
}

export class MediaHelper {
    constructor() {
        this._ok = ensureGst();
        this._preview = null;       // live preview pipeline
        this._previewSink = null;
        this._recorder = null;      // recording pipeline
        this._recordKind = null;    // 'video' | 'audio' while recording
        this._recordPath = null;
        this.onFrame = null;        // (rgbBytes, width, height, stride) => void
        this.onRecordingChanged = null; // (kind|null, path|null) => void
    }

    get available() { return this._ok; }

    // --- Device enumeration -------------------------------------------------

    // A single long-lived DeviceMonitor per class, started once and left
    // running. Re-creating and start()/stop()ing a monitor on every Studio
    // render probes all devices synchronously on the main loop — that is what
    // made switching to the Studio tab stutter. Kept warm, get_devices() is an
    // instant cache read and hotplugged devices show up on the next render.
    _monitor(klass) {
        if (!this._ok) return null;
        if (!this._monitors) this._monitors = {};
        let mon = this._monitors[klass];
        if (!mon) {
            mon = new Gst.DeviceMonitor();
            mon.add_filter(klass, null);
            mon.start();
            this._monitors[klass] = mon;
        }
        return mon;
    }

    _listDevices(klass) {
        let mon = this._monitor(klass);
        if (!mon) return [];
        let out = [];
        for (let d of mon.get_devices())
            out.push(new MediaDevice(d));
        return out;
    }

    listCameras() { return this._listDevices('Video/Source'); }
    listMics() { return this._listDevices('Audio/Source'); }

    // --- Live preview -------------------------------------------------------

    // Start (or restart) a live preview from `camera` (a MediaDevice). Frames
    // are pulled by a main-loop timer (NOT the appsink's `new-sample` signal —
    // that fires on GStreamer's streaming thread, which GJS refuses to call JS
    // from). Each pulled frame is handed to `onFrame` on the main loop. Capped
    // to a modest resolution so painting stays cheap.
    startPreview(camera) {
        this.stopPreview();
        if (!this._ok || !camera) return;
        const W = 320, H = 240;
        let desc =
            `${camera.sourceFragment()} ! videoconvert ! videoscale ! ` +
            `video/x-raw,format=RGB,width=${W},height=${H} ! ` +
            `appsink name=sink max-buffers=1 drop=true sync=false`;
        try {
            this._preview = Gst.parse_launch(desc);
        } catch (e) {
            console.error('NotchNux: preview pipeline failed', e);
            this._preview = null;
            return;
        }
        this._previewSink = this._preview.get_by_name('sink');
        this._preview.set_state(Gst.State.PLAYING);

        // ~20fps poll. try_pull_sample(0) returns null when no frame is ready,
        // so an empty tick is cheap; drop=true keeps only the freshest frame.
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            let sink = this._previewSink;
            if (!sink) return GLib.SOURCE_REMOVE;
            let sample = sink.try_pull_sample(0);
            if (sample && this.onFrame) {
                let buf = sample.get_buffer();
                let caps = sample.get_caps().get_structure(0);
                let w = caps.get_value('width');
                let h = caps.get_value('height');
                let [ok, map] = buf.map(Gst.MapFlags.READ);
                if (ok) {
                    let stride = Math.floor(map.size / h);
                    // Copy before unmap — the painter reads it after this tick.
                    let copy = Uint8Array.from(map.data);
                    buf.unmap(map);
                    this.onFrame(copy, w, h, stride);
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopPreview() {
        if (this._pollId) { GLib.Source.remove(this._pollId); this._pollId = 0; }
        if (this._preview) {
            this._preview.set_state(Gst.State.NULL);
            this._preview = null;
            this._previewSink = null;
        }
    }

    // --- Recording ----------------------------------------------------------

    get isRecording() { return this._recorder !== null; }
    get recordingKind() { return this._recordKind; }

    _outPath(kind) {
        let dirType = kind === 'video'
            ? GLib.UserDirectory.DIRECTORY_VIDEOS
            : GLib.UserDirectory.DIRECTORY_MUSIC;
        let dir = GLib.get_user_special_dir(dirType) || GLib.get_home_dir();
        let ext = kind === 'video' ? 'webm' : 'ogg';
        let stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        return GLib.build_filenamev([dir, `notch-${stamp}.${ext}`]);
    }

    // Record webcam (+ mic) to a WebM file. `camera` and `mic` are MediaDevices;
    // `mic` may be null to record video with no audio track.
    startVideoRecording(camera, mic) {
        if (!this._ok || this.isRecording || !camera) return null;
        let path = this._outPath('video');
        let audioBranch = mic
            ? `${mic.sourceFragment()} ! queue ! audioconvert ! audioresample ! ` +
              `opusenc ! queue ! mux. `
            : '';
        let desc =
            `webmmux name=mux ! filesink location="${path}" ` +
            `${camera.sourceFragment()} ! queue ! videoconvert ! videoscale ! ` +
            `video/x-raw,width=640,height=480 ! vp8enc deadline=1 cpu-used=5 ! queue ! mux. ` +
            audioBranch;
        return this._launchRecorder(desc, 'video', path);
    }

    // Record the selected mic to an Ogg/Opus file.
    startAudioRecording(mic) {
        if (!this._ok || this.isRecording || !mic) return null;
        let path = this._outPath('audio');
        let desc =
            `${mic.sourceFragment()} ! queue ! audioconvert ! audioresample ! ` +
            `opusenc ! oggmux ! filesink location="${path}"`;
        return this._launchRecorder(desc, 'audio', path);
    }

    _launchRecorder(desc, kind, path) {
        try {
            this._recorder = Gst.parse_launch(desc);
        } catch (e) {
            console.error('NotchNux: recorder pipeline failed', e);
            this._recorder = null;
            return null;
        }
        this._recordKind = kind;
        this._recordPath = path;
        // Watch the bus so an error/EOS tears the pipeline down cleanly.
        let bus = this._recorder.get_bus();
        bus.add_signal_watch();
        this._busId = bus.connect('message', (_b, msg) => {
            if (msg.type === Gst.MessageType.ERROR) {
                let [err] = msg.parse_error();
                console.error('NotchNux: recording error', err ? err.message : msg);
                this.stopRecording();
            } else if (msg.type === Gst.MessageType.EOS) {
                this._finalizeStop();
            }
        });
        this._recorder.set_state(Gst.State.PLAYING);
        if (this.onRecordingChanged) this.onRecordingChanged(kind, path);
        return path;
    }

    // Ask the pipeline to flush and finalize (a plain NULL would truncate the
    // muxer). We send EOS and let the bus handler finalize on the EOS reply.
    stopRecording() {
        if (!this._recorder) return null;
        let path = this._recordPath;
        // send_event returns quickly; finalize happens on the EOS bus message.
        try {
            this._recorder.send_event(Gst.Event.new_eos());
        } catch (e) {
            this._finalizeStop();
        }
        // Safety net: if EOS never arrives, force-finalize shortly after.
        this._stopFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._stopFallbackId = 0;
            this._finalizeStop();
            return GLib.SOURCE_REMOVE;
        });
        return path;
    }

    _finalizeStop() {
        if (this._stopFallbackId) {
            GLib.Source.remove(this._stopFallbackId);
            this._stopFallbackId = 0;
        }
        if (!this._recorder) return;
        let bus = this._recorder.get_bus();
        if (this._busId) { bus.disconnect(this._busId); this._busId = 0; }
        bus.remove_signal_watch();
        this._recorder.set_state(Gst.State.NULL);
        this._recorder = null;
        this._recordKind = null;
        let path = this._recordPath;
        this._recordPath = null;
        if (this.onRecordingChanged) this.onRecordingChanged(null, path);
    }

    destroy() {
        this.stopPreview();
        if (this._recorder) {
            // Best-effort finalize on teardown.
            try { this._recorder.send_event(Gst.Event.new_eos()); } catch (e) {}
            this._finalizeStop();
        }
        if (this._monitors) {
            for (let mon of Object.values(this._monitors)) {
                try { mon.stop(); } catch (e) {}
            }
            this._monitors = null;
        }
        this.onFrame = null;
        this.onRecordingChanged = null;
    }
}
