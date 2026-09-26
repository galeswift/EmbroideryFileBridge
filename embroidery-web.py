#!/usr/bin/env python3
"""
Minimal LAN web UI for the embroidery file bridge staging directory.

Lets anyone on the local network browse, upload to, and delete from the
same staging directory embroidery-sync.sh watches -- no Samba/SMB
client configuration required. Intentionally has no authentication,
matching the guest-only trust model of the Samba share it replaces: if
your network isn't trusted, put this behind a reverse proxy or VPN
rather than exposing it further.
"""
import os
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, flash, redirect, render_template_string, request, url_for
from werkzeug.utils import secure_filename

# /srv/embroidery/... is a Linux-only convention (the Pi). On Windows,
# a leading "/" resolves against the current drive root instead of
# being a real absolute path, so a Windows run would otherwise create
# e.g. D:\srv\embroidery\incoming. Fall back to a folder next to this
# script there instead -- only affects the default, and only on
# Windows; the EMBROIDERY_* env vars always win, and Pi behavior is
# unchanged.
if os.name == "nt":
    _DEFAULT_STAGING_DIR = Path(__file__).resolve().parent / "incoming"
    _DEFAULT_STATUS_DIR = Path(__file__).resolve().parent / ".sync-status"
else:
    _DEFAULT_STAGING_DIR = Path("/srv/embroidery/incoming")
    _DEFAULT_STATUS_DIR = Path("/srv/embroidery/.sync-status")

STAGING_DIR = Path(os.environ.get("EMBROIDERY_STAGING_DIR", _DEFAULT_STAGING_DIR))
STATUS_DIR = Path(os.environ.get("EMBROIDERY_STATUS_DIR", _DEFAULT_STATUS_DIR))

app = Flask(__name__)
app.secret_key = os.environ.get("EMBROIDERY_SECRET_KEY") or os.urandom(24)
# Embroidery designs are a few MB at most; this just keeps one bad
# upload from filling the SD card.
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

PAGE = """
<!doctype html>
<title>Embroidery File Bridge</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #ddd; }
  form.inline { display: inline; }
  .flashes { list-style: none; padding: 0; }
  .flashes li { background: #eef; padding: 0.4rem 0.6rem; margin-bottom: 0.3rem; border-radius: 4px; }
  button { cursor: pointer; }
  .note { color: #666; font-size: 0.9rem; }
</style>
<h1>Embroidery File Bridge</h1>
{% with messages = get_flashed_messages() %}
  {% if messages %}
    <ul class=flashes>{% for m in messages %}<li>{{ m }}</li>{% endfor %}</ul>
  {% endif %}
{% endwith %}
<form method=post enctype=multipart/form-data action="{{ url_for('upload') }}">
  <input type=file name=file multiple required>
  <button type=submit>Upload</button>
</form>
<table>
  <tr><th>File</th><th>Size</th><th>Status</th><th></th></tr>
  {% for f in files %}
  <tr>
    <td>{{ f.name }}</td>
    <td>{{ f.size_h }}</td>
    <td>{{ "synced to machine" if f.synced else "pending" }}</td>
    <td>
      <form class=inline method=post action="{{ url_for('delete', name=f.name) }}"
            onsubmit='return confirm({{ ("Delete " ~ f.name ~ "?")|tojson }})'>
        <button type=submit>Delete</button>
      </form>
    </td>
  </tr>
  {% else %}
  <tr><td colspan=4>No files staged yet.</td></tr>
  {% endfor %}
</table>
<p class=note>Delete removes the Pi's copy only. A file already copied to
the machine stays there until you delete it on the machine.</p>
"""


def human_size(n):
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024


def staged_files():
    # Dotfiles are uploads still in progress (see upload()).
    return sorted(
        p for p in STAGING_DIR.iterdir() if p.is_file() and not p.name.startswith(".")
    )


def is_synced(path):
    # Must match what embroidery-sync.sh writes: "<size> <mtime>" of the
    # staged file it copied, so a changed file shows as pending again.
    st = path.stat()
    marker = STATUS_DIR / path.name
    return marker.is_file() and marker.read_text().strip() == f"{st.st_size} {int(st.st_mtime)}"


def forget(path):
    path.unlink(missing_ok=True)
    (STATUS_DIR / path.name).unlink(missing_ok=True)


@app.before_request
def reject_cross_site_posts():
    # No login, but at least stop some other web page open in someone's
    # browser from quietly posting uploads/deletes to the Pi.
    if request.method == "POST":
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            abort(403)


@app.errorhandler(413)
def too_large(_):
    flash("That upload is too large (64 MB max).")
    return redirect(url_for("index"))


@app.route("/")
def index():
    files = [
        {"name": p.name, "size_h": human_size(p.stat().st_size), "synced": is_synced(p)}
        for p in staged_files()
    ]
    return render_template_string(PAGE, files=files)


@app.route("/upload", methods=["POST"])
def upload():
    count = 0
    for f in request.files.getlist("file"):
        if not f or not f.filename:
            continue
        name = secure_filename(f.filename)
        if not name:
            flash(f"Skipped {f.filename!r}: no usable characters in its name.")
            continue
        if name != f.filename:
            flash(f"Saved {f.filename!r} as {name!r}.")

        # The machine's FAT storage ignores case, so an upload named
        # rose.pes replaces a staged Rose.pes rather than sitting next
        # to it and fighting over the same file on the machine.
        for p in staged_files():
            if p.name != name and p.name.lower() == name.lower():
                forget(p)

        # Write to a dotfile and rename, so the sync never copies a
        # half-written upload.
        tmp = STAGING_DIR / f".{name}.uploading"
        try:
            f.save(tmp)
            os.replace(tmp, STAGING_DIR / name)
        finally:
            tmp.unlink(missing_ok=True)
        (STATUS_DIR / name).unlink(missing_ok=True)
        count += 1
    flash(f"Uploaded {count} file(s)." if count else "No files uploaded.")
    return redirect(url_for("index"))


@app.route("/delete/<name>", methods=["POST"])
def delete(name):
    # Only delete an exact match for a listed file. That can't escape the
    # staging directory, and also works for files copied in by other
    # means whose names upload() would have cleaned up.
    for p in staged_files():
        if p.name == name:
            forget(p)
            flash(f"Deleted {name}.")
            break
    return redirect(url_for("index"))


if __name__ == "__main__":
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("EMBROIDERY_WEB_PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
