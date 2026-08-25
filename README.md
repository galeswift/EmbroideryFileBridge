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
   works whether or not the embroidery machine is currently on.
2. **A small sync service pushes staged files onto the machine**
   whenever it's actually present:
   * A udev rule (`99-embroidery-bridge.rules`) starts the sync the
     moment the machine's USB mass-storage device appears (i.e. it
     was just plugged in or switched on).
   * A systemd timer (`embroidery-sync.timer`) re-runs the sync every
     60 seconds as a fallback, in case a udev event is ever missed or
     a file was staged while the machine was already connected.
   * Each sync run mounts the machine, copies over any files that are
     missing or size-mismatched on the machine, flushes, and unmounts
     again immediately — keeping the "machine is mounted and
     vulnerable to a power cut" window as short as possible, rather
     than leaving it mounted indefinitely. It also sends a SCSI
     "safe to remove" request (`eject -s`) after unmounting, since
     that's the signal some machine firmware actually uses to commit
     pending writes, rather than a plain unmount.
3. **The machine is never trusted as the source of truth.** A file is
   only skipped on a sync run if it's already on the machine *and* the
   same size as the staged copy. That matters specifically because of
   the volatile-buffer issue above: if a machine power-cycle silently
   drops a file (or leaves a truncated remnant), the very next time
   that machine's USB device is seen again, the sync will notice the
   mismatch and re-copy it — automatically, with no action needed from
   you. The sync script records each successful copy's size in
   `/srv/embroidery/.sync-status/`, which is how the web UI shows a
   "synced to machine" / "pending" badge per file without needing to
   touch the (transiently mounted) machine itself.
4. Files already copied to the machine are left in the staging
   directory as a local archive/history. Delete a file from the web
   UI (or `/srv/embroidery/incoming` directly) once you no longer need
   the local copy.

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
   packages (`eject`, `python3-flask`), creates the staging directory,
   and installs the sync script, web UI, systemd units, and udev rule
   for you. It's safe to re-run (e.g. after `git pull`ing an update).

   By default the staging directory and web UI run as whichever
   account you ran `sudo` as. To use a different account:

       sudo TARGET_USER=someuser ./install.sh

   <details>
   <summary>What the installer does, if you'd rather do it by hand</summary>

   1. `apt install eject python3-flask`
   2. `mkdir -p /srv/embroidery/incoming /srv/embroidery/.sync-status /mnt/machine`
      and `chown` the staging/status directories to your user
   3. Copy `embroidery-sync.sh` to `/usr/local/bin/`, `chmod 755`
   4. Copy `embroidery-web.py` to `/usr/local/bin/`, `chmod 755`
   5. Copy `embroidery-sync.service`, `embroidery-sync.timer`, and
      `embroidery-web.service` (with `User=` set to your account) to
      `/etc/systemd/system/`, then
      `systemctl daemon-reload && systemctl enable --now embroidery-sync.timer embroidery-web.service`
   6. Copy `99-embroidery-bridge.rules` to `/etc/udev/rules.d/`, then
      `udevadm control --reload-rules`

   </details>

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
* The sync assumes the only external USB storage device attached to
  the Pi is the embroidery machine. Plugging in anything else (e.g. a
  thumb drive) may confuse the udev rule/mount logic.
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
