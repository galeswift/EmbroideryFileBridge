"""Tests for embroidery-drive.py.

These build real FAT32 drive images, so they need Linux with mtools,
dosfstools (mkfs.vfat) and sfdisk -- e.g. run them on the Pi. Plugging
the drive into the machine (the USB gadget) is faked.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import ROOT


def _have(name):
    return any(Path(p).exists() for p in (shutil.which(name) or "", f"/usr/sbin/{name}", f"/sbin/{name}"))


pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or not all(_have(t) for t in ("mcopy", "mdir", "mkfs.vfat", "sfdisk")),
    reason="needs Linux with mtools, dosfstools and sfdisk")


@pytest.fixture
def drive(tmp_path, monkeypatch):
    ns = SimpleNamespace(
        staging=tmp_path / "incoming",
        status=tmp_path / "status",
        image=tmp_path / "usb-drive.img",
        state=tmp_path / "state.json",
        manifest=tmp_path / "manifest.json",
    )
    ns.staging.mkdir()
    for name, value in (("STAGING_DIR", ns.staging), ("STATUS_DIR", ns.status),
                        ("IMAGE", ns.image), ("STATE_FILE", ns.state), ("MANIFEST", ns.manifest),
                        ("LOCK_FILE", tmp_path / "lock"), ("UDC_DIR", tmp_path / "udc"),
                        ("STAGING_SETTLE", "0"), ("MACHINE_SETTLE", "0")):
        monkeypatch.setenv(f"EMBROIDERY_{name}", str(value))

    spec = importlib.util.spec_from_file_location("embroidery_drive", ROOT / "embroidery-drive.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Fake USB gadget: record plug/unplug instead of loading kernel modules.
    ns.events = []
    ns.plugged = None
    ns.device_mode = True

    def attach():
        ns.events.append("plug")
        ns.plugged = str(ns.image)

    def detach():
        if ns.plugged:
            ns.events.append("unplug")
        ns.plugged = None

    monkeypatch.setattr(mod, "attach", attach)
    monkeypatch.setattr(mod, "detach", detach)
    monkeypatch.setattr(mod, "attached_image", lambda: ns.plugged)
    monkeypatch.setattr(mod, "device_mode_available", lambda: ns.device_mode)
    ns.mod = mod

    def run():
        ns.events.clear()
        assert mod.main() == 0
        return ns.events[:]

    ns.run = run
    return ns


def put(drive, rel, content=b"x", later=0):
    p = drive.staging / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    if later:
        t = time.time() + later
        os.utime(p, (t, t))
    return p


def on_drive(drive):
    return drive.mod.list_image(drive.image)


def read_from_drive(drive, rel, tmp_path):
    out = tmp_path / "extracted" / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    drive.mod.extract(rel, out)
    return out.read_bytes()


def machine_writes(drive, fn):
    """Change the live drive the way the machine would, then age it."""
    env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
    fn(env, drive.mod.img_arg(drive.image))
    backdate(drive.image)


def backdate(path, seconds=60):
    """Stamp a write as finished a while ago (the drive waits for the
    machine to be done writing before it reads the drive)."""
    t = time.time() - seconds
    os.utime(path, (t, t))


def marker(drive, rel):
    p = drive.status / rel
    return p.read_text().strip() if p.exists() else None


# ---------------------------------------------------------- building

def test_first_run_builds_drive_and_plugs_it_in(drive, tmp_path):
    put(drive, "rose.pes", b"rose")
    put(drive, "Holiday/tree.pes", b"tree")
    (drive.staging / "Empty").mkdir()
    events = drive.run()
    assert events == ["plug"]
    assert on_drive(drive) == {"rose.pes": 4, "Holiday": None, "Holiday/tree.pes": 4, "Empty": None}
    assert read_from_drive(drive, "Holiday/tree.pes", tmp_path) == b"tree"
    st = (drive.staging / "rose.pes").stat()
    assert marker(drive, "rose.pes") == f"{st.st_size} {int(st.st_mtime)}"
    state = json.loads(drive.state.read_text())
    assert state["attached"] is True and state["failed"] == 0


def test_drive_is_partitioned_fat32_like_a_usb_stick(drive):
    put(drive, "rose.pes")
    drive.run()
    table = subprocess.run([drive.mod.tool("sfdisk"), "-d", str(drive.image)],
                           capture_output=True, text=True, check=True).stdout
    assert "start=        2048" in table and "type=c" in table
    assert drive.image.stat().st_size == drive.mod.MIN_IMAGE


def test_long_names_and_spaces_survive(drive, tmp_path):
    put(drive, "Thank You Jesus With Flowers.PES", b"ty")
    drive.run()
    assert "Thank You Jesus With Flowers.PES" in on_drive(drive)


def test_hidden_and_in_progress_files_are_left_off(drive):
    put(drive, ".rose.pes.uploading", b"partial")
    put(drive, ".hidden/x.pes")
    put(drive, "real.pes")
    drive.run()
    assert on_drive(drive) == {"real.pes": 1}


def test_case_only_duplicates_are_skipped(drive, capsys):
    put(drive, "Rose.pes", b"one")
    put(drive, "rose.pes", b"two!")
    drive.run()
    assert len(on_drive(drive)) == 1
    assert "only the case differs" in capsys.readouterr().out


def test_image_grows_with_the_library(drive):
    mib = drive.mod.MIB
    assert drive.mod.image_size(0) == 256 * mib
    assert drive.mod.image_size(400 * mib) >= 500 * mib


# ----------------------------------------------------------- updates

def test_nothing_happens_when_library_is_unchanged(drive):
    put(drive, "rose.pes")
    drive.run()
    before = drive.image.stat().st_mtime
    assert drive.run() == []
    assert drive.image.stat().st_mtime == before


def test_added_file_is_put_on_drive_with_a_replug(drive):
    put(drive, "rose.pes")
    drive.run()
    put(drive, "daisy.pes", b"dd")
    assert drive.run() == ["unplug", "plug"]
    assert on_drive(drive) == {"rose.pes": 1, "daisy.pes": 2}


def test_same_size_change_is_picked_up(drive, tmp_path):
    put(drive, "rose.pes", b"AAAA")
    drive.run()
    put(drive, "rose.pes", b"BBBB", later=5)
    drive.run()
    assert read_from_drive(drive, "rose.pes", tmp_path) == b"BBBB"


def test_deleted_file_leaves_the_drive_and_its_marker_goes(drive):
    put(drive, "rose.pes")
    put(drive, "daisy.pes")
    drive.run()
    (drive.staging / "daisy.pes").unlink()
    drive.run()
    assert on_drive(drive) == {"rose.pes": 1}
    assert marker(drive, "daisy.pes") is None


def test_moved_file_follows_on_the_drive(drive):
    put(drive, "rose.pes")
    drive.run()
    (drive.staging / "Box").mkdir()
    (drive.staging / "rose.pes").rename(drive.staging / "Box" / "rose.pes")
    drive.run()
    assert on_drive(drive) == {"Box": None, "Box/rose.pes": 1}
    assert marker(drive, "Box/rose.pes") is not None
    assert marker(drive, "rose.pes") is None


# ---------------------------------------------- files from the machine

def test_design_saved_on_machine_is_imported_without_a_replug(drive, tmp_path):
    put(drive, "rose.pes")
    drive.run()
    saved = tmp_path / "SAVED.PES"
    saved.write_bytes(b"from the machine")
    machine_writes(drive, lambda env, img: subprocess.run(
        [drive.mod.tool("mcopy"), "-i", img, str(saved), "::/"], env=env, check=True))

    assert drive.run() == []  # already on the drive: no need to unplug it
    assert (drive.staging / "SAVED.PES").read_bytes() == b"from the machine"
    assert marker(drive, "SAVED.PES") is not None
    assert drive.run() == []  # and it stays settled


def test_design_changed_on_machine_keeps_both_versions(drive, tmp_path):
    put(drive, "rose.pes", b"original")
    drive.run()
    edited = tmp_path / "rose.pes"
    edited.write_bytes(b"edited on the machine")
    machine_writes(drive, lambda env, img: subprocess.run(
        [drive.mod.tool("mcopy"), "-o", "-i", img, str(edited), "::/rose.pes"], env=env, check=True))

    drive.run()
    assert (drive.staging / "rose.pes").read_bytes() == b"original"
    assert (drive.staging / "rose (from machine).pes").read_bytes() == b"edited on the machine"
    assert set(on_drive(drive)) == {"rose.pes", "rose (from machine).pes"}


def test_design_deleted_on_machine_is_restored(drive):
    put(drive, "rose.pes")
    drive.run()
    machine_writes(drive, lambda env, img: subprocess.run(
        [drive.mod.tool("mdel"), "-i", img, "::/rose.pes"], env=env, check=True))
    drive.run()
    assert on_drive(drive) == {"rose.pes": 1}


def test_recent_machine_writes_are_left_until_it_is_done(drive, tmp_path, monkeypatch):
    put(drive, "rose.pes")
    drive.run()
    saved = tmp_path / "NEW.PES"
    saved.write_bytes(b"n")
    machine_writes(drive, lambda env, img: subprocess.run(
        [drive.mod.tool("mcopy"), "-i", img, str(saved), "::/"], env=env, check=True))
    monkeypatch.setattr(drive.mod, "MACHINE_SETTLE", 3600)
    os.utime(drive.image)  # "just written"
    drive.run()
    assert not (drive.staging / "NEW.PES").exists()


def test_machine_touching_dates_only_changes_nothing(drive):
    put(drive, "rose.pes")
    drive.run()
    backdate(drive.image)  # e.g. the machine updated access dates
    assert drive.run() == []
    assert sorted(p.name for p in drive.staging.iterdir()) == ["rose.pes"]


# ------------------------------------------------------------ gadget

def test_without_usb_device_mode_the_drive_is_still_built(drive):
    drive.device_mode = False
    put(drive, "rose.pes")
    assert drive.run() == []
    assert on_drive(drive) == {"rose.pes": 1}
    assert json.loads(drive.state.read_text())["attached"] is False


def test_unplugged_drive_is_plugged_back_in(drive):
    put(drive, "rose.pes")
    drive.run()
    drive.plugged = None  # e.g. after a reboot
    assert drive.run() == ["plug"]


def test_listing_parses_short_and_long_names(drive, tmp_path):
    put(drive, "AB.PES")
    put(drive, "Folder/Long name here.dst", b"12345")
    drive.run()
    assert on_drive(drive) == {"AB.PES": 1, "Folder": None, "Folder/Long name here.dst": 5}
