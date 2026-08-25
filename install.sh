#!/bin/bash
#
# One-shot installer for the embroidery file bridge. Run this on the
# Raspberry Pi itself, from within a clone of this repository:
#
#   sudo ./install.sh
#
# Installs packages, creates the staging directory, and installs the
# sync script, systemd units, udev rule, and Samba config. Idempotent
# -- safe to re-run (e.g. after pulling updates).
#
# By default the staging directory and Samba share are owned by
# whichever user invoked sudo. To use a different account:
#
#   sudo TARGET_USER=someuser ./install.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this with sudo: sudo $0" >&2
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer expects a Debian/Raspberry Pi OS system (apt-get not found)." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_USER="${TARGET_USER:-${SUDO_USER:-pi}}"
if ! id "$TARGET_USER" >/dev/null 2>&1; then
    echo "User '$TARGET_USER' doesn't exist on this system." >&2
    echo "Set TARGET_USER=<existing user> and re-run, e.g.:" >&2
    echo "  sudo TARGET_USER=$(logname 2>/dev/null || echo youruser) $0" >&2
    exit 1
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"

STAGING_DIR=/srv/embroidery/incoming
MOUNT_POINT=/mnt/machine

echo "==> Installing packages (samba, eject)"
apt-get update
apt-get install -y samba eject

echo "==> Creating staging directory and machine mount point"
mkdir -p "$STAGING_DIR" "$MOUNT_POINT"
chown "$TARGET_USER:$TARGET_GROUP" "$STAGING_DIR"

echo "==> Installing sync script"
install -m 755 "$SCRIPT_DIR/embroidery-sync.sh" /usr/local/bin/embroidery-sync.sh

echo "==> Installing systemd units"
install -m 644 "$SCRIPT_DIR/embroidery-sync.service" /etc/systemd/system/embroidery-sync.service
install -m 644 "$SCRIPT_DIR/embroidery-sync.timer" /etc/systemd/system/embroidery-sync.timer
systemctl daemon-reload
systemctl enable --now embroidery-sync.timer

echo "==> Installing udev rule"
install -m 644 "$SCRIPT_DIR/99-embroidery-bridge.rules" /etc/udev/rules.d/99-embroidery-bridge.rules
udevadm control --reload-rules

echo "==> Installing Samba config"
if [ -f /etc/samba/smb.conf ] && ! cmp -s "$SCRIPT_DIR/smb.conf" /etc/samba/smb.conf; then
    backup="/etc/samba/smb.conf.bak.$(date +%Y%m%d%H%M%S)"
    cp /etc/samba/smb.conf "$backup"
    echo "    (existing smb.conf backed up to $backup)"
fi
sed -e "s/^\( *force user = \).*/\1$TARGET_USER/" \
    -e "s/^\( *force group = \).*/\1$TARGET_GROUP/" \
    "$SCRIPT_DIR/smb.conf" > /etc/samba/smb.conf
systemctl restart smbd

cat <<EOF

==> Done.

Staging directory: $STAGING_DIR (owned by $TARGET_USER)
Samba share:        \\\\$(hostname)\\machine

Next steps:
  1. From your PC/Mac, connect to the "machine" share on this Pi and
     drop a design file in.
  2. Plug the USB cable into the embroidery machine and power it on.
     Files sync automatically within a few seconds.
  3. Watch sync activity with:  journalctl -t embroidery-sync -f
EOF
