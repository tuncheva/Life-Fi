# Life-Fi engine (PC side)

Processing of raw CSI recordings on the PC. This is the start of plan-v2's
`engine/` component (§3.1). Recordings come from
`firmware/tools/csi_recorder.py` (`.csirec`). Needs Python 3 and numpy.

| Path | What |
|---|---|
| [lifefi/breathing.py](lifefi/breathing.py) | Breathing rate per 30 s window with a validity check: plan-v2 §6.3, offline and simplified |
| [tools/breathing.py](tools/breathing.py) | Runs it on a recording and prints every window |
| [tests/test_breathing.py](tests/test_breathing.py) | Synthetic raw CSI with known rates: finds 8/15/22 /min within 1, stays silent on noise and motion |

```powershell
python engine\tools\breathing.py firmware\recordings\<file>.csirec
python engine\tests\test_breathing.py
```

### TypeScript version ([ts/](ts/))

A port of the loader and the breathing estimator for the coming web
dashboard. It needs Node ≥ 23.6, which runs `.ts` files directly, and has no
runtime dependencies. TypeScript itself is only used for `npm run typecheck`.
It prints exactly the same output as the Python tool on all three recordings
from 2026-10-28 (checked line by line).

| Path | What |
|---|---|
| [ts/src/csirec.ts](ts/src/csirec.ts) | `.csirec` reader, frame header, LLTF extraction |
| [ts/src/breathing.ts](ts/src/breathing.ts) | Same steps, constants and validity gates as `lifefi/breathing.py` |
| [ts/src/cli/breathing.ts](ts/src/cli/breathing.ts) | CLI with the same output as `tools/breathing.py` |
| [ts/tests/breathing.test.ts](ts/tests/breathing.test.ts) | The same synthetic scenarios |

```powershell
node engine\ts\src\cli\breathing.ts firmware\recordings\<file>.csirec
node engine\ts\tests\breathing.test.ts
cd engine\ts; npm install; npm run typecheck
```

A change to the estimator goes into both versions. Compare the two outputs
on the recordings afterwards.

## Recording breathing that the tool can use

- One person **sitting still** on the line between the ESP32 and the router,
  1–2 m from the board, for 2 minutes. Count your breaths for one minute as
  the reference.
- The recording needs **≥ 30 s stretches without Wi-Fi pauses**. The tool
  never bridges a pause longer than 1 s. The first recordings
  (2026-10-28) were split by 3–17 s pauses at RSSI around −70 and gave no
  valid window. Move the board closer to the router (aim for RSSI better than
  −60) or use a dedicated transmitter
  ([upgrade-roadmap.md](../docs/plan/upgrade-roadmap.md), upgrade 2).
- The first clean recording (USB, 120 s, no pause > 0.7 s, RSSI about −58)
  showed a plausible 16–18 /min only in the first 30 s. After that, slow
  1–4 /min drift from movement or RSSI changes leaked into the band's 6 /min
  edge. The tool now rejects that ("drift at band edge"). It also reports
  "no consistent rate" instead of a median when valid windows disagree by
  more than 4 /min. Sit still for the whole recording.
- Second recording (2026-10-28 21:20, 120 s, no pause > 0.22 s): one person
  counted 10 /min, with a second person sitting nearby, off the link. 0/19
  windows were valid. 10 /min appears only as a secondary peak in 60 s
  spectra, under a 6–7 /min component and motion at 20–40 s. With one link
  the estimator cannot separate two people, so record with **one person
  only** until there are more links.
- **First match** (2026-10-28 21:34, 60 s, RSSI about −51, 0 lost): counted
  10 /min; the tool gave **9.2 /min** with 7/7 windows valid (8.8–10.5, FFT
  and autocorrelation agree). That is within the ±1–2 /min target. One
  recording only, so the thresholds stay as they are until more references
  are recorded.
- `valid` needs a clear peak (≥ 0.35 of band power), breathing-band power
  ≥ 2× the 0.6–2 Hz band (otherwise motion), and FFT and autocorrelation
  agreeing within 2 /min. These thresholds are starting values to tune on
  recordings with a reference.

Assistive, not medical (plan-v2 §7.4).
