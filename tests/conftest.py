import importlib.util
import io
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_web(tmp_path, monkeypatch):
    base = tmp_path / "srv"
    ns = SimpleNamespace(
        staging=base / "incoming",
        status=base / ".sync-status",
        previews=base / ".previews",
        state=base / ".sync-state.json",
    )
    for d in (ns.staging, ns.status, ns.previews):
        d.mkdir(parents=True)
    monkeypatch.setenv("EMBROIDERY_STAGING_DIR", str(ns.staging))
    monkeypatch.setenv("EMBROIDERY_STATUS_DIR", str(ns.status))
    monkeypatch.setenv("EMBROIDERY_PREVIEW_DIR", str(ns.previews))
    monkeypatch.setenv("EMBROIDERY_STATE_FILE", str(ns.state))
    ns.request = base / ".requests" / "update-drive"
    ns.udc = base / "udc"
    monkeypatch.setenv("EMBROIDERY_REQUEST_FILE", str(ns.request))
    monkeypatch.setenv("EMBROIDERY_UDC_DIR", str(ns.udc))

    spec = importlib.util.spec_from_file_location("embroidery_web", ROOT / "embroidery-web.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.app.config["TESTING"] = True
    ns.mod = mod
    ns.client = mod.app.test_client()
    return ns


@pytest.fixture
def web(tmp_path, monkeypatch):
    return load_web(tmp_path, monkeypatch)


def upload(client, files, path="", **kw):
    """files: list of (relpath, bytes)."""
    data = {
        "path": path,
        "file": [(io.BytesIO(content), rel.split("/")[-1]) for rel, content in files],
        "relpath": [rel for rel, _ in files],
    }
    return client.post("/api/upload", data=data, content_type="multipart/form-data", **kw)


def mark_synced(web, rel):
    """Write the marker embroidery-sync.sh would after copying `rel`."""
    st = (web.staging / rel).stat()
    marker = web.status / rel
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{st.st_size} {int(st.st_mtime)}\n")


def make_pes(path, width_mm=40):
    """Write a small two-color PES design `width_mm` wide (and 20 mm tall)."""
    pyembroidery = pytest.importorskip("pyembroidery")
    units = width_mm * 10  # pyembroidery works in 0.1 mm
    pattern = pyembroidery.EmbPattern()
    pattern.add_thread(pyembroidery.EmbThread("#d6336c"))
    pattern.add_thread(pyembroidery.EmbThread("#2b8a3e"))
    for i in range(61):
        a = 2 * math.pi * i / 60
        pattern.add_stitch_absolute(pyembroidery.STITCH, units / 2 * math.cos(a), 100 * math.sin(a))
    pattern.add_command(pyembroidery.COLOR_CHANGE)
    for i in range(40):
        pattern.add_stitch_absolute(pyembroidery.STITCH, -units / 4 + i * units / 80, (i % 2) * 40)
    pattern.add_command(pyembroidery.END)
    pyembroidery.write_pes(pattern, str(path))
    return path.read_bytes()


@pytest.fixture
def pes_bytes(tmp_path):
    """A small two-color PES design, generated with pyembroidery."""
    return make_pes(tmp_path / "sample.pes")
