# Upgrade Roadmap: Accuracy, Pose and Vital Signs

What it takes to go from today's single-ESP32 presence detector to accurate
counting, location/posture and breathing. It also covers what is not
realistic. It builds on [plan-v2.md](plan-v2.md) and
[csi-for-models.md](csi-for-models.md); evidence is in
[csi-people-counting.md](../research/csi-people-counting.md).

## Where we are (2026-10-28)

| Item | State |
|---|---|
| Hardware | One classic ESP32 (CH340 dev board) in station mode on the team router; RSSI about −70 |
| CSI rate | ~100–180 Hz received; the link pauses for 2–3 s every 20–30 s |
| On-board output | Presence (reliable), coarse count 1/2/3/4+ (exact about half the time in simulation, always within ±1) |
| **Raw CSI stream** | **Done.** Every packet goes to the PC over UDP or USB serial (921600 baud, any Wi-Fi network): plan-v2 §4.1 header plus LLTF and HT-LTF (amplitude and phase), recorded as `.csirec`. Measured: 1,586 frames in 20 s, 2 lost (`firmware/tools/csi_recorder.py`) |

## Upgrades, biggest gain first

| # | Upgrade | Why it helps | Needs | Status |
|---|---|---|---|---|
| 1 | **Stream raw CSI to the PC** | Keeps phase and every packet; enables recordings, labels, proper DSP and models. Everything below depends on it | Firmware + recorder | **Done** |
| 2 | **Dedicated transmitter** (2nd ESP32 sending ESP-NOW or pings at 100–200 Hz) | Steady rate with no router pauses; the link can be placed across the area to watch | 1 more ESP32 | Next |
| 3 | **3–4 receivers** (ESP32-S3, external antennas) around the room | The largest accuracy step: counting went from 44 % with one link to 99 % with six (Brena et al. 2021). Several links also give position and zone | 3–4 ESP32-S3 + time sync | Planned |
| 4 | **Labelled recordings + small trained model** (plan-v2 §6.8, §10) | Replaces hand-set thresholds with per-room learned ones; turns "coarse" into "good" | Upgrade 1, phone camera as ground truth, recording sessions | Planned |
| 5 | **Python engine on the PC** (plan-v2 §5) | Proper filters (Hampel, resampling, band-pass), breathing, falls, dashboard feed | Upgrade 1 | Planned |
| 6 | Automatic re-baseline when empty | Stops stale calibration (a stale baseline reported `PRESENT` after 18 min) | Firmware or engine | Planned |
| 7 | Placement guide (about 1 m high, link across the area, 3–5 m apart, closer to the router) | At RSSI −70 the router falls back to 802.11b (no CSI): 6–37 paused seconds per minute were measured. Disabling 11b on the board made it worse | `firmware/tools/link_check.py`, firmware README | Tool done; finding a good placement is next |

A large (~10×) error reduction is realistic only from 2 + 3 + 4 together.
Tuning one link cannot get there; the limit is physics, not code (next
section).

## Why one link cannot count well

- 52 subcarriers span 16.25 MHz, so the delay resolution is ~62 ns, an 18 m
  path difference. Every person in a room modulates the subcarriers with
  nearly the same pattern. Our simulation found one dominant eigenvalue
  whatever the head count (`firmware/test/host`).
- The motion score grows with total reflection strength, so one person near
  the link looks like two further away.
- The fixes are more spatial views (antennas or links) and learning per room.

## 3D image / pose of people

| Level | Realistic with | Data needed |
|---|---|---|
| Presence, motion | 1 link (today) | — |
| Zone / position in the room | 3–4 links | Synchronised CSI from every link; position labels |
| Posture: standing / sitting / lying, fall | 1–4 links + model | Labelled transitions (plan-v2 §6.7–6.8) |
| 2D/3D skeleton (17 keypoints) | Research hardware: 3×3-antenna NICs, several links | Full complex CSI from many antennas, camera ground truth (camera + pose detector as teacher), large datasets such as MM-Fi |
| Body surface ("DensePose") | Research setups only | As above, much more data |

**Data to collect for any pose model:** raw complex CSI (now streamed), the
ESP32 timestamp plus host time per packet (stored in `.csirec`), every link
synchronised, and a time-aligned camera video from which a pose detector
produces labels. Without camera labels no model can learn pose.

**Reference point:** RuView, a public ESP32 project in this space, reports
for its live single-ESP32 pose model **PCK@20 = 3 % (target 35 %)**, and
describes that path as a stub. Its good pose numbers (~83 % PCK@20) come
from the MM-Fi research dataset, not from ESP32 hardware. Its README
recommends 3–6 ESP32-S3 nodes and labels vital signs "unvalidated"
([RuView](https://github.com/ruvnet/RuView); press:
[CNX Software](https://www.cnx-software.com/2026/03/26/ruview-project-leverages-esp32-nodes-for-presence-detection-pose-estimation-and-breathing-heart-rate-monitoring/),
[VPNCentral](https://vpncentral.com/?p=246268)). Ideas worth borrowing:
channel hopping (1/6/11) for more virtual subcarriers, multiple nodes with
TDM, phase-based breathing, and per-room adaptation.

## Vital signs

| Signal | Feasible? | Conditions | Plan |
|---|---|---|---|
| Breathing rate | **Yes** | Person still, near or on the link; ±1–2 /min | plan-v2 §6.3–6.4 on the PC from the raw stream (0.1–0.5 Hz band, PCA over subcarriers, phase after sanitising) |
| Breathing stopped (apnea) | Yes, with care | As above; validate with a chest belt or phone accelerometer | plan-v2 §6.4 |
| Heart rate | **Experimental only** | Very still, very close; unreliable on single-antenna amplitude | 0.8–2 Hz band on sanitised phase; show only as experimental after it's validated against a pulse sensor. First look (2026-10-28, the 60 s recording that gave breathing 9.2 /min): **no heart signal**. Power at 48–120 /min equals the noise floor, and the 93 and 120 /min "peaks" were the 10th and 13th breathing harmonics. `engine/lifefi/heart.py` (+ TS) now subtracts the breathing harmonics, keeps 3.6 /min away from them, and requires a peak 6× above the noise. It reports no heart signal on all three recordings ([engine README](../../engine/README.md#heart-rate-experimental)) |
| Blood pressure | **No** | No credible evidence that Wi-Fi CSI measures it | Use a real cuff if needed and import its readings |

All vital-sign outputs are assistive, not medical (plan-v2 §7.4), and are
validated against a reference sensor before being shown.

## Next concrete steps

1. Breathing on the PC from `.csirec` recordings. **The estimator is done**
   (`engine/lifefi/breathing.py`; synthetic tests pass). The first real
   recordings gave no valid window, because Wi-Fi pauses of 3–17 s at RSSI
   around −70 left only one 30 s stretch. The first clean USB recording
   (120 s, RSSI about −58, no pauses) gave 16–18 /min in the first 30 s,
   then drift that the estimator now rejects. A still 60 s recording at RSSI
   −51 then gave **9.2 /min against 10 counted** (7/7 windows valid). Next:
   more counted recordings (different rates, distances, a second person) to
   tune the thresholds.
2. Second ESP32 as the transmitter; compare rate stability and breathing SNR.
3. Order 3–4 ESP32-S3 boards with external antennas; add `node_id` per board
   (already in the frame header) and time sync.
4. Recording sessions with camera ground truth per plan-v2 §10.
