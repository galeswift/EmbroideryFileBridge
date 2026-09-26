# EmbroideryFileBridge

A Raspberry Pi file bridge for a USB-connected embroidery machine
(Babylock/Brother and similar), based on
[yaheath/pi-file-bridge](https://github.com/yaheath/pi-file-bridge) —
with two important differences:

1. **Files you send are kept on the Pi and are not lost** if the
   machine is off, or gets powered off/restarted soon after a copy.
2. **No Samba/SMB.** Instead, the Pi serves a small local-network web
   page — open it in a browser, upload a file, done. No network
   discovery, no guest-auth Windows security settings, nothing to
   install on your PC.

## Why this exists

In the original design, the Samba share is wired directly to the
embroidery machine's own USB mass-storage volume: connecting to the
share mounts `/dev/sda` (the machine) for the duration of the SMB
session and unmounts it when the session closes. There's no storage
of any kind on the Pi itself — you're writing straight through to the
machine over a mount that only exists while a client is actively
connected.

That's fragile in practice:

* If the machine is off, there is nothing to mount — copies silently
  fail or never happen.
* Windows/macOS often keep an SMB session open in the background
  after a copy finishes, so the `umount` (and the filesystem flush
  that comes with it) may not happen until well after you think the
  copy is done. Turn the machine off in that window and whatever was
  still in the write-back cache is gone.
* Many embroidery machines' USB mass-storage firmware holds newly
  written files in a volatile scratch buffer while connected in "PC
  link" mode, and only commits them to the machine's real, durable
  storage on a proper safe-removal signal. A plain host-side
  `mount`/`sync`/`umount` doesn't guarantee that happens. The file
  looks completely normal — browsable, correct size — right up until
  the *machine itself* is power-cycled, at which point it reloads its
  last durably-committed state and the file is just gone. This is the
  "files show up fine, then vanish after restarting the machine"
  symptom.
* There's no local record of what you sent, so there's no way to
  recover after a loss like either of those.

On top of that, Samba itself is a source of friction on modern
Windows: guest access to unauthenticated shares has been disabled by
default since Windows 10 1709, so getting a "guest ok" share like the
original project's to even show up usually means changing a Local
Group Policy / registry setting (and sometimes installing the legacy
SMB1 client). That's a client-side security posture, not something
fixable from the Pi. A browser-based upload page sidesteps all of it.

## How this version works

1. **A small Flask web app serves a persistent staging directory on
   the Pi's SD card** (`/srv/embroidery/incoming`), not the machine
   itself. Open `http://<pi>:8080` from any device on the network,
   upload a file, and it's saved straight to the Pi — no client setup,
   works whether or not the embroidery machine is currently on. The
   page gives you:
   * **Design previews**: each embroidery file (PES, DST, JEF, EXP,
     VP3, …) is drawn as a thumbnail from its stitch data. Click one
     for a larger view with its size, stitch count and thread colors.
   * **Folders**: create folders, upload whole folders (button or drag
     and drop), and move things between them. Folders are mirrored onto
     the machine.
   * **Multi-select**: checkboxes, shift-click for a range, Ctrl/⌘+A for
     everything, then move, download or delete in one go. Drag items
     onto a folder (or a folder in the path at the top) to move them.
   * **Live status**: whether the machine is connected, how many files
     are still waiting to be copied, when the last sync ran, and a
     per-file "On machine" / "Waiting" badge.
   * Search, sorting, grid or list view, rename, download, keyboard
     shortcuts (`/` search, `Del` delete, `Esc` clear, arrows in the
     preview), dark mode, and a phone-friendly layout.
2. **A small sync service pushes staged files onto the machine**
   whenever it's actually present:
   * A udev rule (`99-embroidery-bridge.rules`) starts the sync the
     moment the machine's USB mass-storage device appears (i.e. it
     was just plugged in or switched on). This run checks *every*
     staged file against the machine.
   * A systemd timer (`embroidery-sync.timer`) runs the sync every 60
     seconds to pick up new uploads while the machine is already
     connected. It only mounts the machine when some staged file
     hasn't been copied yet, so an idle machine isn't mounted over
     and over.
   * Each sync run mounts the machine, copies what's needed, flushes,
     and unmounts again immediately — keeping the "machine is mounted
     and vulnerable to a power cut" window as short as possible. If a
     run fails partway (e.g. the machine's storage is full), it still
     unmounts, and a mount left over from a crash or power loss is
     cleared by the next run.
3. **The machine is never trusted as the source of truth.** After each
   copy, the sync records the staged file's size and modification time
   in `/srv/embroidery/.sync-status/`. A file counts as synced only if
   that record matches the staged file as it is now *and* the machine
   has a same-size copy. So:
   * If a machine power-cycle silently drops a file (or leaves a
     truncated remnant), the check on reconnect notices and re-copies
     it, with no action needed from you.
   * Re-uploading a changed design under the same name always gets
     re-copied, even if the new version happens to be the same size.
   * The web UI shows a "synced to machine" / "pending" badge per file
     from those records, without touching the machine itself.
4. Files already copied to the machine are left in the staging
   directory as a local archive/history. Delete a file from the web
   UI (or `/srv/embroidery/incoming` directly) once you no longer need
   the local copy. This only removes the Pi's copy; the file stays on
   the machine until you delete it there.

## Required parts

Same as the original project:

* Raspberry Pi Zero W or Raspberry Pi 3 Model B (or similar, with
  built-in Wi-Fi)
* Power supply for the Pi
* MicroSD card (8GB+)
* USB-2 A-to-B cable
* USB OTG adaptor if using a Pi Zero W

## Setup

1. Install Raspberry Pi OS, get the Pi on your Wi-Fi, and enable SSH
   (via `raspi-config`), same as usual.

2. On the Pi, clone this repo and run the installer:

       git clone https://github.com/galeswift/EmbroideryFileBridge.git
       cd EmbroideryFileBridge
       sudo ./install.sh

   That's the whole setup — `install.sh` installs the required
   packages (`python3-flask`, `python3-venv`, and the `pyembroidery`
   library for previews), creates the staging directory, and installs
   the sync script, web UI, systemd units, and udev rule for you.

   By default the staging directory and web UI run as whichever
   account you ran `sudo` as. To use a different account:

       sudo TARGET_USER=someuser ./install.sh

   <details>
   <summary>What the installer does, if you'd rather do it by hand</summary>

   1. `apt install python3-flask python3-venv`
   2. `mkdir -p /srv/embroidery/{incoming,.sync-status,.previews} /mnt/machine`
      and `chown` those three `/srv/embroidery` directories to your user
   3. Copy `embroidery-sync.sh` to `/usr/local/bin/`, `chmod 755`
   4. Copy `embroidery-web.py` and the `web/` folder to
      `/opt/embroidery-bridge/`, then create a venv there with
      `python3 -m venv --system-site-packages /opt/embroidery-bridge/venv`
      and `/opt/embroidery-bridge/venv/bin/pip install pyembroidery==1.5.1`
   5. Copy `embroidery-sync.service`, `embroidery-sync.timer`, and
      `embroidery-web.service` (with `User=` set to your account) to
      `/etc/systemd/system/`, then
      `systemctl daemon-reload && systemctl enable --now embroidery-sync.timer embroidery-web.service`
   6. Copy `99-embroidery-bridge.rules` to `/etc/udev/rules.d/`, then
      `udevadm control --reload-rules`

   </details>

## Updating

On the Pi, pull the latest version and re-run the installer. It's safe
to run again and restarts the web UI for you:

    cd EmbroideryFileBridge
    git pull
    sudo ./install.sh

## Try it out

1. From your PC/Mac/phone, open `http://<pi-hostname>.local:8080` (the
   installer prints the exact URL) and upload a design file — this
   works whether or not the embroidery machine is currently on.
2. Connect the USB A-to-B cable from the Pi to the machine's "B" port
   and power the machine on. Within a few seconds (udev-triggered) or
   up to a minute (timer fallback), the file appears on the machine,
   and the web page shows it as "synced to machine".
3. Check `journalctl -t embroidery-sync` on the Pi to see sync
   activity.

## Notes

* This should work with any machine that presents itself as USB mass
  storage without a partition table (Brother machines included, per
  the original project's notes).
* The sync treats the first USB disk it finds (other than the Pi's own
  boot disk) as the embroidery machine, so don't leave a thumb drive
  plugged into the Pi. If you need to, pin the machine's device by
  adding `Environment=EMBROIDERY_DEVICE=/dev/...` to
  `embroidery-sync.service`.
* The machine's storage ignores filename case, so uploading `rose.pes`
  replaces a staged `Rose.pes` (and `flowers/` merges into `Flowers/`).
  Names are also cleaned up on upload: characters the machine's
  storage can't hold (`: * ? " < > | \`) become `_`, and accented or
  non-Latin letters are reduced to plain ASCII. The page tells you when
  that happens.
* Moving, renaming or deleting on the page only changes the Pi's copy.
  A moved or renamed file is copied to its new place on the machine,
  but the old copy stays there until you delete it on the machine.
* Because the staging directory is the durable copy, it's safe to
  power the machine off at any time — the worst case is that a
  not-yet-synced file just waits for the next time the machine is on.
* The web UI has no login, matching the guest-only, no-auth trust
  model of the Samba share it replaces — anyone on your LAN can
  upload/delete staged files. Fine for a trusted home network; if
  yours isn't, put it behind a reverse proxy or VPN rather than
  exposing it further.
* It runs on Flask's built-in development server, which is fine for a
  handful of LAN clients hitting it occasionally (this is not an
  internet-facing service). If you ever need more concurrency, swap
  `embroidery-web.service`'s `ExecStart` for a production WSGI server
  (e.g. `gunicorn`).

## Development

The test suite covers the web API, the sync script (run for real
against temporary folders, with `mount` and friends stubbed out), and
the page itself in a headless browser.

    pip install -r requirements-dev.txt
    python -m pytest

The browser tests need Playwright and a Chromium browser; they're
skipped automatically when those aren't installed:

    pip install playwright
    python -m playwright install chromium   # or use an installed Google Chrome

To try the web UI on a PC without a Pi, just run it. On Windows its
data goes in folders next to the script; elsewhere set
`EMBROIDERY_STAGING_DIR` and friends to somewhere writable:

    python embroidery-web.py      # then open http://localhost:8080
