// One short system alert at a time (volume, charging, headphones, a calendar
// heads-up…), each for its own duration — the pill's answer to the phone's
// little "Charging" / "Connected" islands.
//
// Pure bookkeeping, no actors: the shell asks the queue what to show and when
// it expires. Rules:
//   - An alert of the same kind as the one showing replaces it in place
//     (a stream of volume ticks is one alert whose bar moves).
//   - "Instant" alerts (direct feedback for something the user just did, like
//     a volume key) show at once. Whatever they interrupt goes back to the
//     front of the line, unless it was instant too — stale feedback is dropped.
//   - Everything else waits its turn, one pending entry per kind.

// How long each kind stays up, in ms. A low-battery alert overrides with its
// own `ms`.
export const ALERT_MS = {
    level: 1600,
    power: 3000,
    headphones: 3000,
    calendar: 8000,
    app: 3000,
};

export class AlertQueue {
    constructor() {
        this.current = null;
        this._pending = [];
    }

    static durationOf(alert) {
        return alert.ms ?? ALERT_MS[alert.kind] ?? 3000;
    }

    // Add an alert. Returns 'replace' when the visible alert was updated in
    // place, 'show' when `alert` became the visible one, or null when it was
    // queued (or dropped).
    enqueue(alert) {
        if (this.current && this.current.kind === alert.kind) {
            this.current = alert;
            return 'replace';
        }
        this._pending = this._pending.filter(a => a.kind !== alert.kind);
        if (!this.current) {
            this.current = alert;
            return 'show';
        }
        if (alert.instant) {
            if (!this.current.instant)
                this._pending.unshift(this.current);
            this.current = alert;
            return 'show';
        }
        this._pending.push(alert);
        return null;
    }

    // Can't show anything right now (dashboard open): wait in line.
    defer(alert) {
        this._pending = this._pending.filter(a => a.kind !== alert.kind);
        this._pending.push(alert);
    }

    // Visible alert is done (expired or dismissed).
    dismiss() {
        this.current = null;
    }

    // Pull the next waiting alert, if any and nothing is showing.
    promote() {
        if (this.current || this._pending.length === 0)
            return null;
        this.current = this._pending.shift();
        return this.current;
    }

    // Instant feedback is worthless a moment later: drop any that is waiting
    // (e.g. the dashboard opened over it).
    dropInstant() {
        if (this.current?.instant)
            this.current = null;
        this._pending = this._pending.filter(a => !a.instant);
    }

    clear() {
        this.current = null;
        this._pending = [];
    }

    get hasPending() {
        return this._pending.length > 0;
    }
}

// Which battery alert (if any) a change in power state deserves. `prev` is
// null on the first reading, which never alerts (no "Charging" at login).
export const LOW_BATTERY_THRESHOLDS = [20, 10];

export function powerAlertFor(prev, next) {
    if (!prev || !next.hasBattery)
        return null;
    if (!prev.onAC && next.onAC)
        return { type: 'charging', level: next.level };
    if (next.onAC || next.level >= prev.level)
        return null;
    let crossed = LOW_BATTERY_THRESHOLDS.some(t => prev.level > t && next.level <= t);
    return crossed ? { type: 'low', level: next.level } : null;
}
