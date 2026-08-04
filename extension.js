import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NotchNux } from './src/notchnux.js';

export default class NotchNuxExtension extends Extension {
    enable() {
        console.log('NotchNux: Enabling extension...');
        
        // 1. Hide default clock
        if (Main.panel && Main.panel.statusArea && Main.panel.statusArea.dateMenu) {
            Main.panel.statusArea.dateMenu.hide();
        }

        // 2. Create and mount NotchNux widget.
        // trackFullscreen:false keeps the notch on screen when a window is
        // maximized/fullscreen over the top strip — otherwise the layout
        // manager hides all fullscreen-tracked top chrome and the notch
        // vanishes the moment you maximize an app.
        this._notch = new NotchNux(this);
        Main.layoutManager.addTopChrome(this._notch, { trackFullscreen: false });
    }

    disable() {
        console.log('NotchNux: Disabling extension...');
        
        // 1. Remove and destroy widget
        if (this._notch) {
            Main.layoutManager.removeChrome(this._notch);
            this._notch.destroy();
            this._notch = null;
        }

        // 2. Restore default clock
        if (Main.panel && Main.panel.statusArea && Main.panel.statusArea.dateMenu) {
            Main.panel.statusArea.dateMenu.show();
        }
    }
}
