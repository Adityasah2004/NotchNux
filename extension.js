import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NotchNux } from './src/notchnux.js';
import { ConfigStore } from './src/helpers/config.js';

export default class NotchNuxExtension extends Extension {
    enable() {
        // The config is read asynchronously so enable() never blocks the
        // shell on file IO; the notch is built as soon as it arrives (a few
        // ms). disable() before then just cancels the read.
        this._cancellable = new Gio.Cancellable();
        ConfigStore.loadAsync(this._cancellable, config => {
            this._cancellable = null;
            this._mount(config);
        });
    }

    _mount(config) {
        // 1. Hide default clock
        Main.panel?.statusArea?.dateMenu?.hide();

        // 2. Create and mount NotchNux widget.
        // trackFullscreen:false keeps the notch on screen when a window is
        // maximized/fullscreen over the top strip — otherwise the layout
        // manager hides all fullscreen-tracked top chrome and the notch
        // vanishes the moment you maximize an app.
        this._notch = new NotchNux(this, config);
        Main.layoutManager.addTopChrome(this._notch, { trackFullscreen: false });
    }

    disable() {
        // A config read still in flight: cancel it, nothing was mounted.
        this._cancellable?.cancel();
        this._cancellable = null;

        // 1. Remove and destroy widget
        if (this._notch) {
            this._notch._disabling = true;
            Main.layoutManager.removeChrome(this._notch);
            this._notch.destroy();
            this._notch = null;

            // 2. Restore default clock
            Main.panel?.statusArea?.dateMenu?.show();
        }
    }
}
