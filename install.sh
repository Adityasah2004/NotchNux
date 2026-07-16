#!/usr/bin/env bash
#
# NotchNux installer
# A dynamic pill-shaped Notch and dashboard for GNOME Shell.
#
set -euo pipefail

UUID="notchnux@adityasah.programs"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- pretty output -------------------------------------------------------
if [[ -t 1 ]]; then
    BOLD=$'\e[1m'; DIM=$'\e[2m'; RESET=$'\e[0m'
    CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; BLUE=$'\e[34m'
else
    BOLD=''; DIM=''; RESET=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; BLUE=''
fi

info()  { printf '  %s•%s %s\n' "$CYAN" "$RESET" "$1"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
step()  { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }

banner() {
cat <<EOF

   ${DIM}╭────────────${RESET}${CYAN}${BOLD} ▪▪▪▪ ${RESET}${DIM}────────────╮${RESET}
   ${BOLD}${CYAN}     N O T C H N U X${RESET}
   ${DIM}A dynamic Notch & dashboard for GNOME Shell${RESET}
EOF
}

# ---- checks --------------------------------------------------------------
check_env() {
    step "Checking environment"

    if ! command -v gnome-shell >/dev/null 2>&1; then
        fail "gnome-shell not found — NotchNux is a GNOME Shell extension."
        exit 1
    fi
    local ver
    ver="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '?')"
    ok "GNOME Shell ${ver} detected"

    if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
        info "Session: Wayland (a full log out / log in is needed to reload the shell)"
    else
        info "Session: ${XDG_SESSION_TYPE:-unknown}"
    fi

    # Optional runtime deps — warn, don't block.
    local missing=()
    command -v gnome-extensions >/dev/null 2>&1 || missing+=("gnome-extensions (gnome-shell-extensions)")
    pkg-config --exists gstreamer-1.0 2>/dev/null || missing+=("GStreamer 1.0 (Studio webcam/recording tab)")
    if ((${#missing[@]})); then
        for m in "${missing[@]}"; do warn "optional: $m not found"; done
    fi
}

# ---- install -------------------------------------------------------------
install_files() {
    step "Installing to ${DIM}${DEST_DIR}${RESET}"

    mkdir -p "$DEST_DIR"
    rm -rf "${DEST_DIR:?}"/*

    install -Dm644 "$SRC_DIR/metadata.json"  "$DEST_DIR/metadata.json"
    install -Dm644 "$SRC_DIR/extension.js"   "$DEST_DIR/extension.js"
    install -Dm644 "$SRC_DIR/prefs.js"       "$DEST_DIR/prefs.js"
    install -Dm644 "$SRC_DIR/stylesheet.css" "$DEST_DIR/stylesheet.css"
    cp -r "$SRC_DIR/src" "$DEST_DIR/"

    ok "Extension files copied"
}

enable_ext() {
    step "Enabling extension"
    if command -v gnome-extensions >/dev/null 2>&1; then
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            ok "Enabled $UUID"
        else
            warn "Could not auto-enable yet — reload the shell first, then run:"
            printf '      %sgnome-extensions enable %s%s\n' "$DIM" "$UUID" "$RESET"
        fi
    else
        warn "gnome-extensions CLI unavailable — enable it from the Extensions app."
    fi
}

# ---- go ------------------------------------------------------------------
banner
check_env
install_files
enable_ext

step "${GREEN}Done!${RESET}"
cat <<EOF
  ${BOLD}Next step — reload GNOME Shell so it picks up NotchNux:${RESET}
    ${DIM}• Wayland:${RESET} log out and back in
    ${DIM}• X11:${RESET}     press ${BOLD}Alt+F2${RESET}, type ${BOLD}r${RESET}, press Enter

  ${BOLD}Test safely in a nested session (no logout needed):${RESET}
    ${DIM}dbus-run-session -- gnome-shell --nested --wayland${RESET}

  Click the pill to open the dashboard. Enjoy! ${CYAN}▪▪▪▪${RESET}
EOF
