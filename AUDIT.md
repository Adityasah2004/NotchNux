# NotchNux audit — 2026-10-23

Full read of every source file (`src/notchnux.js`, all helpers, `prefs.js`,
`extension.js`, `stylesheet.css`) plus a runtime pass in a throwaway headless
GNOME Shell 50 (screenshots + log scrape) and the live session's journal.

Severity: **P** = freezes / data loss · **H** = lag, leaks, stability ·
**S** = security / privacy · **U** = UX / design.

## Findings

### P — freezes and data loss
| # | Where | Finding |
|---|-------|---------|
| P1 | `wallpaper.js` `_enhanceCopyFor` / `_landscapeCopyFor`, `notchnux.js` `_buildWallpaperThumb` | Full-size image decode, a per-pixel JS sharpen loop (~3.7 M px × 30 ops at 2560×1440) and PNG encode all run **on the compositor thread**. Every rotation with *Enhance* on stalls the whole desktop for seconds; opening the Wallpaper tab decodes/rotates every portrait image synchronously just to draw thumbnails. |
| P2 | `shelf.js` `addFile` | `Gio.File.copy()` is synchronous — adding a multi-GB file (picker or paste) freezes the shell for the whole copy. |
| P3 | `notchnux.js` `_init` → `clearShelf()` | GNOME disables extensions on every **screen lock**, so the Shelf is wiped on each lock/unlock, not once per login (journal shows 4 enable cycles this boot). Silent data loss. |
| P4 | `weather.js` `_fetchGeoClueLocation` | `GetClientSync()` + synchronous proxy construction on the system bus, on every enable/unlock and every 15 min. GeoClue is D-Bus-activated, so this blocks the shell until it starts (default timeout 25 s). |
| P5 | `notchnux.js` `_refreshLive` | Every MPRIS change, **every volume step**, every weather refresh and every calendar signal tears down and rebuilds the whole Music tab (vinyl, knob, timeline, art lookup). Scrolling the volume knob destroys the knob under the cursor on every tick. |
| P6 | `notchnux.js` `_resolveAlbumArt` | Album-art URLs come from any MPRIS app and are fetched with `send_and_read` — no size or content-type limit, whole body buffered in gnome-shell's heap. On-disk art cache grows forever. |

### H — lag, leaks, stability
| # | Where | Finding |
|---|-------|---------|
| H1 | `destroy()` | Doesn't close the Wi-Fi/Bluetooth scan overlay; its 2–3 s refresh timer keeps running against disposed actors after a lock. |
| H2 | helpers | Callbacks outlive `destroy()`: MPRIS `GetAll` replies, weather Soup requests + GeoClue timeout, privacy subprocesses, NetworkManager `notify::*` handlers (never disconnected) → "already disposed" errors after unlock. |
| H3 | `expand()`, `_showNotificationPeek()`, timeline | Height is measured/eased before the actor has its final width and the timeline sizes itself off-stage → `needs an allocation` + `St-CRITICAL … not in the stage` on every open (reproduced headless). |
| H4 | uncommitted `_setClippedRedrawsDisabled` | Now unconditionally re-enables clipped redraws, so the blur "breathing outline" artifact (#1) comes back. Global full redraws are a real GPU cost, so it should be an explicit opt-in. |
| H5 | `system.js` privacy poll | Spawns `pw-dump` (≈230 KB JSON parsed in-shell) + `sh -c fuser` every 6 s forever, even with privacy indicators turned off. |
| H6 | `_startClock` | 1 s timer re-measures five actors to size the pill for a minute-resolution clock. |
| H7 | Tray / Shelf renders | Synchronous D-Bus on render (`GetManagedObjects`, `NameHasOwner`, BlueZ adapter lookup, sync proxy wrappers for rfkill/gsd-power); a fresh `Gio.Settings` per Tray render. |
| H8 | constructor | Sync startup work on every unlock: MPRIS `new_for_bus_sync` + `ListNames call_sync`, shelf enumeration, weather/geo kick-off. |
| H9 | calendar signals | `EventsAddedOrUpdated` calls `_refreshLive` (rebuilds Music) but never refreshes an open Calendar tab. |
| H10 | `weather.js` | `forecast_days=1` → after ~6 pm the hourly strip has fewer than 6 slots. |
| H11 | `media.js` `stopRecording` | Re-entrant calls stack duplicate fallback timers. |

### S — security / privacy
| # | Where | Finding |
|---|-------|---------|
| S1 | `shelf.js` `showInFiles` | Builds a command line by string-interpolating the filename: `nautilus --select "${filePath}"`. A crafted name with quotes injects extra arguments. |
| S2 | `media.js` | GStreamer pipelines assembled with `Gst.parse_launch` from interpolated device node names / paths (`target-object="${nodeName}"`, `location="${path}"`) → pipeline injection via a crafted device name. |
| S3 | `notchnux.js` | (= P6) unbounded remote fetch driven by any local MPRIS client. |
| S4 | `weather.js` | Logs the full reverse-geocoded address (street, postcode) to the system journal on every refresh. |
| S5 | `config.js`, `shelf.js`, `wallpaper.js`, art cache | Data dirs created `0755`; shelf files / notes / config are readable by other local users wherever `$HOME` is traversable. |
| S6 | `shelf.js` | `file://${path}` URIs built by concatenation — paths with `#`, `%`, `?` open the wrong file. |
| S7 | album art, wallpaper thumbs | Paths injected unescaped into inline CSS `url("…")`. |
| S8 | `system.js` hotspot | Password from `Math.random()`, 8 chars × 32 symbols ≈ 40 bits. |
| S9 | hotspot | SSID + password posted as a persistent notification (stays in history / visible to shoulder-surfers). |
| S10 | config | Shell and prefs both rewrite the whole `config.json` from stale in-memory copies → lost updates when both write. |
| S11 | banner suppression | Monkey-patched `_showNotification` also swallows **critical-urgency** notifications (low battery, etc.) when the peek is on. |
| S12 | portal file chooser | `Response` signal subscription never times out if the portal never answers. |

### U — UX / design
| # | Finding |
|---|---------|
| U1 | Eight text-label tabs in a 560 px carousel: half are scrolled off-screen ("Calen…" is cut off behind the power button), so tabs are effectively undiscoverable. |
| U2 | No productivity features at all — no tasks, no notes, no timer. |
| U3 | No glanceable "home": the user has to hunt across tabs for what's next. |
| U4 | Tab switches fade in place; the active highlight jumps instead of travelling; no sense of direction. |
| U5 | Collapsed pill only shows time / battery / track — no live activities. |
| U6 | Text inputs (Wi-Fi password) never get the keyboard — the shell isn't modal, so keys go to the focused window. |

### Found while fixing (runtime measurement in the headless shell)
| # | Finding |
|---|---------|
| R1 | **Privacy poll = periodic jank.** Every 6 s: spawn `pw-dump` (~35 ms in-shell), `JSON.parse` 230 KB (~35 ms), spawn `fuser` (~35 ms) — up to ~100 ms of compositor time per poll. Now: one long-lived `pw-dump --monitor` streaming deltas + an out-of-process V4L2 watcher; mic dot reacts in ~200 ms instead of up to 6 s. |
| R2 | **Tray rendered 3× per open** (initial + one per async BlueZ / UPower reply), ~100 ms each. Now only the Devices list / Wi-Fi card are rebuilt; quick toggles restyle in place. |
| R3 | **Every hover-open rebuilt the tab from scratch.** Tab content is now kept across collapse and refreshed in place; re-open sync cost 6–34 ms (was 30–200 ms). |
| R4 | **Calendar render called the shell's `DBusEventSource.requestRange()`** (17–35 ms each — it re-renders the hidden date menu) for data we already get from our own CalendarServer subscription. Removed. |
| R5 | **`NameOwnerChanged` never fired** (`connectSignal` on an interface-less `DBusProxy` is a no-op), so MPRIS players were only ever found by polling. Now a connection-level, arg0-filtered subscription. |
| R6 | **Banner suppression wedged GNOME's notification queue** after the first suppressed notification (tray left in `SHOWN` with no expiry): no further shell banners, critical alerts lost, transient notifications never cleaned. Now returns the tray to `HIDDEN`. |
| R7 | **Studio camera kept streaming after the notch collapsed** (only a tab switch stopped it) — privacy + 20 fps of frame copies in the background. |
| R8 | `EqBars.stop()` removed already-fired GLib sources → `GLib-CRITICAL Source ID … not found` on every pause. |
| R9 | UPower accessory types were mis-mapped (headphones were 11/12, tablet 13; UpDeviceKind says 17/19 and 10), and `get_devices2()` objects were freed under GJS. Now an async D-Bus snapshot with the correct kinds. |
| R10 | Media timeline resized its fill from inside `notify::allocation` → re-queued layout mid-pass → the `needs an allocation` spam. Now a `scale_x` transform (no relayout) that also glides smoothly between ticks. |
| R11 | `_collapseImmediately()` cleared *all* timers, silently dropping a pending prefs reload. |
| R12 | `toLocaleDateString()` builds a fresh ICU formatter per call (~0.45 ms); now cached `Intl.DateTimeFormat`s. |
| R13 | GLib's atomic write keeps an existing file's mode, so old `0644` config files stayed world-readable; now `chmod 0600` on save. |

## Todo (fixed one at a time, each verified in the headless shell)

### Phase 1 — stability, performance, security
- [x] 1. Shelf: async copy, once-per-login clear, safe reveal (FileManager1 D-Bus), real URIs, `0700` dirs, portal timeout (P2 P3 S1 S5 S6 S12)
- [x] 2. Wallpaper: move enhance/rotate into an out-of-process worker; async cached thumbnails (P1 S7)
- [x] 3. Weather: async GeoClue, no address logging, 2-day forecast, cancellable on destroy (P4 S4 H10)
- [x] 4. Teardown hygiene: callbacks nulled, cancellables, NM handlers disconnected, overlay closed (H1 H2)
- [x] 5. Music tab updates in place; per-tab update routing (P5 H9)
- [x] 6. Album art: size/type cap, cache pruning, no CSS injection (P6 S3 S7)
- [x] 7. GStreamer pipelines built from element factories (S2 H11)
- [x] 8. Expand / peek measurement order, off-stage guards (H3)
- [x] 9. Minute-aligned clock; privacy poll gated + no shell (H5 H6)
- [x] 10. Blur artifact fix as an explicit opt-in (H4)
- [x] 11. Async startup + async/cached D-Bus on render paths (H7 H8)
- [x] 12. Config merge-on-write, CSPRNG hotspot password, transient credentials, never swallow critical notifications (S8 S9 S10 S11)

### Phase 2 — redesign + productivity
- [x] 13. Productivity store (tasks, notes, focus) — atomic, `0600`, survives lock/unlock
- [x] 14. Tab rail redesign: icon rail + travelling active indicator, every tab visible (U1 U4)
- [x] 15. Directional content transitions; expand/collapse motion polish (U4)
- [x] 16. Modal text input for entries (U6)
- [x] 17. Home tab — glanceable bento (U3)
- [x] 18. Tasks tab (U2)
- [x] 19. Focus timer tab + live activity in the pill + completion peek (U2 U5)
- [x] 20. Notes tab (U2)
- [x] 21. Stylesheet refresh
- [x] 22. Prefs for the new features; README / CHANGELOG / version bump

### Follow-up — edges, ghosts, island look
- [x] 23. Glass bled past the rounded corners and left dark ghosts on partial repaints (BACKGROUND blur reads the framebuffer). Replaced by an ACTOR-mode blur of a `window_group` clone + rounded GLSL mask (`src/helpers/island.js`); the global DISABLE_CLIPPED_REDRAWS opt-in is removed. Headless: ~0.74 ms per repaint vs ~3 ms with full redraws.
- [x] 24. Dashboard overflowed the box mid-spring → `_surface.clip_to_allocation`.
- [x] 25. Island restyle: solid, no rim/shadow, concave shoulders, flat tiles, accent-tinted active tab.
