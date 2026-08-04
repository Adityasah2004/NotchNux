# Changelog

All notable changes to NotchNux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
