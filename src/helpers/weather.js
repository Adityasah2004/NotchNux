import Soup from 'gi://Soup';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { logError, logDebug } from './log.js';

const GEOCLUE = 'org.freedesktop.GeoClue2';
// GClueAccuracyLevel.CITY — plenty for weather, and it doesn't ask GeoClue for
// a street-level fix the extension has no use for.
const ACCURACY_CITY = 4;
const GEOCLUE_TIMEOUT_S = 8;
// A cached forecast younger than this is shown as-is on startup (GNOME
// re-enables the extension on every unlock; refetching each time was waste).
const FRESH_SECONDS = 15 * 60;

export class WeatherHelper {
    constructor() {
        this._session = new Soup.Session({
            timeout: 15,
            user_agent: 'NotchNux GNOME Shell extension (+https://github.com/Adityasah2004/NotchNux)',
        });
        this._cancellable = new Gio.Cancellable();
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'notchnux']);
        this._configPath = GLib.build_filenamev([this._configDir, 'settings.json']);
        // Filled in by _loadSettings() (async). Until then nothing is
        // fetched or saved, so the empty defaults never overwrite the file.
        this._settings = {};
        this._settingsLoaded = false;
        this._pendingUpdate = false;
        this._geo = null;   // in-flight GeoClue session, see _fetchGeoClueLocation
        this.weatherData = {
            temp: '--',
            tempValue: null,
            condition: 'Loading weather...',
            icon: 'weather-few-clouds-symbolic',
            city: 'Locating...',
            wind: '-- km/h',
            humidity: '--%',
            high: '--°',
            low: '--°',
            sunrise: '--:--',
            sunset: '--:--',
            hourly: [],   // [{ label, icon, temp }]
            manualLocation: this._settings.locationQuery || '',
            loaded: false,
        };
        this.onWeatherUpdated = null;
        this._timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
        this._loadSettings();
    }

    _loadSettings() {
        Gio.File.new_for_path(this._configPath).load_contents_async(this._cancellable, (f, res) => {
            let parsed = {};
            try {
                let [, bytes] = f.load_contents_finish(res);
                parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            this._settings = parsed && typeof parsed === 'object' ? parsed : {};
            this._settingsLoaded = true;
            // Restore the last good forecast so the UI has real numbers right away.
            let cached = this._settings.lastWeather;
            if (cached?.data?.loaded && typeof cached.at === 'number')
                this.weatherData = { ...this.weatherData, ...cached.data, hourly: cached.data.hourly ?? [] };
            this.weatherData.manualLocation = this._settings.locationQuery || '';
            this._notify();
            if (this._pendingUpdate) {
                this._pendingUpdate = false;
                this.updateWeather();
            }
        });
    }

    destroy() {
        this.onWeatherUpdated = null;
        this._cancellable.cancel();
        this._session.abort();
        this._endGeoClue();
    }

    // Seconds since the cached forecast was fetched (Infinity if none).
    get ageSeconds() {
        let at = this._settings.lastWeather?.at;
        return typeof at === 'number' ? Math.max(0, Date.now() / 1000 - at) : Infinity;
    }

    get isFresh() {
        return this.weatherData.loaded && this.ageSeconds < FRESH_SECONDS;
    }

    _notify() {
        if (this.onWeatherUpdated)
            this.onWeatherUpdated(this.weatherData);
    }

    // --- Main Entry ---
    updateWeather() {
        if (!this._settingsLoaded) {
            this._pendingUpdate = true;
            return;
        }
        if (this._settings.locationQuery) {
            this.updateWeatherForLocation(this._settings.locationQuery);
            return;
        }
        this.requestDeviceLocation();
    }

    requestDeviceLocation() {
        if (this._settings.locationQuery) {
            this._settings.locationQuery = '';
            this._saveSettings();
        }
        if (!this.weatherData.loaded) {
            this.weatherData.condition = 'Locating weather...';
            this.weatherData.city = 'Locating...';
        }
        this.weatherData.manualLocation = '';
        this._notify();

        this._fetchGeoClueLocation((loc) => {
            if (loc) {
                this._resolveLocationName(loc, (city) => {
                    this._fetchWeather(loc.lat, loc.lon, city);
                });
                return;
            }
            this._setLocationUnavailable();
        });
    }

    updateWeatherForLocation(query) {
        query = String(query || '').trim();
        if (!query) {
            this.requestDeviceLocation();
            return;
        }

        if (this._settings.locationQuery !== query) {
            this._settings.locationQuery = query;
            this._saveSettings();
        }
        if (!this.weatherData.loaded) {
            this.weatherData.condition = 'Finding location...';
            this.weatherData.city = query;
        }
        this.weatherData.manualLocation = query;
        this._notify();

        this._geocodeLocation(query, (loc) => {
            if (!loc) {
                this.weatherData = {
                    ...this.weatherData,
                    condition: 'Location not found',
                    city: query,
                    loaded: false,
                };
                this._notify();
                return;
            }
            this._fetchWeather(loc.lat, loc.lon, loc.city || query);
        });
    }

    _saveSettings() {
        if (!this._settingsLoaded)
            return;
        try {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            GLib.file_set_contents_full(this._configPath,
                new TextEncoder().encode(JSON.stringify(this._settings, null, 2)),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
            GLib.chmod(this._configPath, 0o600);
        } catch (e) {
            logError('Failed to save weather settings.', e);
        }
    }

    // GET `url` and parse JSON. `done(json | null)`; null on any failure or
    // after destroy(). Responses are small, so buffering them is fine.
    _getJson(url, done) {
        let msg = Soup.Message.new('GET', url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                let json = null;
                try {
                    let bytes = session.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK)
                        throw new Error(`HTTP ${msg.get_status()}`);
                    json = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    logDebug(`weather request failed: ${e.message}`);
                }
                done(json);
            });
    }

    _geocodeLocation(query, done) {
        let coord = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (coord) {
            let lat = Number(coord[1]);
            let lon = Number(coord[2]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                done({ lat, lon, city: `${lat.toFixed(2)}, ${lon.toFixed(2)}` });
                return;
            }
        }

        this._getJson('https://nominatim.openstreetmap.org/search' +
            `?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, json => {
            let first = Array.isArray(json) ? json[0] : null;
            let lat = Number(first?.lat), lon = Number(first?.lon);
            if (!first || !Number.isFinite(lat) || !Number.isFinite(lon)) {
                done(null);
                return;
            }
            done({ lat, lon, city: first.name || first.display_name || query });
        });
    }

    // Ask GeoClue for a city-level fix, fully asynchronously. The old code
    // used GetClientSync + synchronous proxies on the system bus; GeoClue is
    // D-Bus activated, so that blocked the compositor until it started.
    _fetchGeoClueLocation(done) {
        this._endGeoClue();
        let bus = Gio.DBus.system;
        let geo = { done, clientPath: null, signalId: 0, timeoutId: 0, settled: false };
        this._geo = geo;

        let call = (path, iface, method, params, cb) => bus.call(GEOCLUE, path, iface, method,
            params, null, Gio.DBusCallFlags.NONE, 5000, this._cancellable, (c, res) => {
                try {
                    cb(c.call_finish(res));
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logDebug(`GeoClue ${method} failed: ${e.message}`);
                    this._finishGeoClue(geo, null);
                }
            });
        let setProp = (name, value, cb) => call(geo.clientPath, 'org.freedesktop.DBus.Properties',
            'Set', new GLib.Variant('(ssv)', [`${GEOCLUE}.Client`, name, value]), cb);

        geo.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, GEOCLUE_TIMEOUT_S, () => {
            geo.timeoutId = 0;
            this._finishGeoClue(geo, null);
            return GLib.SOURCE_REMOVE;
        });

        call('/org/freedesktop/GeoClue2/Manager', `${GEOCLUE}.Manager`, 'GetClient', null, reply => {
            if (geo.settled) return;
            [geo.clientPath] = reply.deepUnpack();
            geo.signalId = bus.signal_subscribe(GEOCLUE, `${GEOCLUE}.Client`, 'LocationUpdated',
                geo.clientPath, null, Gio.DBusSignalFlags.NONE,
                (c, sender, path, iface, signal, params) => {
                    let [, newPath] = params.deepUnpack();
                    call(newPath, 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', [`${GEOCLUE}.Location`]), r => {
                            let [props] = r.recursiveUnpack();
                            let lat = Number(props.Latitude), lon = Number(props.Longitude);
                            this._finishGeoClue(geo, Number.isFinite(lat) && Number.isFinite(lon)
                                ? { lat, lon, city: props.Description || null } : null);
                        });
                });
            setProp('DesktopId', new GLib.Variant('s', 'notchnux'), () =>
                setProp('RequestedAccuracyLevel', new GLib.Variant('u', ACCURACY_CITY), () =>
                    call(geo.clientPath, `${GEOCLUE}.Client`, 'Start', null, () => {})));
        });
    }

    _finishGeoClue(geo, loc) {
        if (geo.settled) return;
        geo.settled = true;
        if (this._geo === geo)
            this._endGeoClue();
        geo.done(loc);
    }

    // Release the GeoClue client: stop it, drop the signal and the timeout.
    _endGeoClue() {
        let geo = this._geo;
        this._geo = null;
        if (!geo) return;
        geo.settled = true;
        if (geo.timeoutId) GLib.Source.remove(geo.timeoutId);
        if (geo.signalId) Gio.DBus.system.signal_unsubscribe(geo.signalId);
        if (geo.clientPath) {
            Gio.DBus.system.call(GEOCLUE, geo.clientPath, `${GEOCLUE}.Client`, 'Stop',
                null, null, Gio.DBusCallFlags.NONE, 2000, null, (c, res) => {
                    try { c.call_finish(res); } catch (e) {}
                });
        }
    }

    _setLocationUnavailable() {
        // Keep showing a cached forecast if we have one; only blank the card
        // when there's genuinely nothing to show.
        if (this.weatherData.loaded)
            return;
        this.weatherData = {
            ...this.weatherData,
            condition: 'Location unavailable',
            city: 'Enable location',
            loaded: false,
        };
        this._notify();
    }

    _resolveLocationName(loc, done) {
        if (loc.city) {
            done(loc.city);
            return;
        }
        // Reverse-geocode once per ~1 km cell; the answer is cached in settings
        // so routine refreshes don't hit Nominatim at all.
        let cell = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
        if (this._settings.placeCache?.cell === cell) {
            done(this._settings.placeCache.name);
            return;
        }
        this._getJson('https://nominatim.openstreetmap.org/reverse' +
            `?format=jsonv2&lat=${loc.lat}&lon=${loc.lon}&zoom=10&addressdetails=1`, json => {
            let address = json?.address || {};
            let primary = address.city || address.town || address.village ||
                address.municipality || address.suburb || address.county || json?.name;
            if (!primary) {
                done(`${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`);
                return;
            }
            let region = address.state || address.country;
            let name = region && region !== primary ? `${primary}, ${region}` : primary;
            this._settings.placeCache = { cell, name };
            this._saveSettings();
            done(name);
        });
    }

    _fetchWeather(lat, lon, city) {
        // Current conditions, hourly temp/weathercode for the forecast strip, and
        // today's high/low + sunrise/sunset. Two days so the 6-hour strip is
        // full in the evening; `timezone=auto` lines hourly up with local time.
        let url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
            '&hourly=temperature_2m,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset' +
            '&forecast_days=2&timezone=auto';
        this._getJson(url, json => {
            let current = json?.current;
            if (!current) {
                // Offline: keep the last forecast visible but mark it stale.
                this.weatherData = { ...this.weatherData, stale: true };
                if (!this.weatherData.loaded)
                    this.weatherData.condition = 'Weather offline';
                this._notify();
                return;
            }
            let cond = this._getWeatherCondition(current.weather_code);
            let daily = json.daily || {};
            this.weatherData = {
                temp: `${Math.round(current.temperature_2m)}°`,
                tempValue: Math.round(current.temperature_2m),
                condition: cond.text,
                icon: cond.icon,
                city,
                wind: `${Math.round(current.wind_speed_10m)} km/h`,
                humidity: `${Math.round(current.relative_humidity_2m)}%`,
                high: daily.temperature_2m_max ? `${Math.round(daily.temperature_2m_max[0])}°` : '--°',
                low: daily.temperature_2m_min ? `${Math.round(daily.temperature_2m_min[0])}°` : '--°',
                sunrise: this._fmtTime(daily.sunrise && daily.sunrise[0]),
                sunset: this._fmtTime(daily.sunset && daily.sunset[0]),
                hourly: this._buildHourly(json.hourly),
                manualLocation: this._settings.locationQuery || '',
                loaded: true,
                stale: false,
            };
            this._settings.lastWeather = { at: Math.floor(Date.now() / 1000), data: this.weatherData };
            this._saveSettings();
            this._notify();
        });
    }

    // "2026-07-15T18:10" -> "6:10 PM" (or "18:10", per locale). open-meteo
    // returns the location's local wall-clock time with timezone=auto, so build
    // the Date from those fields as-is rather than re-applying a zone.
    _fmtTime(iso) {
        let m = typeof iso === 'string' && iso.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
        if (!m) return '--:--';
        let d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        return this._timeFmt.format(d);
    }

    // Build the 6-slot forecast strip starting at the current hour. The hourly
    // arrays are same-indexed (time[i] <-> temperature_2m[i] <-> weather_code[i]).
    _buildHourly(hourly) {
        if (!hourly || !hourly.time) return [];
        let now = new Date();
        let hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
        let startIdx = hourly.time.findIndex(t => new Date(t) >= hourStart);
        if (startIdx < 0) startIdx = 0;
        let out = [];
        for (let i = startIdx; i < hourly.time.length && out.length < 6; i++) {
            let d = new Date(hourly.time[i]);
            let cond = this._getWeatherCondition(hourly.weather_code[i]);
            let hr = d.getHours();
            let label = out.length === 0 ? 'Now'
                : `${((hr + 11) % 12) + 1}${hr < 12 ? 'a' : 'p'}`;
            out.push({ label, icon: cond.icon, temp: `${Math.round(hourly.temperature_2m[i])}°` });
        }
        return out;
    }

    _getWeatherCondition(code) {
        // WMO Weather interpretation codes (https://open-meteo.com/en/docs)
        if (code === 0)
            return { text: 'Clear Sky', icon: 'weather-clear-symbolic' };
        if (code >= 1 && code <= 3)
            return { text: 'Partly Cloudy', icon: 'weather-few-clouds-symbolic' };
        if (code === 45 || code === 48)
            return { text: 'Foggy', icon: 'weather-fog-symbolic' };
        if (code >= 51 && code <= 57)
            return { text: 'Light Drizzle', icon: 'weather-showers-scattered-symbolic' };
        if (code >= 61 && code <= 67)
            return { text: 'Rainy', icon: 'weather-showers-symbolic' };
        if (code >= 71 && code <= 75)
            return { text: 'Snowy', icon: 'weather-snow-symbolic' };
        if (code === 77)
            return { text: 'Snow Grains', icon: 'weather-snow-symbolic' };
        if (code >= 80 && code <= 82)
            return { text: 'Rain Showers', icon: 'weather-showers-symbolic' };
        if (code === 85 || code === 86)
            return { text: 'Snow Showers', icon: 'weather-snow-symbolic' };
        if (code >= 95 && code <= 99)
            return { text: 'Thunderstorm', icon: 'weather-storm-symbolic' };
        return { text: 'Cloudy', icon: 'weather-overcast-symbolic' };
    }
}
