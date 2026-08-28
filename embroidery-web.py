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

from flask import Flask, flash, redirect, render_template_string, request, url_for
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
            onsubmit="return confirm('Delete {{ f.name }}?')">
        <button type=submit>Delete</button>
      </form>
    </td>
  </tr>
  {% else %}
  <tr><td colspan=4>No files staged yet.</td></tr>
  {% endfor %}
</table>
"""


def human_size(n):
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024


def list_files():
    files = []
    for p in sorted(STAGING_DIR.iterdir()):
        if not p.is_file():
            continue
        size = p.stat().st_size
        marker = STATUS_DIR / p.name
        synced = marker.is_file() and marker.read_text().strip() == str(size)
        files.append({"name": p.name, "size_h": human_size(size), "synced": synced})
    return files


@app.route("/")
def index():
    return render_template_string(PAGE, files=list_files())


@app.route("/upload", methods=["POST"])
def upload():
    count = 0
    for f in request.files.getlist("file"):
        if not f or not f.filename:
            continue
        name = secure_filename(f.filename)
        if not name:
            continue
        f.save(STAGING_DIR / name)
        # New content invalidates any prior "synced" marker for this name.
        (STATUS_DIR / name).unlink(missing_ok=True)
        count += 1
    flash(f"Uploaded {count} file(s)." if count else "No files uploaded.")
    return redirect(url_for("index"))


@app.route("/delete/<name>", methods=["POST"])
def delete(name):
    name = secure_filename(name)
    dest = STAGING_DIR / name
    if name and dest.is_file():
        dest.unlink()
        (STATUS_DIR / name).unlink(missing_ok=True)
        flash(f"Deleted {name}.")
    return redirect(url_for("index"))


if __name__ == "__main__":
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("EMBROIDERY_WEB_PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
