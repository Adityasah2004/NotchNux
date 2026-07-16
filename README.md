<div align="center">

# NotchNux

### A dynamic, macOS-style **Notch** and dashboard for GNOME Shell

A pill that lives at the top of your screen, morphs to show what you're doing, and expands into a full glassy dashboard for music, weather, your webcam, calendar, notifications and a file shelf.

![NotchNux collapsed pill](assets/pill-collapsed.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-7aa2ff.svg)](LICENSE)
![GNOME Shell 45–51](https://img.shields.io/badge/GNOME%20Shell-45%20→%2051-4a90d9.svg)
![Wayland & X11](https://img.shields.io/badge/Wayland%20%26%20X11-supported-32b76c.svg)

</div>

---

## ✨ What is it?

NotchNux replaces the default GNOME top-bar clock with a **living pill**. At a glance it shows the date, time, battery and privacy (mic/camera) indicators. While music plays, the track title scrolls across it. When a notification arrives, the pill **morphs into a banner** with action buttons. Click it and it opens into a **tabbed dashboard** — a little control center that follows your accent color.



## 🧩 Features

| | Feature | What it does |
|---|---|---|
| 🎵 | **Music / MPRIS** | Full player with album art, a spinning vinyl, scrubber, shuffle/repeat, and a volume dial — works with any MPRIS player (Spotify, browsers, etc.). |
| 🌤️ | **Weather** | Current conditions, an analog clock, humidity, wind, sunrise/sunset and hourly forecast. Auto-locates or set a manual location. |
| 📷 | **Studio** | Live webcam preview (GStreamer) plus video and audio-only recording, with camera/mic device selection. |
| 📅 | **Calendar** | A scrollable day strip with your events pulled from GNOME Online Accounts — scroll the dates to jump between days. |
| 🔔 | **Alerts** | Notification history, and a **peek** mode where the pill expands into a banner with action buttons the moment a notification arrives. |
| 🗂️ | **Shelf** | A click-to-browse / paste-a-file scratch space, plus **Quick Share** to send files to your phone and other paired [GSConnect](https://github.com/GSConnect/gnome-shell-extension-gsconnect) devices. |
| 🖥️ | **Tray / System** | Live CPU, memory, swap, disk and network throughput; connected-device battery levels; and quick toggles for sound, screenshot, airplane mode, focus and screen lock. |
| 🎨 | **Theming** | Pick any accent color — the whole UI, dials and highlights recolor live. Reorder or hide dashboard tabs, and toggle individual features on/off, from a **native preferences window**. |

### Collapsed pill indicators
- 📆 Date & time (pill sizes to its content so the clock never truncates)
- 🔋 Battery percentage & charging state
- 🎤/📷 Privacy dots when the mic or camera is in use
- 🎶 Scrolling now-playing title while media is active

## 🖼️ Screenshots

<div align="center">

**Music** — vinyl art, scrubber, shuffle/repeat and a volume dial
![Music dashboard](assets/music.png)

**Weather** — analog clock, current conditions and details
![Weather dashboard](assets/weather.png)

**Tray / System** — live CPU · RAM · swap · disk · network meters, device battery levels, and quick toggles
![Tray dashboard](assets/tray.png)

**Calendar** — a scrollable day strip with your GNOME Online Accounts events
![Calendar dashboard](assets/calendar.png)

**Alerts** — grouped notification history with a live unread count
![Alerts dashboard](assets/alerts.png)

**Shelf** — a click-to-browse / paste-a-file zone with Quick Share to paired devices
![Shelf dashboard](assets/shelf.png)

**Studio** — live webcam preview plus camera & audio recording
![Studio dashboard](assets/studio.png)

**Notification peek** — the pill smoothly expands into a banner with actions
![Notification peek](assets/peek-screenshot.png)

**Preferences** — a native GTK/libadwaita settings window for accent, tabs and features
![Preferences window](assets/preferences.png)

</div>

## 📦 Installation

### Requirements
- **GNOME Shell 45 – 51** (Wayland or X11)
- `gnome-shell-extensions` (for the `gnome-extensions` CLI)
- **Optional:** GStreamer 1.0 (`gstreamer1-plugins-*` / `gstreamer1.0-plugins-*`) for the Studio webcam & recording tab

On **Fedora**:
```bash
sudo dnf install gnome-shell-extensions gstreamer1-plugins-good gstreamer1-plugins-bad-free
```

On **Ubuntu / Debian**:
```bash
sudo apt install gnome-shell-extensions gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
```

### Install from source
```bash
git clone https://github.com/Adityasah2004/NotchNux.git
cd NotchNux
./install.sh
```

Then **reload GNOME Shell** so it loads the extension:
- **Wayland:** log out and log back in
- **X11:** press `Alt`+`F2`, type `r`, press `Enter`

The installer auto-enables the extension. If it couldn't, enable it manually:
```bash
gnome-extensions enable notchnux@adityasah.programs
```

### Try it without reloading your session
Run it in a nested GNOME session so nothing touches your real desktop:
```bash
dbus-run-session -- gnome-shell --nested --wayland
```

## 🕹️ Usage

- **Click the pill** to open the dashboard; click outside (or the pill) to collapse it.
- **Switch tabs** with the carousel at the top of the dashboard.
- **Open preferences** (⚙️ in the dashboard, or `gnome-extensions prefs notchnux@adityasah.programs`) to change the accent color, reorder or hide tabs, and toggle features. Changes apply to the live notch instantly — no shell reload needed.

Configuration is stored as plain JSON under `~/.config/notchnux/config.json` — no GSettings schema required. The preferences window and the running notch share this file, so edits made in either place take effect immediately.

## ⚙️ Configuration & data locations

| Path | Contents |
|---|---|
| `~/.config/notchnux/config.json` | Accent color, tab order & visibility, feature toggles |
| `~/.config/notchnux/settings.json` | Manual weather location |
| `~/.local/share/notchnux/shelf/` | Files added to the Shelf |

> **Quick Share** sends files through the [GSConnect](https://github.com/GSConnect/gnome-shell-extension-gsconnect) extension. Install and pair a device in GSConnect to send files to your phone from the Shelf. Pasting a copied file into the Shelf uses `wl-clipboard` (`wl-paste`) on Wayland.

## 🐛 Troubleshooting

- **Nothing appears after install** → you must reload the shell (log out/in on Wayland). Confirm it's enabled: `gnome-extensions info notchnux@adityasah.programs`.
- **Studio tab is empty / no webcam** → install the GStreamer plugins listed above.
- **Check logs** while it runs:
  ```bash
  journalctl -f -o cat /usr/bin/gnome-shell
  ```

## 🤝 Contributing

This is a young project and **help is very welcome** — bug reports, feature ideas, theming tweaks, and PRs all make it better. If you're on Fedora (or any GNOME distro) and try it out, please open an issue with what worked and what didn't. 🙏

1. Fork the repo and create a branch.
2. Make your change and test it in a nested session.
3. Open a pull request describing what you changed and why.

## 📄 License

Released under the [MIT License](LICENSE). © 2026 Aditya Sah.
