#!/bin/bash
#
# Pushes any files sitting in the persistent staging directory onto the
# embroidery machine's USB mass-storage volume, if and only if the
# machine is currently connected and powered on. Mounts, copies,
# flushes, and unmounts immediately, so the window in which the volume
# is mounted (and therefore vulnerable to a mid-write power-off) is as
# short as possible.
#
# Some embroidery machines only hold newly-written files in a volatile
# scratch buffer while in USB-connect mode, and quietly drop them on
# their own power cycle without ever corrupting the FAT table (so the
# file looks fine right up until the machine is restarted). Because of
# that, "the file is already on the machine" is not trusted purely by
# name -- size is checked too, and anything missing or size-mismatched
# gets re-copied. The staging directory (not the machine) is the
# durable source of truth, so this is safe to re-run indefinitely.
#
# Designed to be run either:
#   - on-demand via udev when the machine's USB device appears, or
#   - periodically via embroidery-sync.timer, as a safety net.
#
# Run as root (needed to mount/umount).

set -euo pipefail

STAGING_DIR=/srv/embroidery/incoming
MOUNT_POINT=/mnt/machine
DEVICE=/dev/sda
LOCK_FILE=/run/embroidery-sync.lock

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

# Nothing to do if the machine isn't plugged in / powered on.
[ -b "$DEVICE" ] || exit 0

mkdir -p "$STAGING_DIR" "$MOUNT_POINT"

WE_MOUNTED=0
if ! mount | grep -q " on $MOUNT_POINT "; then
    if ! mount -o umask=0,flush,noatime "$DEVICE" "$MOUNT_POINT"; then
        logger -t embroidery-sync "failed to mount $DEVICE on $MOUNT_POINT"
        exit 1
    fi
    WE_MOUNTED=1
fi

shopt -s nullglob
for f in "$STAGING_DIR"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    dest="$MOUNT_POINT/$name"
    if [ -e "$dest" ] && [ "$(stat -c%s "$f")" -eq "$(stat -c%s "$dest")" ]; then
        continue
    fi
    tmp="$dest.partial"
    if cp --preserve=timestamps "$f" "$tmp"; then
        mv -f "$tmp" "$dest"
        sync
        logger -t embroidery-sync "copied $name to machine"
    else
        rm -f "$tmp"
        logger -t embroidery-sync "failed to copy $name to machine"
    fi
done

if [ "$WE_MOUNTED" -eq 1 ]; then
    sync
    umount "$MOUNT_POINT" || logger -t embroidery-sync "failed to unmount $MOUNT_POINT"
    # Best-effort: some machine firmware only reliably commits pending
    # writes to its real storage on a proper SCSI "stop unit" (safe to
    # remove) request rather than on a plain unmount. Send one if the
    # eject utility is available; harmless if it isn't.
    command -v eject >/dev/null 2>&1 && eject -s "$DEVICE" 2>/dev/null || true
fi
