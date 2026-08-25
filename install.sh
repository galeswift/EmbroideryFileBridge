#!/bin/bash
#
# One-shot installer for the embroidery file bridge. Run this on the
# Raspberry Pi itself, from within a clone of this repository:
#
#   sudo ./install.sh
#
# Installs packages, creates the staging directory, and installs the
# sync script, web UI, systemd units, and udev rule. Idempotent --
# safe to re-run (e.g. after pulling updates).
#
# By default the staging directory and web UI run as whichever user
# invoked sudo. To use a different account:
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
STATUS_DIR=/srv/embroidery/.sync-status
MOUNT_POINT=/mnt/machine

echo "==> Installing packages (eject, python3-flask)"
apt-get update
apt-get install -y eject python3-flask

echo "==> Creating staging directory and machine mount point"
mkdir -p "$STAGING_DIR" "$STATUS_DIR" "$MOUNT_POINT"
chown "$TARGET_USER:$TARGET_GROUP" "$STAGING_DIR" "$STATUS_DIR"

echo "==> Installing sync script"
install -m 755 "$SCRIPT_DIR/embroidery-sync.sh" /usr/local/bin/embroidery-sync.sh

echo "==> Installing web UI"
install -m 755 "$SCRIPT_DIR/embroidery-web.py" /usr/local/bin/embroidery-web.py

echo "==> Installing systemd units"
install -m 644 "$SCRIPT_DIR/embroidery-sync.service" /etc/systemd/system/embroidery-sync.service
install -m 644 "$SCRIPT_DIR/embroidery-sync.timer" /etc/systemd/system/embroidery-sync.timer
sed "s/__TARGET_USER__/$TARGET_USER/" "$SCRIPT_DIR/embroidery-web.service" > /etc/systemd/system/embroidery-web.service
systemctl daemon-reload
systemctl enable --now embroidery-sync.timer embroidery-web.service

echo "==> Installing udev rule"
install -m 644 "$SCRIPT_DIR/99-embroidery-bridge.rules" /etc/udev/rules.d/99-embroidery-bridge.rules
udevadm control --reload-rules

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

==> Done.

Staging directory: $STAGING_DIR (owned by $TARGET_USER)
Web UI:             http://$(hostname).local:8080${PI_IP:+  (or http://$PI_IP:8080)}

Next steps:
  1. From your PC/Mac/phone, open the web UI above and upload a
     design file.
  2. Plug the USB cable into the embroidery machine and power it on.
     Files sync automatically within a few seconds.
  3. Watch sync activity with:  journalctl -t embroidery-sync -f
EOF
