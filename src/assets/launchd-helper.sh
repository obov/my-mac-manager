#!/bin/sh
# /usr/local/libexec/__ID__-launchd (root:wheel 755). sudoers lets the calling user run it without a password.
#
#   promote <label>   ~/Library/LaunchAgents/<label>.plist → /Library/LaunchDaemons (UserName = calling user)
#                     the GUI agent is booted out and disabled. Run again after a deploy changes the agent plist to sync
#   demote <label>    undo: remove the daemon, enable + bootstrap the GUI agent
#   start|stop|restart|run <label>
#
# Safety
#   - daemons always run as the calling user (SUDO_USER). UserName/GroupName/root in the plist are ignored → no privilege escalation
#   - everything except promote only touches daemons with __MARKER__=true (other system daemons such as tailscale are off limits)
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin

die() { echo "__ID__-launchd: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root (sudo)"
U=${SUDO_USER:-}
[ -n "$U" ] && [ "$U" != root ] || die "must be called via sudo from a regular user"
UID_=$(id -u "$U")
H=$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')
ACT=${1:-}; L=${2:-}
echo "$L" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]+$' || die "invalid label: $L"
SRC="$H/Library/LaunchAgents/$L.plist"
DST="/Library/LaunchDaemons/$L.plist"

managed() {
    [ -f "$DST" ] && [ "$(plutil -extract __MARKER__ raw -o - "$DST" 2>/dev/null)" = true ] || die "$L: not a daemon managed by m3"
}
loaded() { launchctl print "system/$L" >/dev/null 2>&1; }
gui_loaded() { launchctl print "gui/$UID_/$L" >/dev/null 2>&1; }
# bootout is async: wait until slow jobs (e.g. the colima VM) are gone (up to 120s)
unload_system() { loaded || return 0; launchctl bootout "system/$L" 2>/dev/null || true
    i=0; while loaded && [ $i -lt 120 ]; do sleep 1; i=$((i + 1)); done; ! loaded || die "$L: timed out unloading from system"; }
unload_gui() { gui_loaded || return 0; launchctl bootout "gui/$UID_/$L" 2>/dev/null || true
    i=0; while gui_loaded && [ $i -lt 120 ]; do sleep 1; i=$((i + 1)); done; ! gui_loaded || die "$L: timed out unloading from gui"; }

case "$ACT" in
promote)
    [ -f "$SRC" ] || die "$SRC not found"
    if [ -f "$DST" ] && [ "$(plutil -extract __MARKER__ raw -o - "$DST" 2>/dev/null)" != true ]; then
        die "$DST is not managed by m3"
    fi
    T=$(mktemp)
    cp "$SRC" "$T"
    plutil -convert xml1 "$T"
    for k in UserName GroupName InitGroups LimitLoadToSessionType; do plutil -remove "$k" "$T" 2>/dev/null || true; done
    plutil -replace UserName -string "$U" "$T"
    plutil -replace GroupName -string staff "$T"
    plutil -replace InitGroups -bool true "$T"
    plutil -replace __MARKER__ -bool true "$T"
    plutil -extract EnvironmentVariables raw -o - "$T" >/dev/null 2>&1 || plutil -insert EnvironmentVariables -dictionary "$T"
    plutil -replace EnvironmentVariables.HOME -string "$H" "$T"
    plutil -replace EnvironmentVariables.USER -string "$U" "$T"
    plutil -replace EnvironmentVariables.LOGNAME -string "$U" "$T"
    plutil -extract EnvironmentVariables.PATH raw -o - "$T" >/dev/null 2>&1 || \
        plutil -replace EnvironmentVariables.PATH -string "$H/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$T"
    plutil -lint "$T" >/dev/null
    unload_gui
    # without a GUI login (right after a reboot) there is no gui domain to disable → warn and continue (earlier disable state persists)
    launchctl disable "gui/$UID_/$L" 2>/dev/null || echo "__ID__-launchd: warning: no gui/$UID_ (no GUI login), skipped disabling agent $L" >&2
    unload_system
    install -o root -g wheel -m 644 "$T" "$DST"
    rm -f "$T"
    launchctl bootstrap system "$DST"
    echo "promoted $L → system (user $U)"
    ;;
demote)
    managed
    unload_system
    rm -f "$DST"
    launchctl enable "gui/$UID_/$L"
    [ -f "$SRC" ] && launchctl bootstrap "gui/$UID_" "$SRC" 2>/dev/null || true
    echo "demoted $L → gui"
    ;;
start)   managed; loaded || launchctl bootstrap system "$DST" ;;   # starts per RunAtLoad (does not run a job immediately)
stop)    managed; unload_system ;;
restart) managed; if loaded; then launchctl kickstart -k "system/$L"; else launchctl bootstrap system "$DST"; fi ;;
run)     managed; launchctl kickstart "system/$L" ;;
*) die "usage: __ID__-launchd promote|demote|start|stop|restart|run <label>" ;;
esac
