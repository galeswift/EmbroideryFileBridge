"""Tests for embroidery-sync.sh.

The real script runs against temporary directories, with mount/umount/
mountpoint/flock/logger replaced by small stubs and a plain directory
standing in for the machine's USB storage.
"""
import json
import os
import subprocess
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import ROOT, case_insensitive_fs

STUBS = {
    # "Mounted" just means a flag file exists.
    "mountpoint": '[ -e "$S/run/mounted" ]',
    "mount": textwrap.dedent("""\
        [ -e "$S/run/mount-fails" ] && exit 32
        touch "$S/run/mounted"; echo MOUNT >> "$S/run/events"
    """),
    "umount": 'rm -f "$S/run/mounted"; echo "UMOUNT $*" >> "$S/run/events"',
    "flock": "exit 0",
    "logger": 'shift 2; echo "$*" >> "$S/run/log"',
    # Simulate a copy failing (e.g. the machine's storage is full).
    "cp": textwrap.dedent("""\
        for a in "$@"; do case "$a" in */fail.pes*) exit 1;; esac; done
        exec /usr/bin/cp "$@"
    """),
}


@pytest.fixture
def sync(tmp_path, bash):
    root = tmp_path
    ns = SimpleNamespace(
        root=root,
        staging=root / "incoming",
        status=root / "status",
        machine=root / "machine",
        run_dir=root / "run",
        flag=root / "run" / "full-check",
        state=root / "state.json",
    )
    for d in (ns.staging, ns.status, ns.machine, ns.run_dir, root / "bin"):
        d.mkdir(parents=True)
    for name, body in STUBS.items():
        # Stubs find the test root from their own location.
        script = f'#!/bin/bash\nS="$(cd "$(dirname "$0")/.." && pwd)"\n{body}\n'
        (root / "bin" / name).write_text(script, newline="\n")
    (ns.run_dir / "device").write_text("")
    # Put the stubs first on PATH, from bash's own view of the path. On
    # Windows, /usr/bin must also come before System32, whose find.exe
    # isn't GNU find.
    (root / "run.sh").write_text(
        'cd "$(dirname "$0")" && export PATH="$PWD/bin:/usr/bin:$PATH" && exec bash "$SYNC_SCRIPT"\n',
        newline="\n")

    def run(full_check=False, device=True):
        if full_check:
            ns.flag.write_text("")
        for f in ("events", "log"):
            (ns.run_dir / f).write_text("")
        env = dict(os.environ,
                   SYNC_SCRIPT=(ROOT / "embroidery-sync.sh").as_posix(),
                   EMBROIDERY_STAGING_DIR=ns.staging.as_posix(),
                   EMBROIDERY_STATUS_DIR=ns.status.as_posix(),
                   EMBROIDERY_STATE_FILE=ns.state.as_posix(),
                   EMBROIDERY_MOUNT_POINT=ns.machine.as_posix(),
                   EMBROIDERY_LOCK_FILE=(ns.run_dir / "lock").as_posix(),
                   EMBROIDERY_FULL_CHECK_FLAG=ns.flag.as_posix(),
                   EMBROIDERY_DEVICE=(ns.run_dir / ("device" if device else "missing")).as_posix())
        proc = subprocess.run([bash, (root / "run.sh").as_posix()], env=env,
                              capture_output=True, text=True, timeout=60)
        return SimpleNamespace(
            code=proc.returncode,
            stderr=proc.stderr,
            events=(ns.run_dir / "events").read_text().split("\n"),
            log=(ns.run_dir / "log").read_text(),
            mounted=(ns.run_dir / "mounted").exists(),
        )

    ns.run = run
    return ns


def stage(sync, rel, content):
    path = sync.staging / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def mounts(result):
    return [e for e in result.events if e.startswith("MOUNT")]


def touch_later(path, seconds=5):
    later = time.time() + seconds
    os.utime(path, (later, later))


# -------------------------------------------------------------- basics

def test_copies_new_file_and_records_it(sync):
    stage(sync, "rose.pes", b"AAAA")
    r = sync.run()
    assert r.code == 0, r.stderr
    assert (sync.machine / "rose.pes").read_bytes() == b"AAAA"
    st = (sync.staging / "rose.pes").stat()
    assert (sync.status / "rose.pes").read_text().strip() == f"{st.st_size} {int(st.st_mtime)}"
    assert len(mounts(r)) == 1 and not r.mounted
    assert "copied rose.pes" in r.log
    state = json.loads(sync.state.read_text())
    assert state["copied"] == 1 and state["failed"] == 0


def test_does_not_mount_when_nothing_is_pending(sync):
    stage(sync, "rose.pes", b"AAAA")
    sync.run()
    r = sync.run()
    assert r.code == 0 and mounts(r) == []


def test_no_device_means_no_mount(sync):
    stage(sync, "rose.pes", b"AAAA")
    r = sync.run(device=False)
    assert r.code == 0 and mounts(r) == []
    assert not (sync.machine / "rose.pes").exists()


def test_empty_staging_clears_full_check_flag(sync):
    r = sync.run(full_check=True)
    assert r.code == 0 and mounts(r) == []
    assert not sync.flag.exists()


def test_hidden_and_in_progress_files_are_not_copied(sync):
    stage(sync, ".rose.pes.uploading", b"partial")
    stage(sync, ".hidden/x.pes", b"x")
    stage(sync, "real.pes", b"x")
    sync.run()
    assert sorted(p.name for p in sync.machine.iterdir()) == ["real.pes"]


# ------------------------------------------------- change detection

def test_same_size_replacement_is_recopied(sync):
    f = stage(sync, "rose.pes", b"AAAA")
    sync.run()
    f.write_bytes(b"BBBB")
    touch_later(f)
    r = sync.run()
    assert len(mounts(r)) == 1
    assert (sync.machine / "rose.pes").read_bytes() == b"BBBB"


def test_dropped_file_is_recopied_only_on_full_check(sync):
    stage(sync, "rose.pes", b"AAAA")
    sync.run()
    (sync.machine / "rose.pes").unlink()  # the machine lost it on power-cycle

    r = sync.run()  # timer run: markers say it's copied, so no mount
    assert mounts(r) == [] and not (sync.machine / "rose.pes").exists()

    r = sync.run(full_check=True)  # udev run after reconnect
    assert r.code == 0
    assert (sync.machine / "rose.pes").read_bytes() == b"AAAA"
    assert not sync.flag.exists()


def test_truncated_file_on_machine_is_recopied(sync):
    stage(sync, "rose.pes", b"AAAAAAAA")
    sync.run()
    (sync.machine / "rose.pes").write_bytes(b"AA")
    sync.run(full_check=True)
    assert (sync.machine / "rose.pes").read_bytes() == b"AAAAAAAA"


# ------------------------------------------------------------- folders

def test_nested_folders_are_mirrored(sync):
    stage(sync, "Holiday/tree.pes", b"t")
    stage(sync, "Holiday/Snow/flake.pes", b"f")
    r = sync.run()
    assert r.code == 0, r.stderr
    assert (sync.machine / "Holiday" / "tree.pes").read_bytes() == b"t"
    assert (sync.machine / "Holiday" / "Snow" / "flake.pes").read_bytes() == b"f"
    assert (sync.status / "Holiday" / "Snow" / "flake.pes").exists()
    assert json.loads(sync.state.read_text())["copied"] == 2


def test_moved_file_is_copied_to_new_location(sync):
    stage(sync, "rose.pes", b"x")
    sync.run()
    (sync.staging / "Box").mkdir()
    (sync.staging / "rose.pes").rename(sync.staging / "Box" / "rose.pes")
    (sync.status / "rose.pes").unlink()  # what the web UI does on a move
    sync.run()
    assert (sync.machine / "Box" / "rose.pes").exists()


def test_case_only_duplicates_are_skipped(sync):
    if case_insensitive_fs(sync.staging):
        pytest.skip("can't stage case-only duplicates on a case-insensitive filesystem")
    stage(sync, "Rose.pes", b"one")
    stage(sync, "rose.pes", b"two!")
    r = sync.run()
    assert "only the case differs" in r.log
    r = sync.run()
    assert mounts(r) == []  # no ping-pong copying on later runs


# ------------------------------------------------------------ failures

def test_copy_failure_still_unmounts_and_keeps_flag(sync):
    stage(sync, "ok.pes", b"x")
    stage(sync, "fail.pes", b"y")
    r = sync.run(full_check=True)
    assert r.code == 1
    assert not r.mounted and any(e.startswith("UMOUNT") for e in r.events)
    assert sync.flag.exists()  # next run re-checks everything
    assert (sync.machine / "ok.pes").exists()
    assert not list(sync.machine.glob("*.partial"))
    assert "failed to copy fail.pes" in r.log


def test_stale_mount_is_cleared_first(sync):
    stage(sync, "rose.pes", b"x")
    (sync.run_dir / "mounted").write_text("")
    r = sync.run()
    assert r.code == 0
    assert r.events[0].startswith("UMOUNT") and "clearing stale mount" in r.log
    assert not r.mounted


def test_mount_failure_exits_nonzero(sync):
    stage(sync, "rose.pes", b"x")
    (sync.run_dir / "mount-fails").write_text("")
    r = sync.run()
    assert r.code == 1
    assert "failed to mount" in r.log
    assert not (sync.machine / "rose.pes").exists()
