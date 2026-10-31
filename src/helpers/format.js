// Cached date/time formatting.
//
// In GJS every Date.toLocale{Date,Time}String() call builds a fresh ICU
// formatter (~0.5 ms each). A tab render that formats a dozen dates — the
// calendar strip, agenda, weather clock — spent tens of milliseconds just on
// that, which showed up as a dropped frame on every tab open. Intl formatters
// are reusable, so keep one per distinct option set.

const _cache = new Map();

function formatter(opts) {
    let key = JSON.stringify(opts);
    let f = _cache.get(key);
    if (!f) {
        f = new Intl.DateTimeFormat([], opts);
        _cache.set(key, f);
    }
    return f;
}

// Locale-formatted date/time, equivalent to date.toLocaleString([], opts).
export function fmt(date, opts) {
    return formatter(opts).format(date);
}
