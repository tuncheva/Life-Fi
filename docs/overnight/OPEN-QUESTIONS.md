# Open questions for the owner (overnight run, 2026-11-03)

Each item: what was decided in the meantime, and what we need from you.

1. **Branch base.** `origin/dev` did not contain your latest work
   (963c980 on `feat/usb-live-next-backend-spot-model`: live USB, backend in
   Next, live 3D views, spot model). `feat/overnight` = `origin/dev` + a merge
   of that branch (no conflicts). *Need:* confirm that is what you wanted.
2. **ESP32 not detected.** At 02:58 Windows showed only COM1, no USB serial
   device (CH340 / CP210x). All testing was done on replays of real
   recordings. *Need:* plug the board in / check the cable; the first live
   run should be `npm run dev`.
3. **Track A: fixed transmitter.** The labelled spot sessions were recorded
   with the phone hotspot as transmitter; distance correlates with the true
   distance with the wrong sign and the spot model is below chance across
   sessions. *Decided:* ship occupancy (empty / occupied / unsure) as the main
   "where" signal and mark distance `quality: "low"` (reason
   `transmitter_not_fixed`). *Need:* a fixed transmitter (router or 2nd ESP32)
   for the next recordings, and set `transmitter_fixed` in the rules then.
4. **Track A: spot recordings.** Was the phone held by the person during the
   spot sessions or lying still? *Need:* 3+ new labelled sessions with the
   fixed transmitter, each starting and ending with 60 s of empty room.
3. **(Track C) Dashboard bind address.** `npm run start` will bind the
   dashboard to `0.0.0.0:3000` (phones on the LAN need it, and ntfy ack links
   point at it). *Need:* confirm LAN access is wanted, or say "localhost only".
4. **(Track C) PIN storage.** The PIN stays plain text in `data/settings.json`
   (default `1234` until changed; the server now warns and `/api/v1/setup`
   flags it). Hashing it means a reset procedure if forgotten. *Need:* hash it
   (reset = delete the field) or keep plain text?
5. **(Track C) Recordings retention.** History/alerts are purged after
   `retention_days` (30); recordings in `data/sessions/` are never deleted
   automatically because they are training data. *Need:* confirm, or give a cap.
6. **(Track C) CI scope.** CI runs on Linux only, on pushes to main/dev and
   PRs. *Need:* also run on `feat/**` pushes? Add a Windows job (the appliance
   runs on Windows)?
3. **Taught-spot guess on the consumer view (track B).** The spot model scored
   19 % across sessions with the phone hotspot as transmitter. *Decided:* the room
   view shows "probably: <spot>" only when the model is ≥ 70 % sure and marks it
   experimental; the full spot view stays on Setup → "Spot model view" (/model).
   *Need:* hide it from consumers entirely until a fixed transmitter is in place?
4. **Nav: "Model" and "Emergency" (track B).** *Decided:* consumer nav is only
   "Room" and "Alerts"; /model and the teammate's /emergency building demo move
   into the Setup menu (pages unchanged). *Need:* should /emergency stay a
   top-level tab for the pitch?
5. **Room size and transmitter position (track B).** The 2D room view needs the
   room's size and where the transmitter is. *Decided:* default 4 × 3 m, sensor on
   the middle of one wall, entered in the new /setup flow and kept per browser
   until the server stores it. *Need:* the real room size and where the sensor and
   transmitter sit.
6. **Distances on consumer screens (track B).** *Decided:* consumers see rounded
   distances ("about 2 m", "less than 1 m") and zone words; decimals and ± only
   in the installer sections. *Need:* OK, or do you want "2.1 m" on the hero?

**(Track D) Fixed transmitter firmware.**

- **Which spare board?** Builds are prepared for a classic ESP32 dev board
  (`esp32dev_tx`), an ESP32-S3 DevKitC (`esp32s3_tx`) and a second
  ESP32-CAM (`esp32cam_tx`). *Need:* which one you have (and whether its
  LED is on GPIO 2), so the guide's first command is the right one.
- **Channel.** *Decided:* channel 11 (Espressif's esp-csi default); the
  receiver sweeps all channels, so changing it is one TX console command.
  *Need:* which channel your router / neighbours use, if you know.
- **Priority over Wi-Fi.** *Decided:* when the fixed transmitter is found at
  boot, the receiver uses it even if Wi-Fi credentials are saved (`tx off`
  on the receiver restores the old behaviour). *Need:* confirm.
- **Untested on hardware.** Firmware compiles only; nothing was flashed.
  *Need:* first morning check per `docs/hardware/fixed-transmitter.md`.

**(Track F) Teach spots from the dashboard.**

- **Spot names and distances.** *Decided:* default `close 0.5 m`, `middle 1.5 m`,
  `far 3 m`, editable on /teach and reused for every session. *Need:* the real spots
  you want (e.g. desk, bed, sofa) and their measured distances, before session 1:
  all sessions must use the same names.
- **Session length.** *Decided:* 60 s empty, each spot 45 s, two rounds (second in
  reverse order), 60 s empty: about 8 min per session; 3 sessions at different times.
  *Need:* OK, or shorter (1 round, about 5 min)?
- **Auto-install rule.** *Decided:* a newly trained model is installed only if its
  cross-session score (above chance) is not worse than the current one by more than
  2 points; the old model is kept as `data/spots_model.prev.json`; "Install anyway"
  needs a confirm. Old phone-hotspot sessions are left out of training by default.
  *Need:* confirm, or always install the newest?
- **Voice.** *Decided:* the phone/browser speaks the prompts; optional "also speak
  from the dashboard PC" (Windows voice, off by default). *Need:* which device you
  will carry while recording.
