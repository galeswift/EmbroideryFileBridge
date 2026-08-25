# EmbroideryFileBridge

A Raspberry Pi file bridge for a USB-connected embroidery machine
(Babylock/Brother and similar), based on
[yaheath/pi-file-bridge](https://github.com/yaheath/pi-file-bridge) —
with one important difference: **files you copy to the share are kept
on the Pi and are not lost if the machine is off or gets powered off
soon after a copy.**

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

## How this version works

1. **The Samba share points at a persistent staging directory on the
   Pi's SD card** (`/srv/embroidery/incoming`), not at the machine.
   Copying a file to the share always succeeds and always survives,
   independent of whether the machine is connected or powered on.
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
   you. Files already copied to the machine are left in the staging
   directory as a local archive/history; delete a file from
   `/srv/embroidery/incoming` yourself once you no longer need the
   local copy.

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

2. Install samba and the eject utility (used to signal the machine to
   commit pending writes after each sync):

       sudo apt install samba eject

3. Create the staging directory and the machine's mount point:

       sudo mkdir -p /srv/embroidery/incoming /mnt/machine
       sudo chown pi:pi /srv/embroidery/incoming

4. Install the sync script:

       sudo cp embroidery-sync.sh /usr/local/bin/embroidery-sync.sh
       sudo chmod 755 /usr/local/bin/embroidery-sync.sh

5. Install and enable the systemd units:

       sudo cp embroidery-sync.service /etc/systemd/system/
       sudo cp embroidery-sync.timer /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl enable --now embroidery-sync.timer

6. Install the udev rule so a sync fires as soon as the machine is
   plugged in / turned on:

       sudo cp 99-embroidery-bridge.rules /etc/udev/rules.d/
       sudo udevadm control --reload-rules

7. Install the Samba config:

       sudo cp smb.conf /etc/samba/smb.conf
       sudo systemctl restart smbd

## Try it out

1. From your PC/Mac, connect to the Pi's `machine` share over the
   network and drop a design file in — this works whether or not the
   embroidery machine is currently on.
2. Connect the USB A-to-B cable from the Pi to the machine's "B" port
   and power the machine on. Within a few seconds (udev-triggered) or
   up to a minute (timer fallback), the file appears on the machine.
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
