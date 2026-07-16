import Soup from 'gi://Soup';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class WeatherHelper {
    constructor() {
        this._session = new Soup.Session({ timeout: 15 });
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'notchnux']);
        this._configPath = GLib.build_filenamev([this._configDir, 'settings.json']);
        this._settings = this._loadSettings();
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
            loaded: false
        };

        this.onWeatherUpdated = null;
    }

    _notify() {
        if (this.onWeatherUpdated)
            this.onWeatherUpdated(this.weatherData);
    }

    // --- Main Entry ---
    updateWeather() {
        if (this._settings.locationQuery) {
            this.updateWeatherForLocation(this._settings.locationQuery);
            return;
        }
        this.requestDeviceLocation();
    }

    requestDeviceLocation() {
        this._settings.locationQuery = '';
        this._saveSettings();
        this.weatherData.condition = 'Locating weather...';
        this.weatherData.city = 'Locating...';
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

        this._settings.locationQuery = query;
        this._saveSettings();
        this.weatherData.condition = 'Finding location...';
        this.weatherData.city = query;
        this.weatherData.manualLocation = query;
        this._notify();

        this._geocodeLocation(query, (loc) => {
            if (!loc) {
                this.weatherData = {
                    ...this.weatherData,
                    condition: 'Location not found',
                    city: query,
                    loaded: false
                };
                this._notify();
                return;
            }
            this._fetchWeather(loc.lat, loc.lon, loc.city || query);
        });
    }

    _loadSettings() {
        try {
            let [ok, bytes] = GLib.file_get_contents(this._configPath);
            if (!ok || !bytes)
                return {};
            let text = new TextDecoder('utf-8').decode(bytes);
            return JSON.parse(text);
        } catch (e) {
            return {};
        }
    }

    _saveSettings() {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            GLib.file_set_contents(this._configPath, JSON.stringify(this._settings, null, 2));
        } catch (e) {
            console.error('NotchNux: Failed to save settings.', e);
        }
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

        let url = 'https://nominatim.openstreetmap.org/search' +
            `?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
        let msg = Soup.Message.new('GET', url);
        msg.request_headers.append('User-Agent', 'NotchNux GNOME Shell Extension');

        this._session.send_and_read_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, res) => {
                try {
                    let bytes = session.send_and_read_finish(res);
                    let status = msg.get_status();
                    if (status !== Soup.Status.OK)
                        throw new Error(`HTTP ${status}`);

                    let text = new TextDecoder('utf-8').decode(bytes.get_data());
                    let json = JSON.parse(text);
                    let first = Array.isArray(json) ? json[0] : null;
                    if (!first)
                        throw new Error(`missing geocode result: ${text.slice(0, 160)}`);

                    done({
                        lat: Number(first.lat),
                        lon: Number(first.lon),
                        city: first.display_name || query
                    });
                } catch (e) {
                    console.error('NotchNux: Manual geocoding failed.', e);
                    done(null);
                }
            }
        );
    }

    _fetchGeoClueLocation(done) {
        try {
            const ManagerIface =
                '<node><interface name="org.freedesktop.GeoClue2.Manager">' +
                '<method name="GetClient"><arg name="client" type="o" direction="out"/></method>' +
                '</interface></node>';
            const ClientIface =
                '<node><interface name="org.freedesktop.GeoClue2.Client">' +
                '<property name="DesktopId" type="s" access="readwrite"/>' +
                '<property name="RequestedAccuracyLevel" type="u" access="readwrite"/>' +
                '<method name="Start"/>' +
                '<method name="Stop"/>' +
                '<signal name="LocationUpdated">' +
                '<arg name="old" type="o"/><arg name="new" type="o"/>' +
                '</signal></interface></node>';
            const LocationIface =
                '<node><interface name="org.freedesktop.GeoClue2.Location">' +
                '<property name="Latitude" type="d" access="read"/>' +
                '<property name="Longitude" type="d" access="read"/>' +
                '<property name="Description" type="s" access="read"/>' +
                '</interface></node>';

            const ManagerProxy = Gio.DBusProxy.makeProxyWrapper(ManagerIface);
            const ClientProxy = Gio.DBusProxy.makeProxyWrapper(ClientIface);
            const LocationProxy = Gio.DBusProxy.makeProxyWrapper(LocationIface);

            let manager = ManagerProxy(
                Gio.DBus.system,
                'org.freedesktop.GeoClue2',
                '/org/freedesktop/GeoClue2/Manager');
            let [clientPath] = manager.GetClientSync();
            let client = ClientProxy(
                Gio.DBus.system,
                'org.freedesktop.GeoClue2',
                clientPath);

            client.DesktopId = 'notchnux';
            client.RequestedAccuracyLevel = 4; // Exact, if permission allows it.

            let timeoutId = 0;
            let signalId = 0;
            let settled = false;
            let finish = (loc) => {
                if (settled) return;
                settled = true;
                if (timeoutId) {
                    GLib.Source.remove(timeoutId);
                    timeoutId = 0;
                }
                try {
                    if (signalId) client.disconnectSignal(signalId);
                    client.StopRemote(() => {});
                } catch (e) {
                    // Ignore cleanup failures.
                }
                done(loc);
            };

            signalId = client.connectSignal('LocationUpdated', (proxy, sender, [oldPath, newPath]) => {
                try {
                    let location = LocationProxy(
                        Gio.DBus.system,
                        'org.freedesktop.GeoClue2',
                        newPath);
                    let lat = Number(location.Latitude);
                    let lon = Number(location.Longitude);
                    if (!Number.isFinite(lat) || !Number.isFinite(lon))
                        throw new Error('GeoClue returned invalid coordinates');

                    finish({
                        lat,
                        lon,
                        city: location.Description || null
                    });
                } catch (e) {
                    console.error('NotchNux: GeoClue location update failed.', e);
                    finish(null);
                }
            });

            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                console.log('NotchNux: GeoClue location timed out.');
                timeoutId = 0;
                finish(null);
                return GLib.SOURCE_REMOVE;
            });
            client.StartRemote((result, error) => {
                if (error) {
                    console.error('NotchNux: GeoClue start failed.', error);
                    finish(null);
                }
            });
        } catch (e) {
            console.error('NotchNux: GeoClue location failed.', e);
            done(null);
        }
    }

    _setLocationUnavailable() {
        this.weatherData = {
            ...this.weatherData,
            condition: 'Location unavailable',
            city: 'Enable location',
            loaded: false
        };
        this._notify();
    }

    _resolveLocationName(loc, done) {
        if (loc.city) {
            done(loc.city);
            return;
        }

        let url = 'https://nominatim.openstreetmap.org/reverse' +
            `?format=jsonv2&lat=${loc.lat}&lon=${loc.lon}&zoom=12&addressdetails=1`;
        let msg = Soup.Message.new('GET', url);
        msg.request_headers.append('User-Agent', 'NotchNux GNOME Shell Extension');

        this._session.send_and_read_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, res) => {
                try {
                    let bytes = session.send_and_read_finish(res);
                    let status = msg.get_status();
                    if (status !== Soup.Status.OK)
                        throw new Error(`HTTP ${status}`);

                    let text = new TextDecoder('utf-8').decode(bytes.get_data());
                    let json = JSON.parse(text);
                    let address = json.address || {};
                    let primary = address.city || address.town || address.village ||
                        address.municipality || address.suburb || address.county ||
                        json.name || json.display_name;
                    let region = address.state || address.country;
                    if (!primary)
                        throw new Error(`missing place name: ${text.slice(0, 160)}`);

                    let city = primary;
                    if (region && region !== primary)
                        city = `${primary}, ${region}`;
                    console.log(`NotchNux: Location resolved ${city} (${loc.lat}, ${loc.lon}).`);
                    done(city);
                    return;
                } catch (e) {
                    console.error('NotchNux: Reverse geocoding failed.', e);
                    done(`${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`);
                }
            }
        );
    }

    _fetchWeather(lat, lon, city) {
        // Pull current conditions, hourly temp/weathercode for the forecast
        // strip, and today's high/low + sunrise/sunset. `timezone=auto` makes
        // the hourly timestamps line up with the user's local clock.
        let weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
            `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
            `&hourly=temperature_2m,weather_code` +
            `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset` +
            `&forecast_days=1&timezone=auto`;
        let weatherMsg = Soup.Message.new('GET', weatherUrl);

        this._session.send_and_read_async(
            weatherMsg,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, weatherRes) => {
                try {
                    let weatherBytes = session.send_and_read_finish(weatherRes);
                    let status = weatherMsg.get_status();
                    if (status !== Soup.Status.OK)
                        throw new Error(`HTTP ${status}`);

                    let weatherText = new TextDecoder('utf-8').decode(weatherBytes.get_data());
                    let weatherJson = JSON.parse(weatherText);

                    let current = weatherJson.current;
                    if (!current)
                        throw new Error(`missing current weather: ${weatherText.slice(0, 160)}`);

                    let cond = this._getWeatherCondition(current.weather_code);
                    let daily = weatherJson.daily || {};
                    this.weatherData = {
                        temp: `${Math.round(current.temperature_2m)}°`,
                        tempValue: Math.round(current.temperature_2m),
                        condition: cond.text,
                        icon: cond.icon,
                        city: city,
                        wind: `${Math.round(current.wind_speed_10m)} km/h`,
                        humidity: `${Math.round(current.relative_humidity_2m)}%`,
                        high: daily.temperature_2m_max ? `${Math.round(daily.temperature_2m_max[0])}°` : '--°',
                        low: daily.temperature_2m_min ? `${Math.round(daily.temperature_2m_min[0])}°` : '--°',
                        sunrise: this._fmtTime(daily.sunrise && daily.sunrise[0]),
                        sunset: this._fmtTime(daily.sunset && daily.sunset[0]),
                        hourly: this._buildHourly(weatherJson.hourly),
                        manualLocation: this._settings.locationQuery || '',
                        loaded: true
                    };
                    console.log(`NotchNux: Weather updated for ${city}: ${this.weatherData.temp}, ${this.weatherData.condition}.`);
                } catch (e) {
                    console.error('NotchNux: Weather forecast request failed.', e);
                    this.weatherData = {
                        ...this.weatherData,
                        condition: 'Weather offline',
                        loaded: false
                    };
                }

                this._notify();
            }
        );
    }

    // "2026-07-15T05:42" -> "5:42". open-meteo returns local ISO strings when
    // timezone=auto, so slice the clock portion rather than constructing a Date
    // (which would re-apply the runner's timezone).
    _fmtTime(iso) {
        if (!iso || typeof iso !== 'string') return '--:--';
        let t = iso.split('T')[1];
        if (!t) return '--:--';
        let [h, m] = t.split(':');
        return `${parseInt(h, 10)}:${m}`;
    }

    // Build the 6-slot forecast strip starting at the current hour. The hourly
    // arrays are same-indexed (time[i] <-> temperature_2m[i] <-> weather_code[i]).
    _buildHourly(hourly) {
        if (!hourly || !hourly.time) return [];
        let now = new Date();
        // Find the first hourly slot at or after the current hour.
        let startIdx = hourly.time.findIndex(t => new Date(t) >= new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()));
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
        if (code === 0) {
            return { text: 'Clear Sky', icon: 'weather-clear-symbolic' };
        } else if (code >= 1 && code <= 3) {
            return { text: 'Partly Cloudy', icon: 'weather-few-clouds-symbolic' };
        } else if (code === 45 || code === 48) {
            return { text: 'Foggy', icon: 'weather-fog-symbolic' };
        } else if (code >= 51 && code <= 55) {
            return { text: 'Light Drizzle', icon: 'weather-showers-scattered-symbolic' };
        } else if (code >= 61 && code <= 65) {
            return { text: 'Rainy', icon: 'weather-showers-symbolic' };
        } else if (code >= 71 && code <= 75) {
            return { text: 'Snowy', icon: 'weather-snow-symbolic' };
        } else if (code === 77) {
            return { text: 'Snow Grains', icon: 'weather-snow-symbolic' };
        } else if (code >= 80 && code <= 82) {
            return { text: 'Rain Showers', icon: 'weather-showers-symbolic' };
        } else if (code === 85 || code === 86) {
            return { text: 'Snow Showers', icon: 'weather-snow-symbolic' };
        } else if (code >= 95 && code <= 99) {
            return { text: 'Thunderstorm', icon: 'weather-storm-symbolic' };
        }
        return { text: 'Cloudy', icon: 'weather-overcast-symbolic' };
    }
}
