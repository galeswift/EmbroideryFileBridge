#!/usr/bin/env python3
"""
Keep the embroidery machine's "USB flash drive" in step with the Pi's library.

The Pi Zero's USB port runs in device mode (dtoverlay=dwc2) and presents a
FAT32 disk image to the machine through the g_mass_storage gadget, so the
machine sees an ordinary USB stick in its USB-A port. Unlike the machine's
"PC link" RAM disk, the drive lives on the Pi: it survives the machine
being switched off, has room for the whole library, and folders work.

Each run:
  1. If the machine has written to the drive since we built it (it can
     save designs to USB), import anything new or changed into the
     library first, so a rebuild can never throw it away.
  2. If the library differs from what's on the drive, build a fresh image
     next to the live one, "unplug" the drive, swap the new image in and
     "plug" it back in. The live image is never edited while the machine
     might be reading it.
  3. Refresh the per-file status markers the web UI shows as
     "On machine", and record when this happened.

Run as root (loading the USB gadget needs it), by embroidery-drive.service:
at boot, when the web UI requests it after a change, and every minute.
"""
import fcntl
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/srv/embroidery")
STAGING_DIR = Path(os.environ.get("EMBROIDERY_STAGING_DIR", ROOT / "incoming"))
STATUS_DIR = Path(os.environ.get("EMBROIDERY_STATUS_DIR", ROOT / ".sync-status"))
STATE_FILE = Path(os.environ.get("EMBROIDERY_STATE_FILE", ROOT / ".sync-state.json"))
IMAGE = Path(os.environ.get("EMBROIDERY_IMAGE", ROOT / "usb-drive.img"))
MANIFEST = Path(os.environ.get("EMBROIDERY_MANIFEST", ROOT / ".drive-manifest.json"))
LOCK_FILE = Path(os.environ.get("EMBROIDERY_LOCK_FILE", "/run/embroidery-drive.lock"))
UDC_DIR = Path(os.environ.get("EMBROIDERY_UDC_DIR", "/sys/class/udc"))
GADGET_FILE_PARAM = Path("/sys/module/g_mass_storage/parameters/file")

# How long the library must stay unchanged before building (an upload of
# many files arrives as several requests), and how long the machine must
# have left the drive alone before we read what it wrote.
STAGING_SETTLE = float(os.environ.get("EMBROIDERY_STAGING_SETTLE", "3"))
MACHINE_SETTLE = float(os.environ.get("EMBROIDERY_MACHINE_SETTLE", "30"))

PARTITION_START = 2048  # sectors; 1 MiB, like an ordinary USB stick
MIB = 1024 * 1024
MIN_IMAGE = 256 * MIB
VOLUME_LABEL = "EMBROIDERY"


def log(msg):
    print(msg, flush=True)


def tool(name):
    """Find a system tool, including /usr/sbin when not running as root."""
    for candidate in (shutil.which(name), f"/usr/sbin/{name}", f"/sbin/{name}"):
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError(f"{name} is not installed")


def run(*args, **kw):
    env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
    return subprocess.run(args, check=True, capture_output=True, text=True, env=env, **kw)


def img_arg(image):
    return f"{image}@@{PARTITION_START * 512}"


# ------------------------------------------------------------- library

def hidden(rel):
    return any(part.startswith(".") for part in Path(rel).parts)


def snapshot():
    """Library contents: {relpath: [size, mtime]} for files, None for folders."""
    snap = {}
    for dirpath, dirnames, filenames in os.walk(STAGING_DIR):
        base = Path(dirpath)
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for d in dirnames:
            snap[(base / d).relative_to(STAGING_DIR).as_posix()] = None
        for f in sorted(filenames):
            if f.startswith("."):
                continue  # uploads in progress, etc.
            p = base / f
            st = p.stat()
            snap[p.relative_to(STAGING_DIR).as_posix()] = [st.st_size, int(st.st_mtime)]
    return snap


def settled_snapshot():
    snap = snapshot()
    for _ in range(20):
        if STAGING_SETTLE <= 0:
            break
        time.sleep(STAGING_SETTLE)
        again = snapshot()
        if again == snap:
            break
        snap = again
    return snap


# --------------------------------------------------------------- image

_ENTRY = re.compile(
    r"^(?P<short>.{8}) (?P<ext>.{3}) +(?P<size><DIR>|\d+) +\d{4}-\d\d-\d\d +\d\d:\d\d(?: +(?P<long>.*?))? *$")


def list_image(image):
    """What's on the drive: {relpath: size} for files, None for folders."""
    out = run(tool("mdir"), "-/", "-a", "-i", img_arg(image), "::").stdout
    found, current = {}, ""
    for line in out.splitlines():
        if line.startswith("Directory for ::/"):
            current = line[len("Directory for ::/"):].strip()
            continue
        m = _ENTRY.match(line)
        if not m:
            continue
        name = m["long"]
        if not name:
            short, ext = m["short"].rstrip(), m["ext"].rstrip()
            name = f"{short}.{ext}" if ext else short
        if name in (".", ".."):
            continue
        rel = f"{current}/{name}" if current else name
        found[rel] = None if m["size"] == "<DIR>" else int(m["size"])
    return found


def image_size(total_bytes):
    wanted = total_bytes * 1.25 + 32 * MIB
    return max(MIN_IMAGE, math.ceil(wanted / (64 * MIB)) * 64 * MIB)


def build_image(target, snap):
    """Write a fresh FAT32 drive containing the library to `target`."""
    total = sum(v[0] for v in snap.values() if v)
    target.unlink(missing_ok=True)
    with open(target, "wb") as f:
        f.truncate(image_size(total))
    run(tool("sfdisk"), "-q", str(target), input=f"start={PARTITION_START}, type=c\n")
    run(tool("mkfs.vfat"), "-F", "32", "-n", VOLUME_LABEL, "--offset", str(PARTITION_START), str(target))

    # The drive is FAT: names that differ only in case would collide.
    seen, skipped = {}, []
    dirs, files_by_dir = [], {}
    for rel, info in sorted(snap.items()):
        key = rel.lower()
        if key in seen:
            skipped.append(rel)
            continue
        seen[key] = rel
        if info is None:
            dirs.append(rel)
        else:
            parent = rel.rpartition("/")[0]
            files_by_dir.setdefault(parent, []).append(rel)
    for rel in skipped:
        log(f"skipping {rel}: same name on the drive as {seen[rel.lower()]} (only the case differs)")

    dirs.sort(key=lambda d: d.count("/"))
    for i in range(0, len(dirs), 100):
        run(tool("mmd"), "-i", img_arg(target), *(f"::/{d}" for d in dirs[i:i + 100]))
    for parent, rels in files_by_dir.items():
        for i in range(0, len(rels), 100):
            chunk = [str(STAGING_DIR / r) for r in rels[i:i + 100]]
            run(tool("mcopy"), "-Q", "-m", "-i", img_arg(target), *chunk, f"::/{parent}/" if parent else "::/")

    return {rel: (None if snap[rel] is None else snap[rel][0])
            for rel in seen.values()}


def extract(rel, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(tool("mcopy"), "-n", "-m", "-Q", "-i", img_arg(IMAGE), f"::/{rel}", str(dest))


def unique_path(path):
    if not path.exists():
        return path
    for n in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"no free name for {path}")


def import_machine_changes(manifest):
    """Copy anything the machine saved onto the drive into the library.

    Returns (imported, restore_needed): how many files were imported, and
    whether files the Pi put on the drive have gone missing (deleted on the
    machine) so a rebuild should put them back.
    """
    if not manifest or not IMAGE.exists():
        return 0, False
    mtime = IMAGE.stat().st_mtime
    if mtime == manifest.get("image_mtime"):
        return 0, False
    if time.time() - mtime < MACHINE_SETTLE:
        log("drive was written recently; checking it again once the machine has finished")
        return 0, False

    on_drive = list_image(IMAGE)
    known = manifest.get("image", {})
    imported, conflicts = 0, False
    for rel, size in sorted(on_drive.items()):
        if hidden(rel) or rel.upper().startswith("SYSTEM VOLUME INFORMATION"):
            continue
        if size is None:
            if rel not in known:
                (STAGING_DIR / rel).mkdir(parents=True, exist_ok=True)
            continue
        if rel in known and known[rel] == size:
            continue
        target = STAGING_DIR / rel
        if rel in known:
            # Changed on the machine: keep both versions.
            target = target.with_name(f"{target.stem} (from machine){target.suffix}")
            conflicts = True
        target = unique_path(target)
        extract(rel, target)
        imported += 1
        log(f"imported {rel} from the machine as {target.relative_to(STAGING_DIR).as_posix()}")

    missing = [rel for rel, size in known.items() if rel not in on_drive]
    if missing:
        log(f"{len(missing)} item(s) were removed on the machine; they'll be restored from the library")

    manifest["image_mtime"] = mtime
    if imported and not conflicts:
        # The drive already holds exactly these files, so record them as
        # present instead of rebuilding (which would unplug the drive).
        snap = snapshot()
        for rel, size in on_drive.items():
            if rel in snap:
                known[rel] = size
                manifest["staging"][rel] = snap[rel]
        manifest["image"] = known
    return imported, bool(missing) or conflicts


# -------------------------------------------------------------- gadget

def device_mode_available():
    return UDC_DIR.is_dir() and any(UDC_DIR.iterdir())


def attached_image():
    try:
        return GADGET_FILE_PARAM.read_text().strip() or None
    except OSError:
        return None


def detach():
    subprocess.run(["modprobe", "-r", "g_mass_storage"], check=False, capture_output=True)


def attach():
    run("modprobe", "g_mass_storage", f"file={IMAGE}", "removable=1", "stall=0")


def ensure_attached():
    if not device_mode_available():
        log("USB device mode isn't active (dtoverlay=dwc2); reboot after installing")
        return False
    if attached_image() != str(IMAGE):
        detach()
        attach()
        log("drive plugged in")
    return True


# ------------------------------------------------------ markers & state

def write_markers(snap, on_drive):
    """One marker per file on the drive, holding its library "size mtime"."""
    wanted = {rel: f"{info[0]} {info[1]}\n" for rel, info in snap.items()
              if info is not None and rel in on_drive}
    for dirpath, _, filenames in os.walk(STATUS_DIR, topdown=False):
        for f in filenames:
            p = Path(dirpath) / f
            if p.relative_to(STATUS_DIR).as_posix() not in wanted:
                p.unlink(missing_ok=True)
        if Path(dirpath) != STATUS_DIR and not any(Path(dirpath).iterdir()):
            Path(dirpath).rmdir()
    for rel, text in wanted.items():
        p = STATUS_DIR / rel
        try:
            if p.read_text() == text:
                continue
        except OSError:
            pass
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    # The web UI (not root) clears markers when files move; let it.
    try:
        st = STATUS_DIR.stat()
        for dirpath, dirnames, filenames in os.walk(STATUS_DIR):
            for name in dirnames + filenames:
                os.chown(Path(dirpath) / name, st.st_uid, st.st_gid)
    except (OSError, AttributeError):
        pass


def write_state(**fields):
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    tmp.write_text(json.dumps({"time": int(time.time()), **fields}) + "\n")
    os.replace(tmp, STATE_FILE)


def load_manifest():
    try:
        return json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        return None


def save_manifest(manifest):
    tmp = MANIFEST.with_name(MANIFEST.name + ".tmp")
    tmp.write_text(json.dumps(manifest))
    os.replace(tmp, MANIFEST)


# ---------------------------------------------------------------- main

def sync():
    manifest = load_manifest()
    imported, restore = import_machine_changes(manifest)
    if manifest:
        save_manifest(manifest)

    snap = snapshot()
    up_to_date = (manifest is not None and IMAGE.exists() and not restore
                  and manifest.get("staging") == snap)
    changed = 0
    if not up_to_date:
        for attempt in range(3):
            snap = settled_snapshot()
            previous = (manifest or {}).get("staging", {})
            changed = sum(1 for rel, info in snap.items() if info is not None and previous.get(rel) != info)
            new_image = IMAGE.with_name(IMAGE.name + ".new")
            on_drive = build_image(new_image, snap)

            detach()
            # The machine may have written to the old drive while we built.
            if manifest:
                late, _ = import_machine_changes(manifest)
                if late:
                    save_manifest(manifest)
                    continue  # the library changed; build again (still unplugged)
            os.replace(new_image, IMAGE)
            manifest = {"staging": snap, "image": on_drive, "image_mtime": IMAGE.stat().st_mtime}
            save_manifest(manifest)
            log(f"drive updated: {sum(1 for v in snap.values() if v)} files, {changed} new or changed")
            if snapshot() == snap:
                break
        else:
            log("library kept changing; will finish on the next run")

    attached = ensure_attached()
    write_markers(snapshot() if up_to_date else snap, manifest["image"] if manifest else {})
    write_state(copied=changed, imported=imported, failed=0, attached=attached)
    return 0


def main():
    for d in (STAGING_DIR, STATUS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # another run is in progress and will pick up changes
        try:
            return sync()
        except subprocess.CalledProcessError as err:
            log(f"failed: {' '.join(err.cmd)}: {err.stderr.strip()}")
            write_state(copied=0, failed=1)
            return 1


if __name__ == "__main__":
    sys.exit(main())
