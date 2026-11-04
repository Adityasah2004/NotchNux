#!/bin/sh
# NotchNux fan control (beta): one-time setup. NotchNux never runs this; you
# do, once, so the Tray tab can set the fan level without a password.
#
#   sudo sh fan-setup.sh                 set up (with the ThinkPad fan watchdog)
#   sudo sh fan-setup.sh --no-watchdog   set up, leave the watchdog alone
#   sudo sh fan-setup.sh --remove        undo
#
# What it changes:
#   /etc/udev/rules.d/90-notchnux-fan.rules
#       Gives your user the fan chip's pwmN and pwmN_enable files (hwmon).
#       On ThinkPads it also sets the firmware's fan watchdog to 120 s: a
#       manual level that nobody re-sends for 2 minutes goes back to Auto
#       (NotchNux re-sends every minute, so a crash can't leave the fan off).
#       Note: that applies to manual levels set any other way too, e.g.
#       `echo level 0 > /proc/acpi/ibm/fan` now lasts 2 minutes.
#   /etc/modprobe.d/notchnux-fan.conf
#       Only on a ThinkPad with fan_control off: turns it on (needs a reboot).
#
# Undo by hand (what --remove does):
#   rm /etc/udev/rules.d/90-notchnux-fan.rules /etc/modprobe.d/notchnux-fan.conf
#   udevadm control --reload
#   chown root /sys/class/hwmon/hwmon*/pwm[0-9]*          (or reboot)
#   echo 0 > /sys/bus/platform/drivers/thinkpad_hwmon/fan_watchdog
set -eu

RULE=/etc/udev/rules.d/90-notchnux-fan.rules
MODCONF=/etc/modprobe.d/notchnux-fan.conf
WATCHDOG_FILE=/sys/bus/platform/drivers/thinkpad_hwmon/fan_watchdog

die() { echo "fan-setup: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo"

if [ "${1:-}" = "--remove" ]; then
    rm -f "$RULE" "$MODCONF"
    udevadm control --reload
    for f in /sys/class/hwmon/hwmon*/pwm[0-9] /sys/class/hwmon/hwmon*/pwm[0-9]_enable; do
        if [ -e "$f" ]; then chown root:root "$f"; fi
    done
    if [ -w "$WATCHDOG_FILE" ]; then echo 0 > "$WATCHDOG_FILE"; fi
    echo "Removed. The fan files are root-only again and the watchdog is off."
    exit 0
fi
WATCHDOG=yes
case ${1:-} in
    '') ;;
    --no-watchdog) WATCHDOG=no ;;
    *) die "unknown option: $1" ;;
esac

USER_NAME=${SUDO_USER:-}
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || die "run it with sudo from your own account (SUDO_USER is empty)"
case $USER_NAME in *[!A-Za-z0-9_.-]*) die "unexpected user name: $USER_NAME" ;; esac

# The first chip, in hwmon number order, with a pwm that can go back to auto
# (the one NotchNux picks, helpers/sensors.js pickFan).
CHIP=
for d in $(ls -d /sys/class/hwmon/hwmon* 2>/dev/null | sort -V); do
    for p in "$d"/pwm[0-9]; do
        if [ -e "$p" ] && [ -e "${p}_enable" ]; then
            CHIP=$d
            PWM=$(basename "$p")
            break 2
        fi
    done
done
[ -n "$CHIP" ] || die "no fan here that software can control (no pwmN with pwmN_enable under /sys/class/hwmon)"
NAME=$(cat "$CHIP/name")
case $NAME in *[!A-Za-z0-9_.-]*|'') die "unexpected chip name: '$NAME'" ;; esac

EXTRA=
REBOOT=no
if [ "$NAME" = thinkpad ]; then
    if [ "$WATCHDOG" = yes ]; then EXTRA="; echo 120 > $WATCHDOG_FILE"; fi
    if [ "$(cat /sys/module/thinkpad_acpi/parameters/fan_control 2>/dev/null || echo N)" != Y ]; then
        echo 'options thinkpad_acpi fan_control=1' > "$MODCONF"
        REBOOT=yes
    fi
fi

cat > "$RULE" <<EOF
# NotchNux fan control (beta), written by fan-setup.sh. Undo: sudo sh fan-setup.sh --remove
ACTION=="add", SUBSYSTEM=="hwmon", ATTR{name}=="$NAME", RUN+="/bin/sh -c 'chown $USER_NAME /sys%p/pwm[0-9] /sys%p/pwm[0-9]_enable$EXTRA'"
EOF
udevadm control --reload
udevadm trigger --action=add --subsystem-match=hwmon --attr-match=name="$NAME"
udevadm settle

if [ "$REBOOT" = yes ]; then
    echo "Done. Reboot once: thinkpad_acpi needs fan_control=1 before the fan can be set."
    exit 0
fi
for f in "$CHIP/$PWM" "$CHIP/${PWM}_enable"; do
    runuser -u "$USER_NAME" -- test -w "$f" || die "$f still isn't writable by $USER_NAME (rule: $RULE)"
done
if [ -n "$EXTRA" ] && [ "$(cat "$WATCHDOG_FILE")" != 120 ]; then
    echo "fan-setup: note: the ThinkPad fan watchdog didn't turn on ($WATCHDOG_FILE)" >&2
fi
echo "Done: $USER_NAME can set the $NAME fan ($CHIP/$PWM). Turn on Fan control (beta) in NotchNux Preferences."
