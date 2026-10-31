# Life-Fi engine (PC side)

Processing of raw CSI recordings on the PC. This is the start of plan-v2's
`engine/` component (§3.1). Recordings come from
`firmware/tools/csi_recorder.py` (`.csirec`). Needs Python 3 and numpy.

| Path | What |
|---|---|
| [lifefi/breathing.py](lifefi/breathing.py) | Breathing rate per 30 s window with a validity check: plan-v2 §6.3, offline and simplified |
| [tools/breathing.py](tools/breathing.py) | Runs it on a recording and prints every window |
| [tests/test_breathing.py](tests/test_breathing.py) | Synthetic raw CSI with known rates: finds 8/15/22 /min within 1, stays silent on noise and motion |
| [lifefi/heart.py](lifefi/heart.py) | **Experimental** heart rate per 30 s window ([below](#heart-rate-experimental)) |
| [tools/heart.py](tools/heart.py) | Runs it on a recording and prints every window |
| [tests/test_heart.py](tests/test_heart.py) | Synthetic pulses between breathing harmonics are found within 2; harmonics alone, noise and motion are never reported |
| [viz/position.html](viz/position.html) | **Experimental** 3D view of distance from the ESP32 ([below](#3d-position-view-experimental)) |

```powershell
python engine\tools\breathing.py firmware\recordings\<file>.csirec
python engine\tests\test_breathing.py
python engine\tools\heart.py firmware\recordings\<file>.csirec
python engine\tests\test_heart.py
```

### TypeScript version ([ts/](ts/))

A port of the loader and the breathing and heart estimators for the coming
web dashboard. It needs Node ≥ 23.6, which runs `.ts` files directly, and has
no runtime dependencies. TypeScript itself is only used for `npm run typecheck`.
On all three recordings from 2026-10-28 (checked line by line):

- **Breathing:** exactly the same output as the Python tool.
- **Heart:** identical except one printed digit. The Python value was
  65.04976 and the TypeScript one 65.05010, so they round to different sides
  of 65.05. The least-squares harmonic fit is solved differently (numpy SVD
  on float32 features vs normal equations in float64).

| Path | What |
|---|---|
| [ts/src/csirec.ts](ts/src/csirec.ts) | `.csirec` reader, frame header, LLTF extraction |
| [ts/src/breathing.ts](ts/src/breathing.ts) | Same steps, constants and validity gates as `lifefi/breathing.py` |
| [ts/src/cli/breathing.ts](ts/src/cli/breathing.ts) | CLI with the same output as `tools/breathing.py` |
| [ts/tests/breathing.test.ts](ts/tests/breathing.test.ts) | The same synthetic scenarios |
| [ts/src/heart.ts](ts/src/heart.ts), [ts/src/cli/heart.ts](ts/src/cli/heart.ts), [ts/tests/heart.test.ts](ts/tests/heart.test.ts) | Heart estimator, CLI and tests, as in Python |

```powershell
node engine\ts\src\cli\breathing.ts firmware\recordings\<file>.csirec
node engine\ts\tests\breathing.test.ts
node engine\ts\src\cli\heart.ts firmware\recordings\<file>.csirec
node engine\ts\tests\heart.test.ts
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

## Heart rate (experimental)

A one-off look at the 60 s recording first printed 93–120 /min. Its
diagnosis found two problems.

**Breathing harmonics.** Breathing is not a pure sine. At 9.26 /min it had
strong harmonics in the heart band:

| Harmonic | Rate (/min) | Strength vs the spectrum between harmonics |
|---|---|---|
| 6th | 55.5 | 88× |
| 10th | 92.6 | 5.7× |
| 13th | 120.4 | 13× |

The "93" and "120" were the 10th and 13th harmonics.

**No pulse above the noise.** The spectrum is flat from 30 to 210 /min.

`lifefi/heart.py` (and `ts/src/heart.ts`) therefore:

- **Removes breathing harmonics:** it estimates the breathing fundamental fb
  in each window, then subtracts sinusoids fitted at k·fb and notches those
  bins. Notching alone left leakage peaks next to a harmonic that fell
  between two bins.
- **Keeps away from harmonics:** a peak within 3.6 /min of a harmonic is not
  valid. A sweep showed such peaks are pulled by leakage (errors up to
  2.4 /min). This is the resolution limit of a 30 s window, and leaves
  20–40 % of the 45–120 /min band measurable, depending on the breathing
  rate. Longer windows would shrink the guard.
- **Needs a peak above the noise:** at least 6× the band mean, not on a band
  or notch edge, ≥ 0.35 of the band power, with no second peak ≥ 0.5 of it.
  FFT and autocorrelation must agree within 5 /min, and the breathing band
  must not show motion.
- **Needs enough windows:** at least 30 % of windows valid before it prints
  a rate.

Result on all three recordings from 2026-10-28: **no heart signal**. On the
60 s recording every window fails at least two checks. One antenna with int8
CSI is at its limit for 0.1–0.5 mm chest motion.

To give it a real chance:
- sit still with your chest 30–50 cm from the board;
- read your pulse from a watch or finger clip during the recording, as the
  reference;
- record 2 minutes.

Assistive, not medical (plan-v2 §7.4).

## 3D position view (experimental)

[viz/position.html](viz/position.html) is one self-contained page (three.js
from a CDN, no build). Drop a `.csirec` on it to see the ESP32, the router,
the link's first Fresnel zone and a person figure at the estimated distance,
with playback and a distance/disturbance chart. To load a recording by URL,
serve the repository and add `?src=`:

```powershell
python -m http.server 8765
# http://localhost:8765/engine/viz/position.html?src=/firmware/recordings/<file>.csirec
```

**What it can and cannot show.** One link and one antenna measure no
direction, so the page draws a ring of every possible position at distance d.
The figure stands at an assumed direction, which you can set. Distance is a
proxy:

- **R:** how strongly the body changes the subcarriers. It is the variance in
  dB² of 0.25 s means of gain-free dB in a 10 s window, minus the white noise
  estimated from neighbouring frames. A still, breathing person needs ≥ 10 s;
  with 4 s windows they sat at the noise level.
- **Distance:** d = 10^((A − R)/(10·n)), smoothed with a constant-velocity
  Kalman filter. A = −14 dB and n = 2 are guesses until calibrated. Pause at a
  known distance and add a point: one point fits A, two or more fit A and n
  by least squares. It is a 2-parameter regression, not a neural network.
  There are no labelled recordings to train one on.
- **Movement raises R as much as closeness does.**
  - On 2026-10-28, the still recording gave a steady 1.1–1.4 m with the
    default guesses.
  - The recordings with movement dropped to the 0.2 m minimum while people
    moved.
  - Calibrate sitting still, and read moving stretches as "moving", not
    "close".

Real position (zone, direction) needs 3–4 links; a pose network needs those
plus camera labels ([upgrade-roadmap.md](../docs/plan/upgrade-roadmap.md),
upgrades 3–4).
