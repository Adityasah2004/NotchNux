# Changelog

All notable changes to NotchNux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — header shortcuts, 1 to 8
- Preferences → Tabs → **Header shortcuts** sets how many tabs sit beside
  Home, 1 to 8 (5 before, still the default). Lowering it hides the extra
  shortcuts; raising it again brings them back until you next edit them in
  the grid.

### Changed — extensions.gnome.org readiness
- Clipboard history is now opt-in for new installs (Preferences → Tabs);
  the metadata description declares clipboard and network use.
- Logging goes through one helper: each distinct error is logged once per
  session (a failing poll can't flood the journal) and diagnostic messages
  only appear with `NOTCHNUX_DEBUG=1`. No more enable/disable log lines.
- No synchronous file IO left in the shell: the config, tasks, notes, focus
  state, pinned clips and weather cache load asynchronously at enable, and
  CPU, network, RAM and backlight readings, the lyrics cache and the live
  config reload are async too. (The prefs window, a separate process, still
  reads the config synchronously before each save.)
- `shell-version` is now just GNOME 50, the only version it has been tested on.
- Added `pack.sh` to build the upload zip.

### Fixed
- The wallpaper thumbnail worker is killed when the extension is disabled
  instead of being left to finish on its own.
- Preferences rows with "&" in their text show it again: "Volume &
  brightness in the notch", "Charging & low battery alerts", and a
  wallpaper folder, GSConnect device or mirrored indicator with "&" in its
  name (they showed an empty title).

## [1.6.1] - 2026-11-01

### Fixed — text fields trapping the notch open
- Clicking into a text field (Add a task, notes, search…) and then clicking
  outside no longer leaves the field focused with the notch stuck open. While
  a field has the keyboard, the notch holds a modal grab that routes every
  click to itself, so the outside-click check now goes by click position:
  outside the notch closes it, inside but off the field just drops focus so
  hover-out closes it again.

## [1.6.0] - 2026-11-01

### Changed — Wallpaper tab is a slit deck
- Images are now slanted slits; the current one opens to full width and the
  row slides (spring, velocity-preserving) to keep it centred, with a little
  parallax and dimming on the neighbours. Wheel or trackpad steps move the
  selection instantly and the wallpaper is applied once you stop scrolling.

### Added — animated wallpaper changes on the desktop
- A new wallpaper is revealed on the desktop (above the background, under
  windows) before GNOME takes over: grow from the notch, slanted wipe, fade or
  none — *Settings → Wallpaper → Change animation*. Applies to timed rotation
  too.

## [1.5.0] - 2026-11-01

### Added — drag & drop onto the Shelf
- Drag a file from Files, the desktop or any app toward the notch: it opens on
  the Shelf, the drop zone lights up ("Release to add") and dropping copies the
  file in. Wayland only hands drag data to app windows, so a tiny invisible
  helper window (`src/tools/drop-catcher.js`) sits under the open dashboard for
  the length of the drag; it is hidden from the window list and exits after a
  few idle minutes.

### Fixed — GNOME 50 input
- The Wi-Fi / Bluetooth sheets' close (X) button and rows did nothing: a
  press handler returning `EVENT_STOP` cancelled St.Button's click gesture.
- `ClutterEvent.get_source()` returns null on GNOME 50, so every "was this
  click inside…" check failed silently (tapping a Wi-Fi row closed the sheet;
  the pill's right-click and swipe area tests). Now uses
  `global.stage.get_event_actor()`.

### Added — island behaviour (inspired by Dynamic Ledge)
- **Alerts in the notch.** Volume, brightness and other GNOME level pop-ups,
  charging, low battery (20 % / 10 %), headphones connecting and a heads-up
  5 minutes before a calendar event grow out of the pill for a moment, one at a
  time (same-kind alerts update in place; key-press feedback is never queued).
- **Hide when idle** (off by default). The island tucks into the top edge while
  nothing is live and comes back for music, timers, the mic/camera and alerts,
  or when you rest the pointer at the top centre. Once revealed (or after the
  dashboard closes) the pill stays up for 4 s of real idleness before tucking,
  instead of vanishing the moment the pointer moves off it.
- **Grid launcher.** The header now holds Home plus up to five shortcuts; every
  tab and toggle lives behind the new grid button. Hold a tile (or press Edit)
  to choose the shortcuts.
- **Clipboard** tab: the last 20 text clips, with search and pinning. Passwords
  are skipped, and only pinned clips are saved to disk.
- **Lyrics in the Music tab.** The new lyrics button in the transport swaps the
  vinyl and volume dial for a cover tile and timed lyrics from lrclib.net that
  scroll with the song (Apple Music's layout). The button only appears for
  songs that have lyrics; a song without them falls back to the player and the
  next one with lyrics opens straight into them. Lookups happen while the Music
  tab is open, can be turned off, and are cached (one request per song).
- **Stopwatch** in the Focus tab, with laps, shown live in the pill.
- **Keep Awake** (blocks idle and suspend), **Stats in the pill** (memory and
  CPU), two-finger **swipe** to skip tracks or pull the notch open, and a
  **right-click** quick menu on the pill.

### Changed
- **Tray rebuilt as a Control Center.** A Connectivity card (Wi-Fi, Bluetooth,
  Hotspot, Airplane Mode as round toggles; Wi-Fi and Bluetooth open their
  network/device sheets), Silence / Night Light / Screenshot / Lock tiles, thick
  drag-and-scroll Volume and Brightness sliders (click the speaker to mute), a
  Devices card and a compact System card (CPU, memory, disk, network) instead of
  seven ring gauges. Everything updates in place; meters move by transform.
- **Springs keep their momentum.** Interrupting the open/close (hovering out
  mid-open) now turns around smoothly instead of stopping dead, and a slow
  first frame no longer makes the notch jump a quarter of the way open.
- Wi-Fi and Bluetooth sheets now drop out of the header and fade away when
  dismissed, and only rebuild their rows when the list actually changes.
- Pitch-black island, system colours for status, and an island-style content
  swap (fade + slight scale from the top edge) between tabs and alerts.
- **New island look** (inspired by Hitodama's island): solid near-black,
  flush with the top edge and flared into it by concave shoulders, with no rim
  and no drop shadow. The tab rail loses its track, the active tab is an
  accent-tinted pill in the accent colour, and cards are flat, borderless tiles.
- **Glass rebuilt.** The blur now runs over a clone of the wallpaper + windows
  and is masked to the island's rounded shape by a small shader.

### Fixed
- Typing a Wi-Fi password was wiped every 3 seconds by the network list refresh.
- Logging out spammed "already disposed" errors: the shell had already torn
  down the message tray, panel and menus the notch tried to disconnect from.
- Glass blur bled past the rounded bottom corners (a background blur always
  paints a square).
- Dark smears around the notch with glass on, which never showed up in
  screenshots: a partial repaint made the blur sample the notch's own last
  frame. Fixed at the source, so the *Artifact-free blur* option (a full-screen
  redraw every frame) is gone.
- Dashboard content hung below the box for a few frames while it opened or
  closed; the island now clips to its own bounds.

## [1.4.0] - 2026-10-23

A redesign around your day, plus a full performance, stability and security
pass. The audit behind it — every finding, with how it was verified — is in
[AUDIT.md](AUDIT.md).

### Added
- **Home tab** (new default): greeting + weather, your next calendar event, top
  tasks with quick-add, the focus timer and now-playing controls.
- **Tasks tab**: add with Enter (`!` prefix stars a task), click to edit in
  place, star, delete, tick off with an animated check; **Open / Done** views and
  "Clear done". Stored in `~/.local/share/notchnux/tasks.json`.
- **Focus tab**: 15 / 25 / 50-minute sessions with automatic 5 / 15-minute
  breaks, optional **Do Not Disturb while focusing** (only ever undoes its own
  change), today's sessions and minutes, and a completion banner with
  *Start break*. Keeps running across screen locks.
- **Notes tab**: an autosaving scratchpad.
- **Live activity in the pill**: a running focus session shows its ring and
  countdown in the pill (click to open Focus); music yields to it.
- **Weather**: the 6-hour forecast strip (it was always fetched, never shown);
  the last forecast is kept and shown instantly after unlock/offline.
- **Artifact-free blur** switch for the glass styles (opt-in; see Fixed).

### Changed
- **Tab rail**: icon tabs over one travelling accent indicator; the active tab's
  label slides open. All twelve tabs fit — the old carousel hid half of them.
  Settings and the session actions moved into one **⋯** menu.
- **Motion**: the notch now blooms open on a spring with a hint of overshoot,
  folds back without bounce, swells slightly on hover, and tabs cross-slide in
  the direction you're moving. Buttons dip when pressed. All motion respects
  GNOME's *reduce animations* setting.
- Tabs are kept alive between visits and refreshed in place: switching back to a
  tab or re-opening the notch no longer rebuilds it.
- The quick-toggle formerly called *Focus* (do not disturb) is now *Silence*,
  to avoid clashing with the focus timer.

### Performance
- Wallpaper rotate/enhance and thumbnails run in a separate worker process
  instead of a per-pixel JS loop on the compositor thread (multi-second freezes).
- Adding a file to the Shelf copies asynchronously (a large file used to freeze
  the desktop for the whole copy).
- Mic/camera detection streams from `pw-dump --monitor` and a V4L2 watcher
  process instead of spawning and parsing ~230 KB of JSON in the shell every 6 s
  (~100 ms of jank per poll); the indicator now reacts in ~0.2 s.
- GeoClue, UPower, BlueZ, rfkill, logind and MPRIS start-up are fully async; the
  Music tab updates in place (volume scrolling no longer rebuilds it); the Tray
  rebuilds only the card that changed; the clock wakes once a minute; date
  formatting uses cached formatters; the dashboard is pre-warmed after login.

### Fixed
- The Shelf was wiped on **every screen lock**, not once per login.
- The notification peek **wedged GNOME's notification queue** after the first
  suppressed banner — later banners (including critical ones) never showed.
- The Studio **camera kept streaming after the notch collapsed**.
- Text fields (Wi-Fi password) never received the keyboard.
- MPRIS players were only detected by polling (`NameOwnerChanged` never fired).
- Errors after unlock / shell shutdown from callbacks outliving the notch.
- `needs an allocation` / `not in the stage` warnings on every open.
- Accessory battery types were mis-labelled; Tray's top-bar row could overflow
  the dashboard; blank preference group titles caused by unescaped `&`.

### Security
- No command lines are built from file or device names any more (Shelf
  *Reveal* uses the FileManager1 D-Bus API; Studio pipelines are built from
  GStreamer elements).
- Album art from MPRIS players is size- and type-checked and streamed with a
  hard cap; caches are pruned.
- Config, tasks, notes and caches are private (`0600` files, `0700` folders);
  the precise address is no longer written to the system journal.
- Hotspot passwords come from the kernel CSPRNG (60 bits) and are shown in a
  transient notification; critical notifications are never swallowed; the
  shell and preferences no longer overwrite each other's settings.


### Added
- **Tray tab networking overhaul — device/network lists, radio toggles, and
  in-notch scanning**:
  - The **Devices card** is now shorter and scrolls: it shows about three
    accessories at a time and scrolls when there are more, instead of capping at
    three. A **Bluetooth radio toggle** sits in the card header, and an **Add
    device…** row opens an in-notch overlay that powers Bluetooth on, scans for
    nearby devices, and pairs + connects the one you tap (works for "Just Works"
    devices; no PIN entry).
  - The **Wi-Fi card** gains a dedicated **Wi-Fi radio toggle** (alongside the
    existing hotspot button) and now lists your **saved/known networks** below the
    status line — the connected one is badged, and tapping another activates it.
    The list scrolls past ~3 entries. An **Add network…** row opens an overlay
    that scans for available access points; secure networks reveal an inline
    password field so you can join a new network without leaving the notch.
  - New NetworkManager helpers back this (saved-connection listing, rescan,
    access-point enumeration, activate-saved, and create-and-connect), plus BlueZ
    helpers for adapter power, discovery start/stop, nearby-device enumeration and
    pair-then-connect. All calls are async so the shell never blocks.

- **Backdrop blur / "glass" appearance**: a new **Glass & Blur** group in
  preferences composites a real gaussian blur of the wallpaper and windows
  behind the notch (via `Shell.BlurEffect` in `BACKGROUND` mode). Choose a glass
  style preset — **Liquid Glass** (Apple-style vivid frost), **Frosted**
  (Samsung-style neutral), **Clear** (barely-there), or **Acrylic**
  (Windows-style) — each of which sets the surface tint, opacity, rim highlight
  and blur brightness. Blur *strength* is controlled independently for the
  collapsed pill and the open dashboard, and animates smoothly between the two
  as the notch expands/collapses. Off by default; every control applies live.
  Each glass style now also carries its own recommended blur strengths, so
  picking a style applies a complete look (tint + rim + strength) and moves the
  strength sliders to match — and a **Reset to defaults** button restores the
  shipped style and strengths in one click.
- **WiFi row in the Tray tab**: a compact Wi-Fi card sits below the devices card
  (beside the mirrored top-bar row), showing the radio state and the connected
  network's name + signal. Click the row to toggle Wi-Fi on/off. A **hotspot**
  button starts/stops a Wi-Fi hotspot — it reuses an existing hotspot connection
  if you have one, otherwise creates a WPA2 access point and notifies you of the
  generated SSID and password. Uses NetworkManager; the row hides itself when
  there's no Wi-Fi hardware.
- **Pick which indicators the Tray tab mirrors**: a new **Mirrored indicators**
  group in preferences lists every top-bar / Quick Settings indicator NotchNux can
  mirror, each with its own switch, so you can hide the ones you don't want in the
  Tray tab's row. The shell publishes the list of indicators it actually sees into
  the config, so the picker reflects your real environment (open the Tray tab once
  to populate it). Everything shows by default; changes apply to the notch live.

### Fixed
- **Trailing blur outline / "breathing" shimmer on the glass surface**
  ([#1](https://github.com/Adityasah2004/NotchNux/issues/1)). With backdrop blur on,
  an outline of the pill/dashboard lingered on screen (the reporter saw it stay
  for ~5 seconds) and continuously re-rendered content — the spinning vinyl disc,
  EQ bars, the clock tick — made the frosted surface flicker/"breathe". Neither
  could be captured in a screenshot or screen recording. Root cause: Clutter's
  *clipped redraws* optimization only repaints the small rectangle that changed,
  but a `BACKGROUND` blur samples a larger region, so any partial repaint left the
  blur's sampled area stale (the artifact lives in the compositor framebuffer, not
  the scene graph — hence invisible to capture). NotchNux now disables clipped
  redraws (via the Clutter `DISABLE_CLIPPED_REDRAWS` debug flag, as blur-my-shell
  does) **only while blur is enabled**, and always restores them when blur is
  turned off or the extension unloads — since the flag is compositor-global.
- **Glass & Blur settings never returned to their defaults.** Switching the glass
  style only changed the frost look and left the blur-strength sliders untouched,
  and there was no way to restore the shipped values once they'd been moved. Glass
  styles now carry and apply their own strengths, and a **Reset to defaults**
  button restores the default style and blur strengths in one click.
- **Notch vanished behind a maximized window with "Reclaim panel space" on** (even
  without true fullscreen), flickering back only while scrolling or taking a
  screenshot. With the panel strut reclaimed, a maximized window reaches the very
  top of the monitor and Mutter unredirects it (direct scanout), so nothing drawn
  above it — the top-chrome notch included — was composited. NotchNux now inhibits
  unredirection **only while a window is actually covering the top strip** (tracked
  via window restack/resize signals), keeping the notch drawn over the covering
  window without disabling direct scanout the rest of the time — so fullscreen
  video keeps its scanout path when nothing overlaps the notch. Released
  automatically when the covering window moves away or the feature is turned off.
- **Mirrored GSConnect tile opened the whole system menu.** GSConnect's Quick
  Settings toggle keeps its device list in a QuickToggleMenu, which (unlike an
  old-style panel menu) has no boxpointer and expands inside the Quick Settings
  grid — so the previous "click = open the menu" path popped it up over the
  system-menu area instead of under the notch. Clicking a mirrored Quick Settings
  tile now performs the toggle's primary on/off action (flipping `checked` for
  toggle-mode toggles like GSConnect's service and Caffeine's inhibitor) with no
  stray menu.

## [1.3.0] - 2026-07-30

### Added
- **Mirror top-bar indicators**: the Tray tab now shows a "TOP BAR" row that
  mirrors the GNOME panel's status area (extension indicators + system icons).
  Clicking one opens that indicator's own menu anchored under the notch, so you
  can reach your extensions with the panel hidden. Non-destructive — the real
  panel keeps its actors. Toggle it with the new **Mirror top-bar indicators**
  feature switch (on by default). Hovering an icon now shows a tooltip with the
  indicator's name, so unlabelled icons (Caffeine, etc.) are identifiable.
- **Scroll the top edge to switch workspaces (with the panel hidden)**: some
  extensions let you scroll over the GNOME top bar to change workspaces, but
  hiding the panel removes that region. The new **Scroll top edge to switch
  workspaces** feature mounts an invisible full-width strip along the very top
  of the screen that captures scroll and switches workspaces itself — so the
  gesture keeps working with the bar hidden. Only active while "Hide top panel"
  is on; clicks pass through and it reserves no space. Off by default.

### Fixed
- **Notch vanished when maximizing a window with "Hide top panel" + "Reclaim
  panel space" on.** The notch is now mounted with `trackFullscreen: false`, so
  a maximized/fullscreen window no longer hides it. The panel is also kept
  hidden reliably: GNOME re-shows `panelBox` during its own region recomputes
  (opening/maximizing a window, workspace switches), so we watch its visibility
  and re-hide it while "Hide top panel" is on instead of flickering back.

## [1.2.0] - 2026-07-30

### Added
- **Wallpaper rotation**: a new **Wallpaper** dashboard tab plus a **Wallpaper**
  group in the preferences window. Rotate the desktop background through a
  chosen folder of images on a custom interval (seconds/minutes/hours), in
  sequential or random order, with optional auto-pause on battery and in
  fullscreen. The dashboard tab is a horizontal filmstrip of thumbnails —
  scroll through them or click one to switch immediately; landing on an image
  makes it current and restarts the rotation timer.
  - Only still images (JPG/PNG/WebP/etc.) are supported: GNOME on Wayland
    renders the background itself and accepts a static image URI only, so
    video/GIF/live wallpapers can't be drawn behind the desktop.
  - New `WallpaperHelper` (`src/helpers/wallpaper.js`) owns folder scanning,
    the `org.gnome.desktop.background` GSettings writes, the rotation timer,
    and auto-pause; settings persist to `config.json` under a `wallpaper` key.

## [1.1.0] - 2026-07-16

### Added
- **Native preferences window** (`prefs.js`): a GTK4/libadwaita settings window
  (Appearance, Tabs, Features, Quick Share, System) launched from the gear
  button via `extension.openPreferences()`. It shares `ConfigStore` with the
  shell, writing to `~/.config/notchnux/config.json`.
- **Live config reload**: the shell watches `config.json` and re-applies accent,
  tab order, and feature toggles as soon as the preferences window writes them —
  no shell restart required.
- **Quick Share via GSConnect**: send shelf files to paired GSConnect devices
  through the `shareFile` GAction, with a per-file Send action, a multi-device
  picker, and a footer that reports device state.
- **Shelf drop zone**: a click-to-browse / paste-a-file target
  (`pasteFilesFromClipboard` via `wl-paste`), standing in for Wayland
  drag-and-drop.
- **Pill notification indicator**: a bell + unread count on the collapsed pill
  that follows the accent colour and reflows the pill width.

### Changed
- **Analog clock** redesigned: a rounded-square dark body with a light circular
  dial, hour ticks, and dark hands for contrast.
- **Media timeline** fill is now pinned to the base's top-left via `FixedLayout`
  so it grows strictly left-to-right instead of floating centred.
- **Calendar** anchors its fetched event window to today and debounces the
  scroll flush, so scrolling rebuilds only the agenda instead of the whole tab.
- `install.sh` now installs `prefs.js`.

### Removed
- The in-notch settings panel, its tab-order drag machinery, toggle widgets,
  and associated CSS, now that the native preferences window owns that UI.

### Fixed
- The Alerts tab count badge wraps its label in a `Bin` so the digit always
  receives an allocation and no longer collapses to an empty dot.

## [1.0.0] - Initial release

- First release of the NotchNux GNOME Shell extension: a dynamic pill-shaped
  notch and dashboard panel for media, system monitoring, weather, a files
  shelf, and connected devices.
