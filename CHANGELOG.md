# Changelog

All notable changes to NotchNux are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
