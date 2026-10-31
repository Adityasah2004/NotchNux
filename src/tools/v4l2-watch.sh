# Report V4L2 camera use for NotchNux's privacy indicator.
#
# Many apps open /dev/video* directly instead of going through PipeWire, so
# PipeWire alone under-reports the camera. Polling `fuser` from inside
# gnome-shell meant a process spawn on the compositor thread every few
# seconds; this loop runs in its own process instead and prints "1" / "0"
# only when the state flips. It exits as soon as gnome-shell (its parent) is
# gone, or when the pipe closes.
parent=$PPID
last=
while kill -0 "$parent" 2>/dev/null; do
    set -- /dev/video*
    if [ -e "$1" ] && fuser "$@" >/dev/null 2>&1; then now=1; else now=0; fi
    if [ "$now" != "$last" ]; then
        echo "$now" || exit 0
        last=$now
    fi
    sleep 5
done
