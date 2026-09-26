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
# that, the staging directory (not the machine) is the durable source
# of truth, and this is safe to re-run indefinitely.
#
# Folders in the staging directory are mirrored onto the machine. After
# each successful copy, the size and mtime of the staged file that was
# copied are recorded in $STATUS_DIR/<path>. A file counts as synced
# only if that marker matches the staged file as it is now AND the
# machine has a same-size copy -- so a re-uploaded file always gets
# re-copied, even when the new version happens to be the same size.
#
# Two ways this gets run:
#   - by udev when the machine's USB device appears (plugged in or
#     powered on). udev also touches $FULL_CHECK_FLAG, which makes this
#     run check every staged file against the machine, since a machine
#     power-cycle can silently drop files it already had.
#   - every 60s by embroidery-sync.timer. Without the flag, it only
#     mounts the machine if some staged file hasn't been copied yet.
#
# Run as root (needed to mount/umount).

set -euo pipefail

# Overridable so the test suite can run against temporary directories.
STAGING_DIR=${EMBROIDERY_STAGING_DIR:-/srv/embroidery/incoming}
STATUS_DIR=${EMBROIDERY_STATUS_DIR:-/srv/embroidery/.sync-status}
STATE_FILE=${EMBROIDERY_STATE_FILE:-/srv/embroidery/.sync-state.json}
MOUNT_POINT=${EMBROIDERY_MOUNT_POINT:-/mnt/machine}
LOCK_FILE=${EMBROIDERY_LOCK_FILE:-/run/embroidery-sync.lock}
FULL_CHECK_FLAG=${EMBROIDERY_FULL_CHECK_FLAG:-/run/embroidery-sync.full-check}

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

log() { logger -t embroidery-sync "$*"; }

mkdir -p "$STAGING_DIR" "$STATUS_DIR" "$MOUNT_POINT"

# Every run unmounts on exit, so anything still mounted here was left
# behind by a run that was killed or lost power mid-sync. Clear it: a
# stale mount pins the old device node, and the machine would come back
# under a different name (sdb instead of sda).
if mountpoint -q "$MOUNT_POINT"; then
    log "clearing stale mount on $MOUNT_POINT"
    umount "$MOUNT_POINT" 2>/dev/null || umount -l "$MOUNT_POINT"
fi

# The machine is the USB-attached disk -- excluding the Pi's own boot
# disk, in case the Pi boots from USB. Set EMBROIDERY_DEVICE to override.
find_device() {
    local root_disk
    root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null || true)
    lsblk -dnro NAME,TRAN | awk -v r="$root_disk" '$2 == "usb" && $1 != r { print "/dev/" $1; exit }'
}
DEVICE=${EMBROIDERY_DEVICE:-$(find_device)}

# Nothing to do if the machine isn't plugged in / powered on.
[ -n "$DEVICE" ] && [ -e "$DEVICE" ] || exit 0

stamp() { stat -c '%s %Y' "$1"; }
marker_matches() { [ -f "$STATUS_DIR/$1" ] && [ "$(< "$STATUS_DIR/$1")" = "$2" ]; }

# Markers mirror the staging folder layout. The web UI (not root) deletes
# them when files are moved or removed, so keep them owned like STATUS_DIR.
write_marker() {
    local marker="$STATUS_DIR/$1"
    mkdir -p "$(dirname "$marker")"
    echo "$2" > "$marker"
    chown -R --reference="$STATUS_DIR" "$STATUS_DIR" 2>/dev/null || true
}

full_check=0
[ -e "$FULL_CHECK_FLAG" ] && full_check=1

# Staged files as paths relative to STAGING_DIR, including subfolders.
# Anything hidden (in-progress uploads are dotfiles) is skipped.
files=()
while IFS= read -r -d '' rel; do
    files+=("${rel#./}")
done < <(cd "$STAGING_DIR" && find . -type f ! -path '*/.*' -print0 | sort -z)

if [ "${#files[@]}" -eq 0 ]; then
    rm -f "$FULL_CHECK_FLAG"
    exit 0
fi

if [ "$full_check" -eq 0 ]; then
    pending=0
    for rel in "${files[@]}"; do
        if ! marker_matches "$rel" "$(stamp "$STAGING_DIR/$rel")"; then
            pending=1
            break
        fi
    done
    # Everything is already copied: don't mount at all, so the machine
    # isn't left mounted (and exposed to a power-off) for no reason.
    [ "$pending" -eq 1 ] || exit 0
fi

tmp=
cleanup() {
    if mountpoint -q "$MOUNT_POINT"; then
        [ -n "$tmp" ] && rm -f "$tmp"
        sync
        if ! umount "$MOUNT_POINT" 2>/dev/null; then
            log "unmount of $MOUNT_POINT failed, detaching lazily"
            umount -l "$MOUNT_POINT" || true
        fi
    fi
}
trap cleanup EXIT

if ! mount -o umask=0,flush,noatime "$DEVICE" "$MOUNT_POINT"; then
    log "failed to mount $DEVICE on $MOUNT_POINT"
    exit 1
fi

failed=0
copied=0
declare -A seen=()
for rel in "${files[@]}"; do
    f="$STAGING_DIR/$rel"

    # FAT is case-insensitive: Rose.pes and rose.pes (or Flowers/ and
    # flowers/) are the same path on the machine, and copying both would
    # overwrite each other on every run.
    key=${rel,,}
    if [ -n "${seen[$key]:-}" ]; then
        log "skipping $rel: same path on the machine as ${seen[$key]} (only the case differs)"
        continue
    fi
    seen[$key]=$rel

    dest="$MOUNT_POINT/$rel"
    current=$(stamp "$f")
    if [ -f "$dest" ] && [ "$(stat -c%s "$dest")" = "${current%% *}" ] \
        && marker_matches "$rel" "$current"; then
        continue
    fi

    tmp="$dest.partial"
    if mkdir -p "$(dirname "$dest")" && cp --preserve=timestamps "$f" "$tmp" \
        && mv -f "$tmp" "$dest" && sync; then
        tmp=
        write_marker "$rel" "$current"
        copied=$((copied + 1))
        log "copied $rel to machine"
    else
        rm -f "$tmp" || true
        tmp=
        failed=1
        log "failed to copy $rel to machine (is its storage full?)"
    fi
done

# For the web UI's "Synced N min ago".
printf '{"time": %s, "copied": %s, "failed": %s}\n' "$(date +%s)" "$copied" "$failed" \
    > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE" || true

# Keep the flag after a failure, so the next timer run re-checks
# everything instead of trusting markers.
if [ "$failed" -eq 0 ]; then
    rm -f "$FULL_CHECK_FLAG"
fi
exit "$failed"
