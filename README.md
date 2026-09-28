# EmbroideryFileBridge

A Raspberry Pi Zero that sits next to a USB-capable embroidery machine
(built on a Brother PR-S100 / Persona, and should suit other Brother and
Baby Lock machines) and acts as **its USB flash drive** — one you fill
from any phone or computer on your network, through a web page.

* **Nothing is lost when the machine is switched off.** The drive lives
  on the Pi, not in the machine's memory.
* **Your whole library fits,** in folders, which the machine can browse.
* **No software to install** on your computer: open a web page, drop in
  designs, done.

Inspired by [yaheath/pi-file-bridge](https://github.com/yaheath/pi-file-bridge).

## Why it works this way

The original project connects the Pi to the machine's **USB-B
("computer") port** and writes designs into what the machine presents
there. On a Brother machine, that turns out to be a tiny **RAM disk**
(`B-EMB USB RAM DISK`, 1 MB, roughly 790 KB usable) behind the machine's
"PC" button:

* it's **wiped whenever the machine is turned off** — the "files show up,
  then vanish after restarting the machine" problem;
* it holds only a handful of designs;
* the machine **ignores folders** on it ([Brother](https://help.brother-usa.com/app/answers/detail/a_id/56127/~/transfer-designs-from-the-computer-using-the-usb-cable):
  *"Do not create folders within 'Removable Disk'. Since folders are not
  displayed…"*).

A Pi Zero's USB port can instead run in **device mode** and pretend to be
a **USB flash drive**. Plugged into the machine's **USB-A port**, it shows
up under the machine's USB-drive button like any memory stick — with
none of those limits.

## How it works

1. **The library** lives on the Pi's SD card (`/srv/embroidery/incoming`).
   A small web app (`embroidery-web.py`, port 8080) lets you manage it
   from any device on your network:
   * **Design previews** drawn from each file's stitch data (PES, DST,
     JEF, EXP, VP3, …), with a detail view showing size, stitch count and
     thread colors.
   * **A realistic stitch view**: opening a design builds every stitch
     as a 3D strand of thread, stacked in sewing order the way the
     machine lays them down, and lights it (WebGL, in your browser; a
     simpler drawing on devices without it). Scroll or pinch to zoom right in
     on the stitches, drag to look around, double-click to fit, and
     tilt it with the slider to see it at an angle.
   * **Folders**: create them, upload whole folders (button or drag and
     drop), move things between them. Each folder's card previews a few
     of the designs inside it.
   * **Multi-select**: checkboxes, shift-click ranges, Ctrl/⌘+A, then
     move, download or delete in one go; or drag items onto a folder.
   * **Live status**: whether the machine is connected, and an
     "On machine" / "Updating" badge per file.
   * Search, sort, grid or list view, rename, keyboard shortcuts (`/`
     search, `Del` delete, `Esc` clear, arrows in the preview), dark
     mode, and a phone-friendly layout.
2. **The USB drive** is a FAT32 disk image (`/srv/embroidery/usb-drive.img`)
   that the Pi presents to the machine using the Linux `g_mass_storage`
   USB gadget. `embroidery-drive.py` keeps it in step with the library:
   * After every change on the web page (and once a minute as a safety
     net), it builds a fresh image next to the live one, then briefly
     **"unplugs" the drive, swaps the new image in, and "plugs" it back
     in** — just like swapping USB sticks. The live drive is never edited
     while the machine might be reading it.
   * **Designs saved on the machine** onto the USB drive are imported
     into the library before any rebuild, so they're never lost. If the
     machine changes a file the Pi put there, both versions are kept
     (`name (from machine).pes`). A file deleted on the machine comes
     back — the library is what decides what's on the drive.
   * The drive grows automatically with the library (256 MB minimum).

## Required parts

* **Raspberry Pi Zero W or Zero 2 W.** It must be able to act as a USB
  device: Zero models can, a Pi 3 can't. (A Pi 4 or 5 can too, through
  its USB-C port, but hasn't been tried.)
* Power supply for the Pi
* MicroSD card (8GB+)
* **Micro-USB to USB-A data cable** (an ordinary phone cable that carries
  data, not a charge-only one)

## Setup

1. Flash **Raspberry Pi OS Lite** with Raspberry Pi Imager (choose your
   exact Pi model — the original Zero W needs the 32-bit version). In
   Imager's settings, set a hostname, a username and password, your
   Wi-Fi (the Zero W is 2.4 GHz only), and turn on SSH.

2. On the Pi, clone this repo and run the installer:

       git clone https://github.com/galeswift/EmbroideryFileBridge.git
       cd EmbroideryFileBridge
       sudo ./install.sh

   It installs the required packages (`python3-flask`, `python3-venv`,
   `mtools`, `dosfstools`, and the `pyembroidery` library for previews),
   switches the USB port into device mode, and installs the drive
   manager, web UI and their systemd units. By default everything
   belongs to the account you ran `sudo` as; to use another:

       sudo TARGET_USER=someuser ./install.sh

3. **Reboot** when the installer asks (the first time only):
   `sudo reboot`

4. **Connect the Pi to the machine:** the Pi's **USB** port (the middle
   one, *not* PWR) to the machine's **USB-A** flash-drive port. Keep the
   Pi's own power adapter in **PWR**.

<details>
<summary>What the installer does, if you'd rather do it by hand</summary>

1. `apt install python3-flask python3-venv mtools dosfstools fdisk`
2. `mkdir -p /srv/embroidery/{incoming,.sync-status,.previews,.requests}`
   and `chown` those to your user
3. Copy `embroidery-drive.py`, `embroidery-web.py` and the `web/` folder
   to `/opt/embroidery-bridge/`; create a venv there with
   `python3 -m venv --system-site-packages /opt/embroidery-bridge/venv`
   and `/opt/embroidery-bridge/venv/bin/pip install pyembroidery==1.5.1`
4. Add `dtoverlay=dwc2` under `[all]` in `/boot/firmware/config.txt`
5. Copy `embroidery-drive.service`, `.timer`, `.path` and
   `embroidery-web.service` (with `User=` set to your account) to
   `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now embroidery-drive.timer embroidery-drive.path embroidery-web.service`
6. Reboot

It also removes the pieces of older versions of this project (the
PC-link sync script, its systemd units and udev rule), if present.

</details>

## Using it

1. Open `http://<pi-hostname>.local:8080` (the installer prints the exact
   address) and upload designs — whole folders too.
2. Within a few seconds the page shows them as **On machine**.
3. On the machine, press the **USB flash drive** button and pick a design.

If the machine is showing the drive's contents while you change the
library, it may briefly lose the drive as the Pi swaps in the update —
just open it again.

Check the drive manager's activity with `journalctl -t embroidery-drive`.

## Updating

On the Pi, pull the latest version and re-run the installer. It's safe
to run again and restarts everything for you:

    cd EmbroideryFileBridge
    git pull
    sudo ./install.sh

## Notes

* The PR-S100's maximum embroidery area is 8" × 8" (about 200 × 200 mm).
  The machine doesn't list designs bigger than it can stitch, so the page
  marks those with a red **Too big** badge (hover it, or open the design,
  for its size). For a different machine, set its largest hoop in
  `embroidery-web.service`, e.g.
  `Environment=EMBROIDERY_HOOP_MM=130x180`, and re-run the installer.
* Deleting on the page removes the design from the Pi **and** the drive.
* The drive is FAT, which ignores filename case: uploading `rose.pes`
  replaces a staged `Rose.pes` (and `flowers/` merges into `Flowers/`).
  Names are cleaned up on upload — characters FAT can't hold
  (`: * ? " < > | \`) become `_`, accented or non-Latin letters are
  reduced to plain ASCII — and the page tells you when that happens.
* The web UI has no login — anyone on your LAN can upload and delete.
  Fine for a trusted home network; if yours isn't, put it behind a
  reverse proxy or VPN rather than exposing it further.
* It runs on Flask's built-in server, which is plenty for a few people
  on a home network (it isn't meant to face the internet).
* To go back to the Pi's USB port working normally (host mode), remove
  the `dtoverlay=dwc2` line the installer added to
  `/boot/firmware/config.txt` (a backup is at
  `config.txt.before-embroidery-bridge`) and reboot.

## Development

The test suite covers the web API, the drive manager (building real
FAT32 drive images, with the USB gadget faked), and the page itself in a
headless browser.

    pip install -r requirements-dev.txt
    python -m pytest

* The drive tests need Linux with `mtools`, `dosfstools` and `sfdisk`
  (e.g. run them on the Pi); they're skipped elsewhere.
* The browser tests need Playwright and a Chromium browser; they're
  skipped when those aren't installed:

      pip install playwright
      python -m playwright install chromium   # or use an installed Google Chrome

To try the web UI on a PC without a Pi, just run it. On Windows its data
goes in folders next to the script; elsewhere set
`EMBROIDERY_STAGING_DIR` and friends to somewhere writable:

    python embroidery-web.py      # then open http://localhost:8080
