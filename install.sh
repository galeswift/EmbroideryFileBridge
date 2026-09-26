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
PREVIEW_DIR=/srv/embroidery/.previews
MOUNT_POINT=/mnt/machine
APP_DIR=/opt/embroidery-bridge
PYEMBROIDERY_VERSION=1.5.1

echo "==> Installing packages (python3-flask, python3-venv)"
apt-get update
apt-get install -y python3-flask python3-venv

echo "==> Creating staging directory and machine mount point"
mkdir -p "$STAGING_DIR" "$STATUS_DIR" "$PREVIEW_DIR" "$MOUNT_POINT"
chown "$TARGET_USER:$TARGET_GROUP" "$STAGING_DIR" "$PREVIEW_DIR"
chown -R "$TARGET_USER:$TARGET_GROUP" "$STATUS_DIR"

echo "==> Installing sync script"
install -m 755 "$SCRIPT_DIR/embroidery-sync.sh" /usr/local/bin/embroidery-sync.sh

echo "==> Installing web UI"
install -d -m 755 "$APP_DIR" "$APP_DIR/web"
install -m 755 "$SCRIPT_DIR/embroidery-web.py" "$APP_DIR/embroidery-web.py"
install -m 644 "$SCRIPT_DIR"/web/* "$APP_DIR/web/"
# Earlier versions ran the web UI from here; the service no longer does.
rm -f /usr/local/bin/embroidery-web.py

# Design previews use pyembroidery, which isn't packaged for apt. Give it
# a venv that still sees apt's Flask. Previews are optional: without
# network access this step fails and the UI shows file-type icons instead.
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    python3 -m venv --system-site-packages "$APP_DIR/venv"
fi
if ! "$APP_DIR/venv/bin/pip" install --disable-pip-version-check -q "pyembroidery==$PYEMBROIDERY_VERSION"; then
    echo "    (couldn't install pyembroidery; design previews will be unavailable)"
fi

echo "==> Installing systemd units"
install -m 644 "$SCRIPT_DIR/embroidery-sync.service" /etc/systemd/system/embroidery-sync.service
install -m 644 "$SCRIPT_DIR/embroidery-sync.timer" /etc/systemd/system/embroidery-sync.timer
sed "s/__TARGET_USER__/$TARGET_USER/" "$SCRIPT_DIR/embroidery-web.service" > /etc/systemd/system/embroidery-web.service
systemctl daemon-reload
systemctl enable --now embroidery-sync.timer embroidery-web.service
# Pick up a new version when re-running the installer after an update.
systemctl restart embroidery-web.service

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
