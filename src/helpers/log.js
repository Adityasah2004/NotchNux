// NotchNux logging.
//
// Every failure path in the extension reports through here instead of calling
// console.* directly, so the journal stays quiet:
//  - logError() reports a real failure, but each distinct message only once
//    per shell session. A poll that fails every few seconds (an unreadable
//    /proc file, a missing D-Bus service) can't flood the log.
//  - logDebug() is diagnostic chatter for expected, recoverable situations
//    (no NetworkManager, no backlight, a WiFi connect the user can retry). It
//    is silent unless gnome-shell runs with NOTCHNUX_DEBUG=1 in its env.

import GLib from 'gi://GLib';

const debug = !!GLib.getenv('NOTCHNUX_DEBUG');
const reported = new Set();

export function logError(message, error) {
    if (reported.has(message))
        return;
    reported.add(message);
    if (error === undefined)
        console.error(`NotchNux: ${message}`);
    else
        console.error(`NotchNux: ${message}`, error);
}

export function logDebug(message, detail) {
    if (!debug)
        return;
    if (detail === undefined)
        console.debug(`NotchNux: ${message}`);
    else
        console.debug(`NotchNux: ${message}`, detail);
}
