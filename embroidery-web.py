#!/usr/bin/env python3
"""
LAN web UI for the embroidery file bridge staging directory.

Serves a single-page app (web/) plus a small JSON API for browsing,
uploading, organizing into folders, and deleting the files that
embroidery-drive.py puts on the machine's USB drive. Embroidery designs get a
rendered stitch preview via pyembroidery when it's installed.

Intentionally has no authentication, matching the guest-only trust
model of the Samba share it replaces: if your network isn't trusted,
put this behind a reverse proxy or VPN rather than exposing it further.
"""
import gzip
import json
import os
import re
import shutil
import struct
import sys
import time
import unicodedata
from array import array
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

try:
    import pyembroidery
except ImportError:  # previews are optional
    pyembroidery = None

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE / "web"

# /srv/embroidery/... is a Linux-only convention (the Pi). On Windows,
# a leading "/" resolves against the current drive root instead of
# being a real absolute path, so a Windows run would otherwise create
# e.g. D:\srv\embroidery\incoming. Fall back to folders next to this
# script there instead -- only affects the defaults, and only on
# Windows; the EMBROIDERY_* env vars always win, and Pi behavior is
# unchanged.
if os.name == "nt":
    _DEFAULT_ROOT = HERE
    _DEFAULT_STAGING_DIR = HERE / "incoming"
else:
    _DEFAULT_ROOT = Path("/srv/embroidery")
    _DEFAULT_STAGING_DIR = _DEFAULT_ROOT / "incoming"

STAGING_DIR = Path(os.environ.get("EMBROIDERY_STAGING_DIR", _DEFAULT_STAGING_DIR))
STATUS_DIR = Path(os.environ.get("EMBROIDERY_STATUS_DIR", _DEFAULT_ROOT / ".sync-status"))
PREVIEW_DIR = Path(os.environ.get("EMBROIDERY_PREVIEW_DIR", _DEFAULT_ROOT / ".previews"))
STATE_FILE = Path(os.environ.get("EMBROIDERY_STATE_FILE", _DEFAULT_ROOT / ".sync-state.json"))
# Touched after every change; embroidery-drive.path watches it and updates
# the machine's USB drive.
REQUEST_FILE = Path(os.environ.get("EMBROIDERY_REQUEST_FILE", _DEFAULT_ROOT / ".requests" / "update-drive"))
# The Pi's USB port in device mode; "configured" once the machine has
# recognized the Pi as a USB drive.
UDC_DIR = Path(os.environ.get("EMBROIDERY_UDC_DIR", "/sys/class/udc"))
# The machine's largest embroidery area, "<width>x<height>" in mm. Designs
# bigger than this don't show up on the machine, so the UI flags them.
# The default is the Brother PR-S100's 8" x 8" hoop.
HOOP_MM = [float(v) for v in os.environ.get("EMBROIDERY_HOOP_MM", "200x200").lower().split("x")]

# Anything pyembroidery can read gets a preview; this is just what the
# UI labels as a design rather than "other file".
DESIGN_EXTENSIONS = {
    ".pes", ".pec", ".dst", ".jef", ".exp", ".vp3", ".xxx", ".hus", ".vip",
    ".sew", ".pcs", ".pcm", ".pcq", ".shv", ".u01", ".10o", ".100", ".dsb",
    ".dsz", ".tbf", ".phb", ".phc", ".jpx", ".emd", ".stx", ".zxy", ".gt",
}

app = Flask(__name__, static_folder=None)
# Per request. The page uploads big folders in ~20 MB batches, so this
# only limits a single huge file. Uploads are buffered in TMPDIR, which
# the service points at the SD card (a Pi Zero's /tmp is ~200 MB of RAM).
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024


# ---------------------------------------------------------------- paths

# Characters FAT (the machine's filesystem) can't store, plus controls.
_FAT_UNSAFE = re.compile(r'[\x00-\x1f"*/:<>?\\|]')


def clean_name(name):
    """Make a single path component safe for the machine's FAT storage.

    ASCII only: neither the FAT mount's character set nor the machine's
    display can be relied on for anything else.
    """
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = _FAT_UNSAFE.sub("_", name).strip().strip(".").strip()
    return name[:120]


def staging_root():
    return STAGING_DIR.resolve()


def resolve(rel, must_exist=True):
    """Map a client-supplied relative path to a path inside STAGING_DIR."""
    parts = [p for p in PurePosixPath(rel or "").parts if p != "/"]
    # Dot-names are hidden (in-progress uploads) and ".." escapes.
    if any(p.startswith(".") for p in parts):
        abort(400, "Invalid path.")
    path = STAGING_DIR.joinpath(*parts)
    real, root = path.resolve(), staging_root()
    if real != root and root not in real.parents:
        abort(400, "Invalid path.")
    if must_exist and not path.exists():
        abort(404, "Not found.")
    return path


def rel_of(path):
    return path.relative_to(STAGING_DIR).as_posix()


def child_ci(parent, name):
    """The existing child matching name case-insensitively, else parent/name.

    The machine's FAT storage ignores case, so "Rose.pes" and "rose.pes"
    (or folders "Flowers" and "flowers") must stay one entry here too.
    """
    low = name.lower()
    if parent.is_dir():
        for p in parent.iterdir():
            if p.name.lower() == low:
                return p
    return parent / name


def visible_children(folder):
    return [p for p in folder.iterdir() if not p.name.startswith(".")]


def walk_files(folder):
    for p in visible_children(folder):
        if p.is_dir():
            yield from walk_files(p)
        elif p.is_file():
            yield p


# ------------------------------------------------------------ sync state

def stamp(st):
    # Must match what embroidery-drive.py writes: "<size> <mtime>".
    return f"{st.st_size} {int(st.st_mtime)}"


def is_synced(path, st):
    marker = STATUS_DIR / rel_of(path)
    try:
        return marker.read_text().strip() == stamp(st)
    except OSError:
        return False


def forget(rel):
    """Drop sync markers and cached previews for a file or folder.

    Called whenever something is deleted, moved or renamed. A moved file
    has not been copied to its new location on the machine yet, so its
    marker must not follow it.
    """
    for base, suffixes in ((STATUS_DIR, ("",)), (PREVIEW_DIR, (".json", ".stitches"))):
        target = base / rel
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        for p in (target, *(base / (rel + s) for s in suffixes)):
            if p.is_file():
                p.unlink(missing_ok=True)


def machine_connected():
    """Whether the machine is using the Pi as its USB drive, or None if unknown."""
    try:
        states = [(d / "state").read_text().strip() for d in UDC_DIR.iterdir()]
    except OSError:
        return None
    return "configured" in states if states else None


def request_drive_update():
    try:
        REQUEST_FILE.parent.mkdir(parents=True, exist_ok=True)
        REQUEST_FILE.write_text(f"{time.time()}\n")
    except OSError:
        pass  # the once-a-minute check will pick the change up anyway


def overall_status():
    try:
        state = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        state = {}
    pending = sum(1 for f in walk_files(STAGING_DIR) if not is_synced(f, f.stat()))
    usage = shutil.disk_usage(STAGING_DIR)
    return {
        "machine": machine_connected(),
        "last_sync": state.get("time"),
        "pending": pending,
        "disk_free": usage.free,
        "disk_total": usage.total,
        "previews": pyembroidery is not None,
        "hoop_mm": HOOP_MM,
    }


# ------------------------------------------------------------- previews

# Bump when render_preview's output changes, so cached previews are redrawn.
PREVIEW_VERSION = 2
# Embroidery thread lies about 0.4 mm wide; pyembroidery works in 0.1 mm.
THREAD_WIDTH_UNITS = 4


def thread_color(thread):
    color = thread.hex_color() if thread is not None else None
    return color if re.fullmatch(r"#[0-9a-fA-F]{6}", color or "") else "#555555"


def render_preview(path):
    pattern = pyembroidery.read(str(path))
    if pattern is None or not pattern.count_stitches():
        return None
    min_x, min_y, max_x, max_y = pattern.bounds()
    width, height = max(max_x - min_x, 1), max(max_y - min_y, 1)

    blocks = list(pattern.get_as_stitchblock())
    total = sum(len(b) for b, _ in blocks)
    # A Pi Zero serving 100k-point SVGs to a phone is slow for no
    # visible gain; thin very dense designs.
    step = max(1, total // 40000)

    paths = []
    for block, thread in blocks:
        pts = block[::step] if len(block) > step * 2 else block
        if len(pts) < 2:
            continue
        color = thread_color(thread)
        d =" ".join(f"{round(x - min_x)},{round(y - min_y)}" for x, y, *_ in pts)
        paths.append(f'<polyline points="{d}" stroke="{color}"/>')

    pad = max(width, height) * 0.04
    # Real thread width, so fills read as solid thread; thicker only where
    # a big design would otherwise turn into hairlines at thumbnail size.
    stroke = max(THREAD_WIDTH_UNITS, max(width, height) / 300)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{-pad:.0f} {-pad:.0f} {width + 2 * pad:.0f} {height + 2 * pad:.0f}">'
        f'<g fill="none" stroke-width="{stroke:.1f}" stroke-linecap="round" '
        f'stroke-linejoin="round">{"".join(paths)}</g></svg>'
    )
    colors = []
    for thread in pattern.threadlist:
        c = thread.hex_color()
        if c not in colors:
            colors.append(c)
    return {
        "svg": svg,
        "stitches": pattern.count_stitches(),
        "colors": colors,
        "color_changes": pattern.count_color_changes(),
        "width_mm": round(width / 10, 1),
        "height_mm": round(height / 10, 1),
    }


STITCHES_MAGIC = b"EBS1"


def encode_stitches(path):
    """Every stitch of a design, for the page's own renderer.

    Binary, as JSON would be several times bigger for a dense design:

        "EBS1", uint32 header length, header (JSON), padding to 4 bytes,
        then int16 x, y pairs in 0.1 mm from the design's top-left corner.

    The header gives the design size, its thread colors, and its runs in
    sewing order: [color index, point count]. A run is stitches sewn one
    after another; a jump, trim or color change starts a new one. All
    little-endian.
    """
    pattern = pyembroidery.read(str(path))
    if pattern is None or not pattern.count_stitches():
        return None
    min_x, min_y, max_x, max_y = pattern.bounds()
    colors, runs, points = [], [], array("h")
    for block, thread in pattern.get_as_stitchblock():
        color = thread_color(thread)
        if color not in colors:
            colors.append(color)
        runs.append([colors.index(color), len(block)])
        for x, y, *_ in block:
            points.append(max(-32768, min(32767, round(x - min_x))))
            points.append(max(-32768, min(32767, round(y - min_y))))
    header = json.dumps({
        "width_mm": round((max_x - min_x) / 10, 1),
        "height_mm": round((max_y - min_y) / 10, 1),
        "colors": colors,
        "runs": runs,
    }).encode()
    header += b" " * (-(8 + len(header)) % 4)
    if sys.byteorder != "little":
        points.byteswap()
    return STITCHES_MAGIC + struct.pack("<I", len(header)) + header + points.tobytes()


FOLDER_SAMPLES = 4


def folder_samples(folder, files):
    """A few designs to show on a folder's card: its own first, then nested ones."""
    designs = [f for f in files if f.suffix.lower() in DESIGN_EXTENSIONS]
    designs.sort(key=lambda f: (len(f.relative_to(folder).parts), str(f.relative_to(folder)).lower()))
    samples = []
    for f in designs[:FOLDER_SAMPLES]:
        st = f.stat()
        samples.append({"name": f.name, "path": rel_of(f), "size": st.st_size,
                        "mtime": int(st.st_mtime), "design": True})
    return samples


# --------------------------------------------------------------- routes

@app.before_request
def reject_cross_site_posts():
    # No login, but at least stop some other web page open in someone's
    # browser from quietly posting uploads/deletes to the Pi.
    if request.method == "POST":
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            abort(403)


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(413)
def json_error(err):
    if err.code == 413:
        message = "That file is too large (1 GB max per file)."
    else:
        message = err.description if isinstance(err.description, str) else err.name
    return jsonify(error=message), err.code


@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(WEB_DIR, name)


@app.get("/api/files")
def api_files():
    folder = resolve(request.args.get("path", ""))
    if not folder.is_dir():
        abort(400, "Not a folder.")
    entries = []
    for p in visible_children(folder):
        st = p.stat()
        if p.is_dir():
            files = list(walk_files(p))
            entries.append({
                "type": "folder",
                "name": p.name,
                "path": rel_of(p),
                "mtime": int(st.st_mtime),
                "count": len(files),
                "pending": sum(1 for f in files if not is_synced(f, f.stat())),
                "samples": folder_samples(p, files),
            })
        elif p.is_file():
            entries.append({
                "type": "file",
                "name": p.name,
                "path": rel_of(p),
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                "synced": is_synced(p, st),
                "design": p.suffix.lower() in DESIGN_EXTENSIONS,
            })
    return jsonify(path=rel_of(folder) if folder != STAGING_DIR else "",
                   entries=entries, status=overall_status())


@app.get("/api/folders")
def api_folders():
    """Every folder, for the move-to picker."""
    found = [""]

    def walk(folder):
        for p in sorted(visible_children(folder), key=lambda p: p.name.lower()):
            if p.is_dir():
                found.append(rel_of(p))
                walk(p)

    walk(STAGING_DIR)
    return jsonify(folders=found)


@app.post("/api/upload")
def api_upload():
    base = resolve(request.form.get("path", ""))
    if not base.is_dir():
        abort(400, "Not a folder.")
    files = request.files.getlist("file")
    relpaths = request.form.getlist("relpath")
    saved, renamed, skipped = [], [], []

    for i, f in enumerate(files):
        original = (relpaths[i] if i < len(relpaths) and relpaths[i] else f.filename) or ""
        raw_parts = [s for s in original.replace("\\", "/").split("/") if s not in ("", ".", "..")]
        parts = [clean_name(s) for s in raw_parts]
        if not parts or not all(parts):
            skipped.append(original)
            continue

        target_dir = base
        for seg in parts[:-1]:
            target_dir = child_ci(target_dir, seg)
            target_dir.mkdir(exist_ok=True)
        if not target_dir.is_dir():
            skipped.append(original)
            continue

        dest = child_ci(target_dir, parts[-1])
        if dest.is_dir():
            skipped.append(original)
            continue
        # Write to a dotfile and rename, so the sync never copies a
        # half-written upload.
        tmp = target_dir / f".{parts[-1]}.uploading"
        try:
            f.save(tmp)
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)
        forget(rel_of(dest))
        saved.append(rel_of(dest))
        if raw_parts[-1] != dest.name:
            renamed.append([raw_parts[-1], dest.name])

    # A batched upload sends final=0 on all but its last request, so the
    # drive is rebuilt once at the end rather than after every batch.
    if saved and request.form.get("final", "1") != "0":
        request_drive_update()
    return jsonify(saved=saved, renamed=renamed, skipped=skipped)


@app.post("/api/mkdir")
def api_mkdir():
    body = request.get_json(silent=True) or {}
    parent = resolve(body.get("path", ""))
    name = clean_name(body.get("name", ""))
    if not name or not parent.is_dir():
        abort(400, "Enter a folder name.")
    target = child_ci(parent, name)
    if target.exists():
        abort(409, f"“{target.name}” already exists here.")
    target.mkdir()
    request_drive_update()
    return jsonify(path=rel_of(target))


@app.post("/api/rename")
def api_rename():
    body = request.get_json(silent=True) or {}
    src = resolve(body.get("path", ""))
    if src == STAGING_DIR:
        abort(400, "Can't rename the top folder.")
    name = clean_name(body.get("name", ""))
    if not name:
        abort(400, "Enter a name.")
    existing = child_ci(src.parent, name)
    if existing.exists() and existing.resolve() != src.resolve():
        abort(409, f"“{existing.name}” already exists here.")
    old_rel = rel_of(src)
    dest = src.parent / name
    src.rename(dest)
    forget(old_rel)
    request_drive_update()
    return jsonify(path=rel_of(dest))


@app.post("/api/move")
def api_move():
    body = request.get_json(silent=True) or {}
    dest_dir = resolve(body.get("dest", ""))
    if not dest_dir.is_dir():
        abort(400, "Not a folder.")
    moved, failed = [], []
    for rel in body.get("paths", []):
        src = resolve(rel)
        target = child_ci(dest_dir, src.name)
        if src == STAGING_DIR or src.parent.resolve() == dest_dir.resolve():
            continue
        if src.is_dir() and (dest_dir.resolve() == src.resolve()
                             or src.resolve() in dest_dir.resolve().parents):
            failed.append([src.name, "can't move a folder into itself"])
            continue
        if target.exists():
            failed.append([src.name, "something with that name is already there"])
            continue
        shutil.move(str(src), str(target))
        forget(rel)
        moved.append(rel_of(target))
    if moved:
        request_drive_update()
    return jsonify(moved=moved, failed=failed)


@app.post("/api/delete")
def api_delete():
    body = request.get_json(silent=True) or {}
    deleted = []
    for rel in body.get("paths", []):
        p = resolve(rel)
        if p == STAGING_DIR:
            continue
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        forget(rel_of(p))
        deleted.append(rel)
    if deleted:
        request_drive_update()
    return jsonify(deleted=deleted)


@app.get("/api/download")
def api_download():
    p = resolve(request.args.get("path", ""))
    if not p.is_file():
        abort(404, "Not found.")
    return send_file(p, as_attachment=True, download_name=p.name)


@app.get("/api/preview")
def api_preview():
    p = resolve(request.args.get("path", ""))
    if pyembroidery is None or not p.is_file():
        abort(404, "No preview.")
    st = p.stat()
    cache = PREVIEW_DIR / (rel_of(p) + ".json")
    try:
        cached = json.loads(cache.read_text())
    except (OSError, ValueError):
        cached = {}
    if cached.get("stamp") == stamp(st) and cached.get("version") == PREVIEW_VERSION:
        data = cached.get("data")
    else:
        # Rendering is the slow part on a Pi Zero, so cache the result
        # (including "not a design") until the file changes.
        try:
            data = render_preview(p)
        except Exception:
            data = None
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"stamp": stamp(st), "version": PREVIEW_VERSION, "data": data}))
    if not data:
        abort(404, "No preview.")
    return jsonify(data)


@app.get("/api/stitches")
def api_stitches():
    p = resolve(request.args.get("path", ""))
    if pyembroidery is None or not p.is_file():
        abort(404, "No preview.")
    st = p.stat()
    # Cached gzipped, as "<stamp>\n<data>"; empty data means "not a design".
    cache = PREVIEW_DIR / (rel_of(p) + ".stitches")
    try:
        cached_stamp, _, data = cache.read_bytes().partition(b"\n")
    except OSError:
        cached_stamp, data = b"", b""
    if cached_stamp.decode(errors="replace") != stamp(st):
        try:
            raw = encode_stitches(p)
        except Exception:
            raw = None
        data = gzip.compress(raw, compresslevel=6, mtime=0) if raw else b""
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(stamp(st).encode() + b"\n" + data)
    if not data:
        abort(404, "No preview.")
    if "gzip" in request.headers.get("Accept-Encoding", ""):
        res = app.response_class(data, mimetype="application/octet-stream")
        res.headers["Content-Encoding"] = "gzip"
    else:
        res = app.response_class(gzip.decompress(data), mimetype="application/octet-stream")
    res.headers["Vary"] = "Accept-Encoding"
    return res


if __name__ == "__main__":
    for d in (STAGING_DIR, STATUS_DIR, PREVIEW_DIR):
        d.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("EMBROIDERY_WEB_PORT", "8080"))
    app.run(host="0.0.0.0", port=port, threaded=True)
