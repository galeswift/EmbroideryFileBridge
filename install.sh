#!/bin/bash
#
# One-shot installer for the embroidery file bridge. Run this on the
# Raspberry Pi Zero itself, from within a clone of this repository:
#
#   sudo ./install.sh
#
# Installs packages, sets the Pi's USB port up to act as a USB flash
# drive, and installs the drive manager, web UI and their systemd units.
# Idempotent -- safe to re-run (e.g. after pulling updates).
#
# By default the library and web UI belong to whichever user invoked
# sudo. To use a different account:
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

ROOT=/srv/embroidery
STAGING_DIR=$ROOT/incoming
STATUS_DIR=$ROOT/.sync-status
PREVIEW_DIR=$ROOT/.previews
REQUEST_DIR=$ROOT/.requests
UPLOAD_TMP=$ROOT/.upload-tmp
APP_DIR=/opt/embroidery-bridge
CONFIG=/boot/firmware/config.txt
PYEMBROIDERY_VERSION=1.5.1

echo "==> Installing packages"
apt-get update
apt-get install -y python3-flask python3-venv mtools dosfstools fdisk

echo "==> Creating the library folders"
mkdir -p "$STAGING_DIR" "$STATUS_DIR" "$PREVIEW_DIR" "$REQUEST_DIR" "$UPLOAD_TMP"
chown "$TARGET_USER:$TARGET_GROUP" "$STAGING_DIR" "$PREVIEW_DIR" "$REQUEST_DIR" "$UPLOAD_TMP"
chown -R "$TARGET_USER:$TARGET_GROUP" "$STATUS_DIR"

echo "==> Removing the old PC-link sync, if present"
# Earlier versions wrote to the machine's "PC link" RAM disk through its
# USB-B port. The Pi now acts as a USB flash drive instead.
systemctl disable --now embroidery-sync.timer embroidery-sync.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/embroidery-sync.service /etc/systemd/system/embroidery-sync.timer \
      /etc/udev/rules.d/99-embroidery-bridge.rules \
      /usr/local/bin/embroidery-sync.sh /usr/local/bin/embroidery-web.py
udevadm control --reload-rules || true
rmdir /mnt/machine 2>/dev/null || true

echo "==> Installing the drive manager and web UI"
install -d -m 755 "$APP_DIR" "$APP_DIR/web"
install -m 755 "$SCRIPT_DIR/embroidery-drive.py" "$APP_DIR/embroidery-drive.py"
install -m 755 "$SCRIPT_DIR/embroidery-web.py" "$APP_DIR/embroidery-web.py"
install -m 644 "$SCRIPT_DIR"/web/* "$APP_DIR/web/"

# Design previews use pyembroidery, which isn't packaged for apt. Give it
# a venv that still sees apt's Flask. Previews are optional: without
# network access this step fails and the UI shows file-type icons instead.
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    python3 -m venv --system-site-packages "$APP_DIR/venv"
fi
if ! "$APP_DIR/venv/bin/pip" install --disable-pip-version-check -q "pyembroidery==$PYEMBROIDERY_VERSION"; then
    echo "    (couldn't install pyembroidery; design previews will be unavailable)"
fi

echo "==> Setting the USB port up to act as a flash drive"
REBOOT_NEEDED=0
if ! grep -qx 'dtoverlay=dwc2' "$CONFIG"; then
    cp "$CONFIG" "$CONFIG.before-embroidery-bridge"
    printf '\n[all]\n# Embroidery bridge: USB port acts as a flash drive for the machine\ndtoverlay=dwc2\n' >> "$CONFIG"
    REBOOT_NEEDED=1
fi
if ! [ -d /sys/class/udc ] || [ -z "$(ls /sys/class/udc 2>/dev/null)" ]; then
    REBOOT_NEEDED=1
fi

echo "==> Installing systemd units"
for unit in embroidery-drive.service embroidery-drive.timer embroidery-drive.path; do
    install -m 644 "$SCRIPT_DIR/$unit" "/etc/systemd/system/$unit"
done
sed "s/__TARGET_USER__/$TARGET_USER/" "$SCRIPT_DIR/embroidery-web.service" > /etc/systemd/system/embroidery-web.service
systemctl daemon-reload
systemctl enable --now embroidery-drive.timer embroidery-drive.path embroidery-web.service
# Pick up a new version when re-running the installer after an update.
systemctl restart embroidery-web.service
echo "    Building the USB drive from the library..."
systemctl start embroidery-drive.service || echo "    (drive update failed; see: journalctl -t embroidery-drive)"

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

==> Done.

Library:  $STAGING_DIR (owned by $TARGET_USER)
Web UI:   http://$(hostname).local:8080${PI_IP:+  (or http://$PI_IP:8080)}

Connect the Pi's "USB" port (not PWR) to the machine's USB-A (flash
drive) port with a micro-USB to USB-A data cable, and keep the Pi's own
power adapter in PWR. On the machine, use the USB flash drive button.

Watch drive updates with:  journalctl -t embroidery-drive -f
EOF

if [ "$REBOOT_NEEDED" -eq 1 ]; then
    cat <<EOF

*** Reboot needed to switch the USB port into flash-drive mode: sudo reboot
EOF
fi
