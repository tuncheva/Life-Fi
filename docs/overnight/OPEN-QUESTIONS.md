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
