# Open questions for the owner (overnight run, 2026-11-03)

Each item: what was decided in the meantime (already built that way), and what
we need from you. Ordered by how much it matters. Plans with the full reasoning
are in [plans/](plans/).

## Blocking accuracy

1. **Fixed transmitter.** Every position number tonight is limited by the phone
   hotspot as transmitter: distance correlates with the true distance with the
   *wrong sign* in one session, and the spot model is at or below chance across
   sessions. *Built:* firmware for a second ESP32 as a fixed 100 Hz ESP-NOW
   transmitter (`docs/hardware/fixed-transmitter.md`, compile-only).
   *Need:* which spare board you have — classic ESP32 dev board
   (`esp32dev_tx`) or a second ESP32-CAM (`esp32cam_tx`); the S3 variant was
   dropped — and whether its LED is on GPIO 2.
2. **New labelled recordings.** *Need:* 3+ spot sessions with the fixed
   transmitter, at different times, each starting and ending with ~60 s of
   empty room. Was the phone held by the person in the old sessions, or lying
   still?
3. **ESP32 not detected.** All night Windows showed only COM1 (no CH340 /
   CP210x). Everything was tested on replays of real recordings. *Need:* check
   the cable; first live run is `npm run dev`.

## Product decisions (built with a default)

4. **Branch base.** `origin/dev` did not contain your latest work (963c980 on
   `feat/usb-live-next-backend-spot-model`). `feat/overnight` = `origin/dev` +
   a merge of that branch (no conflicts). *Need:* confirm.
5. **Taught spot on the consumer view.** *Decided:* the room view names a spot
   only when the engine marks the spot model `reliable` (its cross-session
   score is clearly above chance) — today it never is. *Need:* OK?
6. **Navigation.** *Decided:* consumer nav is only "Room" and "Alerts"; /model,
   /source, /label, /settings and the teammate's /emergency demo are under the
   Setup menu (pages unchanged). *Need:* should /emergency stay a top-level tab
   for the pitch?
7. **Room size and sensor position.** *Decided:* default 4 × 3 m, sensor on the
   middle of one wall; entered in /setup and stored on the server
   (`Settings.room`). *Need:* the real room size and where the sensor and
   transmitter sit.
8. **Distances on consumer screens.** *Decided:* rounded words ("about 2 m",
   "less than 1 m") and only when distance quality is "medium"; decimals and ±
   only in installer sections. *Need:* OK?
9. **Teach-spots defaults (track F).** *Decided:* spot names fixed to close /
   middle / far; a new model is never auto-installed if it is strictly worse
   than the current one; the previous model is kept as
   `data/spots_model.prev.json` with a "Restore previous" button. *Need:* do
   you want your own spot names (desk, bed, sofa) instead?
10. **Transmitter priority.** *Decided:* when the fixed transmitter is found at
    boot, the receiver uses it even if Wi-Fi credentials are saved; `tx off` on
    the receiver restores the old behaviour exactly. Channel 11. *Need:* confirm;
    which channel your neighbours' Wi-Fi uses, if known.

## Operations (built with a default)

11. **Bind address.** *Decided:* `npm run start` listens on `127.0.0.1` only
    (live presence is personal data); `LIFEFI_HOST=0.0.0.0` opens it to phones
    on the LAN. `npm run dev` is unchanged. *Need:* default to the LAN instead?
12. **PIN storage.** *Decided:* still plain text in `data/settings.json`
    (default `1234` until changed; /setup flags it). Wrong PINs are now
    rate-limited and compared in constant time. *Need:* hash it (and how should
    a forgotten PIN be reset)?
13. **Recordings retention.** *Decided:* history/alerts purged after 30 days;
    `data/sessions/` never auto-deleted (training data). *Need:* confirm or cap.
14. **CI.** *Decided:* Linux only, on pushes to main/dev and PRs. *Need:* also
    on `feat/**`? Add a Windows job (the appliance runs on Windows)?
15. **Distance in history.** *Deferred:* needs a SQLite migration. *Need:* worth
    it?
16. **Logs.** *Decided:* plain text in `data/logs/lifefi-<date>.log`. *Need:*
    JSON for a log shipper?
