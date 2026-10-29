#!/bin/sh
# Host settings check / apply. m3 host plan|apply uploads this to ~/<M3_DIR>/ and runs it.
#   sh host-settings.sh plan                                check only (no sudo)
#   sudo M3_ID=m3 M3_HOSTNAME=x sh host-settings.sh apply   apply what differs
# User additions: the M3_EXTRA file is sourced at the end (check / note / ok available)
set -u
MODE=${1:-plan}
[ "$MODE" = apply ] && [ "$(id -u)" != 0 ] && { echo "apply needs sudo"; exit 1; }
U=${SUDO_USER:-$(id -un)}
H=$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')
ID=${M3_ID:-m3}
M3=$H/${M3_DIR:-.local/share/$ID}
HELPER=/usr/local/libexec/$ID-launchd
DIFF=0

# check <name> <current> <wanted> <apply command>
check() {
    if [ "$2" = "$3" ]; then
        printf '  o %-28s %s\n' "$1" "$2"
    else
        DIFF=$((DIFF + 1))
        printf '  x %-28s %s → %s\n' "$1" "${2:-none}" "$3"
        if [ "$MODE" = apply ]; then
            if sh -c "$4" >/dev/null 2>&1; then echo "      applied"; else echo "      apply failed: $4"; fi
        fi
    fi
}
note() { printf '  ! %-28s %s\n' "$1" "$2"; }
ok() { printf '  o %-28s %s\n' "$1" "$2"; }
pm() { pmset -g custom | awk -v k="$1" '/AC Power/{a=1} a && $1==k {print $2; exit}'; }
port() { nc -z -G 2 127.0.0.1 "$1" >/dev/null 2>&1 && echo on || echo off; }

echo "host settings ($MODE)"
if [ -n "${M3_HOSTNAME:-}" ]; then
    check hostname "$(scutil --get LocalHostName)" "$M3_HOSTNAME" \
        "scutil --set ComputerName $M3_HOSTNAME && scutil --set LocalHostName $M3_HOSTNAME && scutil --set HostName $M3_HOSTNAME"
fi

# power: never sleep, boot after power loss, wake on network
check "pmset sleep"        "$(pm sleep)"        0 "pmset -a sleep 0"
check "pmset autorestart"  "$(pm autorestart)"  1 "pmset -a autorestart 1"
check "pmset womp"         "$(pm womp)"         1 "pmset -a womp 1"
check "pmset tcpkeepalive" "$(pm tcpkeepalive)" 1 "pmset -a tcpkeepalive 1"

# remote access: SSH (FileVault remote unlock), Screen Sharing (GUI login)
check "remote login (ssh:22)" "$(port 22)"   on "systemsetup -f -setremotelogin on || launchctl load -w /System/Library/LaunchDaemons/ssh.plist"
check "screen sharing (vnc:5900)" "$(port 5900)" on "launchctl enable system/com.apple.screensharing && launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist"

# no automatic macOS installs (avoid unattended reboots). Downloads stay on
cur=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo 1)
check "macOS auto install" "$cur" 0 "defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false"

# LaunchDaemon helper + sudoers (control LaunchDaemons without a password)
want=$(shasum -a 256 "$M3/$ID-launchd" 2>/dev/null | cut -c1-12)
have=$(shasum -a 256 "$HELPER" 2>/dev/null | cut -c1-12)
check "$ID-launchd helper" "$have" "$want" "mkdir -p /usr/local/libexec && install -o root -g wheel -m 755 '$M3/$ID-launchd' $HELPER"
rule="$U ALL=(root) NOPASSWD: $HELPER *"
if [ -r "/etc/sudoers.d/$ID" ]; then
    cur=$( [ "$(cat "/etc/sudoers.d/$ID")" = "$rule" ] && echo ok || echo diff)
else  # plan (not root): file is 0440 → check whether sudo allows it
    cur=$(sudo -n -l "$HELPER" x >/dev/null 2>&1 && echo ok || echo diff)
fi
check "sudoers $ID"          "$cur" ok \
    "T=\$(mktemp) && echo '$rule' > \$T && visudo -cf \$T && install -o root -g wheel -m 440 \$T /etc/sudoers.d/$ID"

# report only (never applied automatically)
fv=$(fdesetup status | head -1)
case "$fv" in *On*) ok FileVault "on (after a reboot unlock over SSH with m3 unlock)";;
              *) note FileVault "off → manually: sudo fdesetup enable (store the recovery key safely)";; esac

if [ -n "${M3_EXTRA:-}" ] && [ -f "$M3/$M3_EXTRA" ]; then
    . "$M3/$M3_EXTRA"
fi

echo
if [ "$DIFF" = 0 ]; then echo "no differences"
elif [ "$MODE" = plan ]; then echo "${DIFF} differences → m3 host apply"
else echo "${DIFF} items applied (verify: m3 host plan)"; fi
