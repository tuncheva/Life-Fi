# Life-Fi firmware: ESP32 CSI people counter

First hardware milestone: an ESP32 reads Wi-Fi Channel State Information
(CSI), works out on the chip whether anyone is in the room and roughly how
many, and logs it to the serial console once per second. The web dashboard,
UDP streaming and the Python engine of [plan-v2](../docs/plan/plan-v2.md)
come later. This firmware is the first piece of its `firmware/` component.

Background on how CSI sensing and counting work:
[docs/research/csi-people-counting.md](../docs/research/csi-people-counting.md).

## Plan for this milestone

| # | Step | Status |
|---|---|---|
| 1 | PlatformIO + ESP-IDF 5.5 project for ESP32 (`esp32dev`) and ESP32-S3 (`esp32s3`) | done |
| 2 | Wi-Fi link: station mode (ping the router at 100 Hz) or sniffer mode (no credentials needed) | done |
| 3 | CSI capture: LLTF, 52 subcarriers, unfiltered, one transmitter only | done |
| 4 | Per-second features + empty-room calibration at boot | done |
| 5 | Presence state machine + people-count estimate, logged to the console | done |
| 6 | Serial commands: recalibrate, learn real head counts (saved in flash) | done |
| 6b | Host tests: CSI parsing, estimator, commands, end-to-end on simulated raw CSI (`test/host`) | done, all passing |
| 7 | Flash a real board, check the rate and tune thresholds on real data | needs the board |
| Later | UDP `csi_frame_hdr_t` v2 stream to the engine, dashboard, models (plan-v2 §4, §9) | — |

## Build, flash, watch

Needs PlatformIO (the VS Code extension installs it at `~\.platformio`;
`pio` is usually not on PATH). In Windows PowerShell, from the repo root:

```powershell
cd firmware
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe"
& $pio run -e esp32dev -t upload -t monitor     # classic ESP32; -e esp32s3 for an ESP32-S3
```

The monitor runs at 115200 baud: type commands and press Enter, Ctrl+C to
quit. To open it again later: `& $pio device monitor`.

- Windows PowerShell 5.1 has no `&&`: run the commands on separate lines,
  or join them with `;`.
- Use a USB cable that carries data. If no new COM port appears in Device
  Manager when you plug in, the cable is probably charge-only.
- On an ESP32-S3 DevKitC, plug into the **UART** USB connector, not the
  native "USB" one. The native port shows the logs but can't read typed
  commands.

### ESP32-CAM (AI Thinker)

Classic ESP32 with a camera we don't use; build target `esp32cam`. The
board has **no USB of its own**:

- **ESP32-CAM-MB shield** (micro-USB, CH340): seat the board on it, plug in
  the USB cable, then `& $pio run -e esp32cam -t upload -t monitor`. If the
  upload says `Failed to connect`, hold **IO0** on the shield, tap **RST**,
  release IO0 and retry. After flashing, tap **RST** to start the firmware.
- **USB-serial adapter** (FTDI/CP2102/CH340) instead: wire 5V→5V, GND→GND,
  adapter TX→U0R (GPIO3), adapter RX→U0T (GPIO1). For flashing, also connect
  IO0→GND and tap RST. Then remove that wire and tap RST to run.
- **Power:** use 5 V from a good USB port. If the log shows `Brownout
  detector was triggered` when Wi-Fi starts, the supply sags under the
  Wi-Fi current: use a shorter cable or a powered hub.
- No new COM port when plugged in? The CH340 driver installs through
  Windows Update. Otherwise install WCH's CH341SER driver.

To keep a timestamped log for tuning (written to `logs\`, git-ignored),
use PlatformIO's Python, which already has pyserial:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" tools\serial_log.py COM5 --reset
```

### Two ways to get CSI

| Mode | When | CSI rate | Setup |
|---|---|---|---|
| **Station** (best) | `src/wifi_secrets.h` exists | ~100 Hz: every ping reply from the router is a sample | `Copy-Item src\wifi_secrets.h.example src\wifi_secrets.h`, then fill in a **2.4 GHz** SSID and password |
| **Sniffer** (fallback) | no credentials, or connecting failed for 20 s | whatever OFDM traffic is in the air, often 5–50 Hz | none: it surveys the channels of the 3 strongest APs (or `LIFEFI_SNIFF_SSID`) for 3 s each and locks onto the transmitter that gives the most CSI, preferring an AP with ≥ 10 Hz |

Why the survey: many routers send beacons at 802.11b rates, which carry no
CSI, so an idle AP can give almost nothing. If the console says the source is
a `(client device)`, it may be a phone that moves, and that looks like motion.
Station mode avoids all of this.

Put the ESP32 a few metres from the router, with the area you want to watch
between them: people affect CSI most near the line between transmitter and
receiver.

## What you see

```
I (31000) lifefi: t=   31s rate= 98Hz rssi= -47 motion= 1.04 active=  2% dev=0.0011 score= 1.02 | EMPTY     people=0
W (35000) lifefi: presence: EMPTY -> PRESENT (motion)
I (35000) lifefi: t=   35s rate= 99Hz rssi= -49 motion= 3.71 active= 46% dev=0.0213 score= 2.10 | PRESENT   people=1 (est)
W (52000) lifefi: people: 1 -> 2
```

| Field | Meaning |
|---|---|
| `rate` | CSI packets in the last second. Below ~20 Hz, use station mode |
| `motion` | mean over subcarriers of (std this second / std of the empty room); ~1 when empty |
| `active` | share of subcarriers whose variance is > 4× the empty room (a crowd-counting metric) |
| `dev` | 1 − correlation of the amplitude profile with the empty room; rises when someone stands still in the link |
| `score` | motion averaged over 8 s; what the count is read from |
| state | `CALIBRATING`, `EMPTY`, `PRESENT`, `UNCERTAIN` (present but nothing moved for 5 min) |
| `people` | `0` when empty; `(est)` = default thresholds, `(learned)` = your recorded levels; `?` when uncertain |

Every 15 s a `main:` line shows link health: mode, AP, CSI counters, ping
timeouts and free heap.

### Commands (type into the monitor)

| Command | Does |
|---|---|
| `cal` | Recalibrate the empty room: 10 s to leave, then 20 s of recording |
| `learn N` | Record 30 s with N people (1–5) moving normally; stored in flash as level N |
| `forget` | Clear the learned levels (back to default thresholds) |
| `status` | Print thresholds and learned levels |
| `help` | List commands |

**Calibrate counting for a room:** after boot calibration, run `learn 1`,
`learn 2`, `learn 3` with that many people walking around. With two or more
levels stored, the count switches from the default thresholds to the nearest
learned level.

## How it works

1. **Capture** ([csi_capture.c](src/csi_capture.c)): CSI from the LLTF
   (in every frame type), 52 subcarriers k = −26…−1, +1…+26, with merge and
   channel filter off so subcarriers stay independent. Only frames from the
   router's MAC count. The callback copies into a queue and returns.
2. **Normalise:** each packet's amplitudes are divided by their mean. This
   cancels the receiver's AGC and CSI auto-scaling, which change per packet.
3. **Window** ([main.c](src/main.c)): every 1 s, per-subcarrier mean and
   variance.
4. **Calibrate** ([estimator.c](src/estimator.c)): the first 20 s after boot
   are taken as the empty room. That gives the median variance per
   subcarrier, the mean profile, and empty-room thresholds (90th percentile
   × margin, with floors).
5. **Presence:** EMPTY → PRESENT on motion in 2 of the last 3 s, or on a
   changed profile for 5 s. Back to EMPTY after 30 s with no motion *and* the
   profile back to the empty one, so a still person keeps the room occupied.
6. **Count:** while PRESENT, the 8 s motion score is mapped to 1 / 2 / 3 / 4+
   by thresholds, or by the nearest learned level. Shown count = median of
   the last 5 s.

All tunables are in [lifefi_config.h](src/lifefi_config.h).

## Host tests (no board needed)

Everything except the Wi-Fi driver glue runs on the PC with stub ESP-IDF
headers ([test/host/stubs](test/host/stubs)):

| Program | Covers |
|---|---|
| [test_csi_window.c](test/host/test_csi_window.c) | LLTF byte layout → 52 columns, `first_word_invalid` repair, per-packet normalisation (a 1.9× AGC jump gives no variance), mean/variance/rate maths, broken packets |
| [test_estimator.c](test/host/test_estimator.c) | Calibration, 10 min empty without false presence, walk-in/leave, still person, UNCERTAIN after 5 min and recovery, sparse windows, learned counts, NVS persistence, `forget` |
| [test_commands.c](test/host/test_commands.c) | Typed lines: case and whitespace, bad input ignored, `learn N` saves after 30 s, `forget`, `cal`, `learn` refused while calibrating |
| [test_pipeline.c](test/host/test_pipeline.c) | **End to end on raw int8 CSI** from a simulated room: multipath, walking reflectors, per-packet AGC gain, int8 quantisation, receiver noise, garbage `first_word_invalid` bytes, 2 % loss, jitter, an outage, 15 Hz sniffer rate |

In Windows PowerShell, from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1
```

Add `-v` for every per-second estimator line. `-ExecutionPolicy Bypass`
applies to that one run only, because Windows blocks `.ps1` scripts by
default. The runner uses `$env:CC`, or `cc`/`gcc`/`clang` from PATH. With
none of those, the first run installs Zig's C compiler (pip `ziglang`,
~50 MB) into `firmware\test\host\.venv` (git-ignored); later runs reuse it.
It needs Python 3. On Linux/macOS or Git Bash: `sh firmware/test/host/run.sh`.

What the end-to-end run shows (simulated room, so it checks the chain and
the logic, not real-world accuracy):

| Check | Result |
|---|---|
| Empty room 5 min with AGC jumps, quantisation, loss | 0 s of false presence |
| Walker detected | after 2 s (also at 15 Hz) |
| Still person detected / held | ~11 s / held for 2 min |
| Mean score, 1 / 2 / 3 walkers (6 random draws each) | 1.97 / 2.95 / 3.36 |
| Count after `learn 1/2/3` | 9/18 exact, 18/18 within ±1 |

## Honest limits

- One link, amplitude only. Presence and motion are solid. The count is a
  **coarse estimate** that relies on people moving: two people standing still
  look like one. Calibrate with `learn` in the real room before trusting it.
- The count reads total fluctuation, so one person close to the link can
  look like two further away. In simulation it is right about half the time
  and within ±1 always. Show it as "1 / 2 / 3+ (estimate)", not as an exact
  number.
- Counting by the *rank* of the subcarrier correlation (one dimension per
  person) was tried and does not work on one 20 MHz link. Its delay
  resolution is ~62 ns (18 m), so everyone in a room modulates the 52
  subcarriers with nearly the same pattern: one dominant eigenvalue whatever
  the count. That needs more antennas or links.
- Calibration assumes the room is empty for the first 20 s after boot. If it
  wasn't, a warning is printed: run `cal`.
- Default count thresholds are guesses until tuned on real recordings.

## Open items (need team input or the hardware)

- Board: the team has an **ESP32-CAM** (target `esp32cam`). `esp32dev` and
  `esp32s3` also build. plan-v2 assumes an S3; its single PCB antenna is
  enough for one link.
- The router to use, and its 2.4 GHz SSID/password for station mode
  (`src/wifi_secrets.h`, git-ignored).
- Tune `LIFEFI_*` thresholds on real recordings, then move to the UDP
  stream of plan-v2 §4.1 so the engine does the heavy processing.
