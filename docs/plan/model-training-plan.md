# Model Training Plan (for demo day, 2026-11-05)

Written 2026-10-29, on `feat/model-training`. This is the **one-week cut**
of [model-scope-and-phases.md](model-scope-and-phases.md),
[dataset-preparation.md](dataset-preparation.md) and
[data-and-recording-guide.md](data-and-recording-guide.md). It answers:

1. What model code exists today, and what is missing.
2. What we can build **now** from the downloaded data (cleaning, training).
3. Which networks we use, and why.
4. Can the models work in **any room** without recording there? What
   the honest answer is, and what we do instead.
5. What we record ourselves before the event, and what we record **at the
   venue** (a room we have never seen), step by step.

Where this file and plan-v2 disagree, plan-v2 wins, except on the schedule:
plan-v2 has no dates, and this file is about the 7 days left.

Tags: **[V]** checked in the files or the code on 2026-10-29,
**[H]** estimate.

---

## 1. Where the code is today

| Piece | Needed for models | State [V] |
|---|---|---|
| Firmware raw CSI stream + `.csirec` recorder | all | **Done** (`firmware/tools/csi_recorder.py`), USB or UDP |
| `.csirec` reader (Python + TS) | all | **Done** (`csi_recorder.load_csirec`, `engine/ts/src/csirec.ts`) |
| Breathing rate (offline, 30 s windows) | rule #3 | **Done** (`engine/lifefi/breathing.py`), one real match: 9.2 vs 10 /min |
| Heart rate | out of scope | Done as experiment; reports "no signal", correctly |
| On-board presence + coarse count | — | Done in firmware (`estimator.c`); not used by the PC models |
| `lifefi.dsp` (streaming Hampel → 100 Hz → 20 Hz LP → 50 Hz `F`) | **every model** | **Missing** |
| Motion `M`, presence state machine, `no_breathing`, fall rule | rules #1, #2, #4, #5 | **Missing** |
| Dataset readers, `qc.py`, manifest (`datasets/readers/`) | training | **Missing** (planned in dataset-preparation §4) |
| `ml/` loader, windows, GBM features, CNN, training, ONNX export | T1, T2 | **Missing** |
| Real engine on TCP 6000 | live demo, labelling page recording | **Missing**; only the mock engine answers |
| `check_session` (snap marks to motion peaks) | own labelled data | **Missing** |
| Python ML stack | training | numpy 2.3, scipy 1.16, scikit-learn 1.7 installed; **no PyTorch, no LightGBM, no onnxruntime**. GPU: RTX 5050 Laptop 8 GB, so PyTorch must be a CUDA 12.8 build (`cu128` wheels); older wheels do not support the 50-series |

**Bottom line:** the data is downloaded and well understood (the docs are
thorough), but **no line of model code exists yet**. With 7 days left,
the order has to be: shared DSP → rules (they carry the demo) → one trained
model (T1) → venue adaptation. T2 and T3 are cut unless everything else is
done by Sunday.

---

## 2. What the downloaded data can do now

### 2.0 Our own ESP32 recordings so far

The `.csirec` files are gitignored. Only the 60 s, 21:34 one is on this
machine (`firmware/recordings/2026-10-28/`, labelled `sitting`, checked
2026-10-29: no false fall or movement events; results in
`data/README.md`). What we know about the others comes from
[engine/README.md](../../engine/README.md) and
[upgrade-roadmap.md](upgrade-roadmap.md), all from 2026-10-28, classic
ESP32, team router:

| Recording | Setup | Breathing tool | Heart tool | Use |
|---|---|---|---|---|
| Several early ones | RSSI ≈ −70, Wi-Fi pauses of 3–17 s | no 30 s stretch → nothing | — | none (link too weak) |
| 120 s, USB | RSSI ≈ −58, no pause > 0.7 s, 1 person | 16–18 /min in the first 30 s, then drift (rejected) | no signal | breathing tuning (no reference) |
| 120 s, 21:20 | 1 person counted **10 /min**, a 2nd person nearby off the link | 0/19 valid | no signal | shows the 1-person limit |
| **60 s, 21:34** | RSSI ≈ −51, 0 lost, counted **10 /min** | **9.2 /min**, 7/7 valid | no signal | the one breathing match |

So today we have **about 5 minutes of usable CSI with one counted
breathing reference**, and **no pulse signal in any of them**. That is
enough to know the breathing estimator works, not to measure how well.

To get the real numbers, copy every `.csirec` into `firmware/recordings/`
(any sub-folders) and run:

```powershell
python engine\tools\inventory.py --csv firmware\recordings\inventory.csv
```

It prints one line per file: length, rate, loss, pauses, longest
continuous stretch, RSSI, the breathing and heart results, and what the
file can feed (`breathing`, `model`, or `too broken`). Write the counted
breaths or pulse readings next to each file in `data/README.md`; that
reference is what turns a recording into an accuracy number.

### 2.1 What is usable, after checking the files

| ID | Use this week | Rooms | Why it matters now |
|---|---|---|---|
| **E1** Embedded_WiFi_Sensing | **T1 main training + fall-rule features** | 1 [I] | ESP32, LLTF, 50 Hz like ours. 1,647 clips: FA 327, GU 329, LD 329, SD 332, WA 330 [V], 22 subjects |
| **E8** ESP-Fi HAR | **Multi-room training + leave-one-room-out** | 4 | 2,240 clips, 100 Hz, 8 people. The only set with 4 rooms and the same activities in each |
| E4 3DO | presence / still-person threshold check | 1, 3 days | per-packet empty / walk / sit / lie |
| E2 WiFall | extra sit / stand / fall windows, 1 more room | 1 | ESP32-S3, but 3 s clips |
| E7 LOS/NLOS | hard negatives, 3 more rooms | 3 | 38 Hz, low-band features only |
| E3, E5, E9, E15 | detector sanity checks only | — | different LTF, antenna or licence |
| E6, E10 | **drop** | — | dataset-preparation §3.3 |

**E1 shortcut that is a trap.** `Datasets/x_trn.npy` / `y_trn.npy` are
already-computed amplitudes, shape `(1198, 52, 850)`, labels 1–5 balanced
[V]. They have **no subject ID**, so any split of them is a random split and
the score is inflated. Use them only as a 10-minute smoke test of the CNN
code; train and report from the raw `.txt` files.

**E8 labels, checked today.** The README maps activity `Z`: 1 run, 2 fall,
3 walk, 4 turn, 5 jump, 6 squat, 7 arm wave. The benchmark code's
alphabetical list is only its folder order, so it does not contradict the
README. A motion-energy check over 896 clips (trials 1–4, all 4 rooms)
[V]:

| Z | README name | peak / median motion | motion 2–5 s after the peak / peak |
|---|---|---|---|
| 1 | run | 3.04 | 0.32 |
| 2 | fall | 2.22 | 0.43 |
| 3–7 | walk, turn, jump, squat, arm wave | 1.24–1.43 | 0.65–0.78 |

Only Z = 1 and Z = 2 are "burst, then quiet"; the other five are sustained.
That fits "fall" for Z = 2 but also fits a run *through* the link for Z = 1,
so motion alone cannot confirm the mapping. **Decision for this week:** use
the README mapping, and treat E8 falls as unconfirmed: train with them, but
never quote an E8 fall number. Still worth a look at the paper (Wen et al.,
Ad Hoc Networks 2026) if someone has 15 minutes.

### 2.2 Cleaning and conversion (what to code, in order)

The plan in [dataset-preparation §4–5](dataset-preparation.md) stands. The
minimum for this week is **E1 + E8**; the rest only if time allows.

1. `datasets/readers/common.py`: interim `.npz` writer (`ts_us`, `amp`
   `[N, 52]` linear, `sat`, `seg_label`, meta JSON) and `qc.py` (rate, gaps,
   backward time, saturation, dead subcarriers, duplicates). Every drop goes
   into `datasets/manifest/<id>.csv` with the reason.
2. `readers/e1.py`: 64 `[imag, real]` pairs; keep j 38…63 and 1…26;
   **copy k = +2 into k = +1** (j = 1 is the constant `(4, 0)` garbage);
   drop files < 900 rows; subject from the folder `s<N>`.
3. `readers/e8.py`: CSVs only (not `.mat`); skip the `,,,,` rows; 104 ints →
   52 pairs; room / person / activity / trial from `X-Y-Z-M`; saturation
   share per file (1,387 of 2,240 files touch ±127: drop files with
   > 1 % saturated frames from fall training only).
4. `engine/lifefi/dsp.py`: one function used by **both** the engine and the
   readers: `L = 20·log10(max(1, amp))` → Hampel (half-window 3, k = 3) →
   linear onto 100 Hz → 4th-order Butterworth 20 Hz → every 2nd sample =
   **`F` `[T, 52]` at 50 Hz** + `valid`. An offline (non-streaming) version
   is enough for this week; the chunk-invariance test can come later.
5. `ml/windows.py`: 3 s windows (150 samples), hop 0.5 s, model view
   `x = clip(F − mean_window(F), ±10 dB)`. Labels:
   - E1 / E8 clips have one event each and no onset time. Onset = the peak
     of `M` in the clip; if peak / median < 3, the clip goes to `none`.
   - A window gets the class if ≥ 70 % of `[onset − 0.5 s, onset + 2 s]`
     is inside it, `−100` (ignored) if 0–70 %, else `none` (or `walking`).
6. `datasets/manifest/splits.yml`, written **before** training:
   E1 5 folds by subject + 3 subjects locked; E8 leave-one-room-out.

### 2.3 Class map for T1 this week

| Our class | E1 | E8 | E2 | Ours |
|---|---|---|---|---|
| `sit_down` | SD | — | sit | ✅ |
| `stand_up` | — | — | stand (check it is a transition) | ✅ **only source that is clean** |
| `lie_down` | LD | — | — | ✅ |
| `get_up` | GU | — | — | ✅ |
| `walking` | WA | walk, run | walk | ✅ |
| `fall` (for T2 / the fall rule, `none` for T1) | FA | Z = 2 | fall | ✅ on a mat |
| `none` | burst-less clips | turn, arm wave, jump, squat | jump | ✅ |

`stand_up` has no public source, so in T1 it is learned from our own
recordings only. If we cannot record enough of it, merge `stand_up` and
`get_up` into one `rise` class for the demo (posture: SITTING/LYING →
STANDING/SITTING is then decided by the previous state).

---

## 3. Which networks, and why

### 3.1 Summary

| Output | Method | Trained on | Learns weights? |
|---|---|---|---|
| Motion, presence, breathing, `no_breathing`, fall → fainted | **rules** (plan-v2 §6.1–6.5) | thresholds from a 2-min empty calibration **in the room** | no |
| **T1 transitions** (sit / stand / lie / get up / walk / none) | **LightGBM baseline**, then **small 1D CNN**; the one with the better leave-one-room-out event F1 ships | E1 + E8 (+ E2) → fine-tune on ours → AdaBN at the venue | **yes** |
| T2 fall verifier | LightGBM on 5 stage-1 features | E1 FA vs LD/SD, E8 | yes, **cut unless time** |
| T3 count 1 vs 2+ | — | — | **cut**: show presence + "occupancy level" instead (plan-v2 §6.9) |

### 3.2 T1: the 1D CNN

Input `[52 channels, 150 time steps]` (3 s × 50 Hz, model view `x`).
Subcarriers are channels, convolution runs over time only, because the
event is a *shape in time* and the subcarrier pattern is what changes from
room to room.

```
x [B, 52, 150]
 → SubcarrierDropout(p=0.2)                  # whole subcarriers zeroed, train only
 → Conv1d(52→32, k=1) + BN + ReLU            # mixes subcarriers into 32 "virtual paths"
 → Conv1d(32→64, k=7) + BN + ReLU + MaxPool(2)      # 75
 → Conv1d(64→64, k=5, dilation=2) + BN + ReLU + MaxPool(2)   # 37
 → Conv1d(64→64, k=5, dilation=4) + BN + ReLU
 → global average + global max pool over time → [B, 128]
 → Dropout(0.3) → Linear(128→6)
```

About **58 k parameters**, close to plan-v2's ~43 k budget; trim the
middle layer to 48 channels if CPU inference in the engine is slow.
Trains in minutes on the RTX 5050, runs in < 1 ms per window on the laptop
CPU via ONNX.

Training: AdamW lr 1e-3 / wd 1e-2, cosine schedule, class-weighted
cross-entropy with label smoothing 0.05, early stop on a held-out
**room** (not a random split), batch 128.

Augmentations (plan-v2 §6.8, plus three for room changes):

| Augmentation | Simulates |
|---|---|
| offset ± 2 dB, Gaussian noise, time shift ± 10 samples, time warp ± 10 %, hold 2–8 samples | gain, jitter, packet loss (plan-v2) |
| injected gain step | AGC jump |
| **random spectral tilt**: add a smooth random curve over the 52 subcarriers × time-constant scale 0.5–2 | a different frequency response of the room / antenna |
| **random subcarrier mixing**: `x' = W·x` with `W = I + 0.1·N(0,1)` | different multipath combining |
| **mixup across rooms** within the same class | interpolates between rooms |

### 3.3 T1: the LightGBM baseline

Features per window from `lifefi.features` (plan-v2 §6.8): variance, max
|diff| and kurtosis of PC1–3 and of the mean-over-subcarriers signal; band
energies 0.1–0.5 / 0.5–2 / 2–10 Hz; time of peak motion within the window;
burst length; rise and decay slope of `M`; turbulence. **Use only
room-independent summaries** (statistics over subcarriers, PCs), not
per-subcarrier features, so it cannot memorise one room's subcarrier
pattern. It is the fallback if the CNN does not beat it on the held-out
room.

### 3.4 Why not the others

| Option | Why not here |
|---|---|
| LSTM / GRU / Transformer / ResNet18 (E8's benchmark) | 10–100× more weights than our data supports; E8 reports them on a within-room split, which says nothing about a new room |
| E1's EMD-LSTM (the paper's model, `.keras` in the repo) | EMD is slow, the model is trained on whole 17 s clips, and the shipped weights are for their amplitudes and their room. Not a transition detector |
| A posture classifier (standing / sitting / lying as states) | Learns *where* the person is, not how they hold their body. Does not transfer to a new room (plan-v2 D4) |
| Pose / skeleton models | Need many links and camera labels (upgrade-roadmap) |

### 3.5 Model by model

Every output, with what it is built from and how it behaves in a new room
(the reason is §4: the room changes the exact pattern of the 52 numbers,
not the rhythm or the timing of a movement).

| # | Output | Method | Built on | New room | In the demo |
|---|---|---|---|---|---|
| 1 | Motion level | rule | how fast the signal changes (2–20 Hz) | works; empty calibration only scales it | yes |
| 2 | Presence | state machine on motion, static deviation, breathing energy | rule | moving: works; still: needs that room's empty calibration | yes |
| 3 | Breathing rate | DSP (exists: `lifefi/breathing.py`) | a 6–30 /min rhythm | works: rhythm, not pattern | yes |
| 4 | Breathing stopped | rule on #3 | breaths counted on a frozen direction | works | yes |
| 5 | Fall → fainted | two-stage rule | burst, then ≥ 3 s still, then 20 s still | works mostly; check `T_fall` with 1–2 falls | yes, **the headline** |
| 6 | Pulse | DSP (exists: `lifefi/heart.py`) | 45–120 /min rhythm | not the problem: the signal is below the noise | **no** |
| 7 | Transitions (T1) | GBM vs 1D CNN | 3 s movement shape | −10 to −15 points; AdaBN + head fine-tune | yes, if it beats the check run |
| 8 | Posture | state machine on #7 | — | follows #7 | with #7 |
| — | Fall verifier, count, bed exit | — | — | — | cut |

**1–2. Motion and presence.** Code: `lifefi/dsp.py` (§2.2 step 4), then
`lifefi/motion.py` and `lifefi/presence.py` per plan-v2 §6.1–6.2.
Data: our empty-room blocks (R1) for thresholds (`T_on = 1.5–2 × P99`,
`T_off = P95`); E4 (empty / sit / lie, per packet) to check that a still
person separates from empty in a room that is not ours. Judged by: enter
< 1 s, still person PRESENT for 10 min, EMPTY within 90 s.

**3. Breathing rate.** Already works offline. What is left:
- run it on `F` from `lifefi/dsp.py` instead of its own resampler, so the
  engine and the tool use the same signal;
- tune `MIN_CONFIDENCE` and `MIN_BAND_RATIO` on R2 (phyphox on the chest,
  paced 10 / 15 / 20 + natural, 2 people). That gives the first real
  number: median error, target ≤ 2 /min;
- E1 breathing files only after the per-file screen (dataset-preparation
  §5), never as accuracy: their labels are target rates.
- Limits, said in the UI: one person, still, near the link line.

**4. Breathing stopped.** New code on top of #3: freeze the PC1 direction
while breathing is valid, count breaths on it, alert after 12 s without
one (plan-v2 §6.4). Only our R3 breath-holds can tune it (no public data
exists). Judged by: a 15 s hold → alert within 18 s, no alert in the
overnight run R7.

**5. Fall → fainted.** New code: stage-1 burst features, stage-2
stillness, escalation (plan-v2 §6.5). Data: E1 FA vs LD / SD and E8 for
the feature ranges, then `T_fall` from our walking and sit-downs (R4) and
recall from our mat falls (R5); false alarms from R7. Judged by: staged
fall → phone ≤ 5 s; never "fainted" for lying down without a fall.

**6. Pulse: experimental, not in the demo.** On every recording so far the
heart band is flat noise; the "peaks" were breathing harmonics, and the
tool now says so ([engine README](../../engine/README.md#heart-rate-experimental)).
One antenna with int8 CSI is at its limit for 0.1–0.5 mm chest motion.
Spend no time on it this week beyond one test, during R2: chest 30–50 cm
from the board, 2 min still, a watch or finger clip as reference. Show it
only if it is within 5 /min of the reference on 3 recordings, and then
only as "experimental". The honest pitch line: "breathing yes, pulse not
with one ESP32".

**7–8. Transitions and posture.** §3.2–3.3 and §4.3. Order: E1 + E8
readers → GBM on leave-one-room-out → CNN, same split → fine-tune on room
A (R4) → test on locked room B (R6) → ONNX → AdaBN / head fine-tune
script for the venue. Posture is the plan-v2 §6.7 state machine; low
confidence shows "last known".

---

## 4. Can the models work in any room without recording there?

### 4.1 Short answer

**Partly, and we design for it, but we cannot skip the venue setup.**

- The Wi-Fi signal mostly describes the **room** (walls, furniture,
  router), the person is a small change on top. Change the room and the
  static signal changes completely. No published single-link ESP32 system
  works in an unseen room at its home-room accuracy; studies report
  **10–15 points lower** after a day or a furniture move
  ([csi-sufficiency-research §3.2](../research/csi-sufficiency-research.md)).
- What **does** carry over is the *movement shape*: a fall is a short
  burst then stillness, sitting down is a ~1–2 s burst that settles,
  walking is sustained. Our rules and our T1 input are built only on that.

### 4.2 What works in a new room, and what it needs there

| Output | Works in an unseen room? | What the venue must give |
|---|---|---|
| Motion level | **yes** | nothing (band-pass, offset-free); 2-min empty for 0–1 scaling |
| Presence, someone moving | **yes** | 2-min empty calibration |
| Presence, someone still | yes, **only with** a fresh empty calibration | 2-min empty, nobody in the room |
| Breathing rate | **yes** (no training) | one person, still, near the link line; RSSI better than −60 |
| Breathing stopped | yes | as breathing |
| Fall → fainted | **yes, mostly**: it is a burst + stillness rule. Hard sit-downs give false alarms | 2-min empty; ideally 2–3 test falls to check `T_fall` |
| Transitions → posture (T1) | **weaker**: expect −10 to −15 points | 2-min empty + ideally 5 min guided reps (§6) |
| Who is who (identification) | **no**, out of scope | — |
| How many people | **no** with one link. Only "1 / several" while moving, and weak | more links (upgrade-roadmap #3) |
| 2 people's separate states | **no**: one link sums everyone; breathing / falls assume one person | state it in the pitch |

So: **"any room, any objects"** is realistic for *motion, presence,
breathing, falls*. **"Tell people apart and know each one's state"** is not
realistic on one ESP32 link and should not be claimed. Saying so is a
strength in front of a jury that knows CSI.

### 4.3 How we make T1 as room-independent as possible

Five layers, cheapest first:

1. **Input that hides the room.** Model view `x` removes each window's
   mean per subcarrier (no static room profile, no gain), works in dB, and
   the GBM uses only cross-subcarrier summaries (§3.3).
2. **Train on many rooms.** E1 (1 room) + E8 (4 rooms) + E2 (1) + our
   own 2 rooms = **8 rooms**, ~40 people. Model selection by
   **leave-one-room-out**, never by a random split.
3. **Room augmentations** (§3.2: spectral tilt, subcarrier mixing,
   mixup across rooms, subcarrier dropout).
4. **AdaBN at the venue (no labels).** Record 3–5 min of normal movement
   in the new room, re-estimate only the BatchNorm means/variances, keep
   all weights. Seconds of compute, cannot overfit, and it is the
   standard first fix for a domain shift. This is why the CNN has
   BatchNorm.
5. **Head fine-tune at the venue (labels from a script).** 5 min guided
   reps; retrain the last linear layer only; keep it only if a **separate**
   2-min check run is not worse (plan-v2 §6.11).

And one safety net: if T1's top probability is below `uncertain_below`,
posture shows "last known" and the **rules still raise every alert**. A
weak T1 in the new room can never block a fall or breathing alert.

---

## 5. What we record ourselves before the event

Real sessions need our hardware in a usable state first: RSSI better than
−60 and 0 pauses in `link_check.py`, ≥ 80 Hz. Until the real engine
exists, record with `csi_recorder.py` and write labels with a tiny script
that appends lines to `labels.jsonl` on a key press. Prefer the plan-v2
line the labelling page writes, `{"kind": "mark", "t_press_us": <host µs>,
"event": "sit_down"}`; `ml/own.py` also reads `{"t": <host ms>, "label":
"sit_down"}`. Point marks cannot label spans (walking, empty): those need
`{"kind": "segment", "t_start_us", "t_end_us", "label"}`. `ml/own.py`
stops on any line it cannot read, so a wrong format shows up at once
instead of as an all-ignored training run.

Freeze the ESP and router settings **before** the first session and never
change them (data from different settings cannot be mixed).

### 5.1 Minimum list (must have by Mon 2026-11-02)

| # | What | Where | Time | Feeds |
|---|---|---|---|---|
| R1 | Empty room, 2 min at start and 3 min at end of every session | rooms A, B | 5 min / session | calibration, presence, `M` scale |
| R2 | Breathing with phyphox on the chest: paced 10 / 15 / 20 + 5 min natural, 2 people | room A | 15 min / person | breathing rule check (first real accuracy number) |
| R3 | Breath-holds 15–30 s, ×10, 2 volunteers, sitting (safety rules: plan-v2 §10.4) | room A | 15 min / person | `no_breathing` threshold |
| R4 | Transition session: 10 × each `sit_down`, `stand_up`, `lie_down`, `get_up`, 3 min walking, 2 people, vary chair / spot / speed | rooms A **and** B | 30 min / room | T1 fine-tune + **`stand_up`** (no public source) |
| R5 | 10–20 falls onto a mat + 10 each hard sit, dropped bag, quick lie-down | room A | 20 min | fall-rule `T_fall`, demo clip |
| R6 | Room B session R4 kept **locked** as the new-room test | room B | (in R4) | the honest "new room" number |
| R7 | One overnight empty / normal-use run | home | unattended | false alarms per night, drift |

That is ~3 h of people's time over 2 evenings. Room B must be a different
room (other furniture, other walls), so the leave-one-room-out number on
it is a real preview of the venue.

### 5.2 Nice to have

- A third room for the transition session (more rooms beat more reps).
- A rehearsal of the full venue protocol (§6) in a room nobody has used,
  with a stopwatch. **This is the single best test of the demo.**
- A "fall clip" recording from room A for replay mode, in case the live
  link fails on stage (plan-v2 §14).

---

## 6. At the venue: what we record and how

The demo room is new to the models. The protocol turns it into a known
room in **~15 minutes**, before the audience arrives. Everything here uses
code that must be ready and rehearsed by Wed 2026-11-04.

| Step | What | Time | Output |
|---|---|---|---|
| 0 | Our own router, fixed 2.4 GHz channel after a quick scan (pick the emptiest of 1 / 6 / 11), 20 MHz, laptop on Ethernet to it | 5 min | stable link, no venue Wi-Fi |
| 1 | Place ESP and router 3–5 m apart, ~1 m high, line crossing the chair / mat where we demo. `link_check.py` 60 s: RSSI better than −60, 0 pauses. Tape the positions, photograph | 5 min | placement (never moved again) |
| 2 | **Empty calibration**: everyone out of the link area for 2 min | 2 min | `μ_cal`, `σ_cal`, `p_empty`, P95/P99 of `S`, `B`, `M`: all rules are now live |
| 3 | **Free movement, no labels**: one of us walks, sits, stands for 3–5 min | 4 min | AdaBN statistics for T1 |
| 4 | **Guided reps**: 5 × each transition + 60 s walking, tapping labels | 5 min | head fine-tune data (optional) |
| 5 | **Check run**: 2 × each transition + 1 fall on the mat, labelled | 3 min | keep/reject the adapted T1; sanity check of `T_fall` |
| 6 | If the room fills with people: say on screen that still-person presence is calibrated empty; recalibrate if the room is ever empty again | — | honest UI |

Rules for the venue:
- Record **everything** from step 2 on as `.csirec` with labels. It is
  also our first real "unseen room" data, which goes into the report.
- If step 5 rejects the adapted model, ship the unadapted one; if T1 is
  weak overall, hide posture and demo the rules (fall, breathing,
  presence) only. The pitch does not depend on T1.
- Keep the replay recording ready (banner "replay").
- Ask the organisers in advance for 20 minutes in the room before the
  slot, and whether we can put a router there.

**Can this be sidelined completely?** No. Steps 0–2 (~12 min) are needed
by the *rules* too, whatever the model does, because still-person presence
and threshold scaling depend on the empty room. Of steps 3–5, **step 4
(guided reps) is probably the one that matters**: in the venue simulation
(§9.3) a head fine-tune improved the classes that were in its guided set,
while step 3 alone barely helped. That simulation could not test
transitions (E8 has none), and its gain was mostly on falls, which our
guided reps do not contain, so this is a suggestion until rooms A and B
show it (model-audit A.3). Skip step 3 if time is short, never step 4.

---

## 7. Day plan

| Day | Model / data work | Recording |
|---|---|---|
| **Thu 10-29** | Collect every `.csirec` into `firmware/recordings/`, run `engine/tools/inventory.py`. Install PyTorch (cu128), LightGBM, onnxruntime. `readers/common.py`, `qc.py`, `readers/e1.py`; `lifefi/dsp.py` offline | Fix the link (RSSI, pauses); freeze settings |
| **Fri 10-30** | `readers/e8.py`; `ml/windows.py` + labels + splits; CNN smoke test on E1 `x_trn.npy` | R7 overnight run starts |
| **Sat 10-31** | `M`, presence, fall rule, `no_breathing` on `F` (the demo needs these more than T1). GBM + CNN on E1 + E8, leave-one-room-out | **Evening 1, room A**: R1, R2, R3, R5 |
| **Sun 11-01** | Evaluate rules on R2 / R3 / R5. First T1 numbers | **Evening 2, rooms A + B**: R1, R4, R6 |
| **Mon 11-02** | T1 fine-tune on room A; test on locked room B; temperature scaling; ONNX export; AdaBN + head fine-tune script | — |
| **Tue 11-03** | Engine loads the ONNX, posture state machine, rule fallback. **Full rehearsal of §6 in an unused room** | rehearsal |
| **Wed 11-04** | Fix what the rehearsal broke. Write `docs/models.md`: data, splits, numbers with CIs, limits | replay clip |
| **Thu 11-05** | Demo: §6 protocol before the slot | venue data |

If Saturday ends without the rules working on our own data, drop T1 from
the demo and spend Sunday–Tuesday on the rules and the venue protocol.

---

## 8. Things that need a team decision

| # | Issue | Proposal |
|---|---|---|
| 1 | Hardware is a **classic ESP32** with a PCB antenna (upgrade-roadmap), plan-v2 and csi-for-models assume an **S3 with an external antenna** | Train and record on whatever board goes on stage, and use the same board for every recording from now on |
| 2 | The labelling page needs the real engine on port 6000, which does not exist | Record with `csi_recorder.py` + a key-press label script this week |
| 3 | `stand_up` has no public data | Record it (R4); fallback: merge with `get_up` into `rise` |
| 4 | E8 fall mapping not confirmed (§2.1) | Use it, never quote an E8 fall number |
| 5 | Count 1 vs 2+, fall verifier, bed exit | Out of the demo; mention as roadmap |
| 6 | Claims in the pitch | "Any room after a 2-minute calibration" for motion / presence / breathing / falls; **not** "any room, any person, any number of people" |

---

## 9. Results on public data (2026-10-29)

Everything below is **development numbers on other people's data**, never
Life-Fi accuracy. Each result file is in `ml/results/`; each script
re-runs in seconds to minutes.

### 9.1 What was built

| Piece | File | How to run |
|---|---|---|
| Shared signal processing `F` | `engine/lifefi/dsp.py` (+ `engine/tests/test_dsp.py`) | `python engine/tests/test_dsp.py` |
| Dataset readers + QC + manifests | `datasets/readers/{common,e1,e8,build}.py` → `datasets/processed/`, `datasets/manifest/` | `python datasets/readers/build.py e1 e8` (~1 min) |
| Fixed splits (written before training) | `datasets/manifest/splits.yml` | — |
| Windows, labels, folds | `ml/data.py` | — |
| Simple model (LightGBM) | `ml/features.py`, `ml/train_gbm.py` | `.venv/Scripts/python ml/train_gbm.py [--final]` |
| Neural network (CsiNet, 58,535 weights) | `ml/model.py`, `ml/train_cnn.py` | `.venv/Scripts/python ml/train_cnn.py [--final]` |
| ONNX export (model view + softmax inside the graph) | `ml/export.py` | `.venv/Scripts/python ml/export.py ml/models/csinet.pt` |
| Our recordings → windows (marks snapped ± 1.5 s) | `ml/own.py` | used by `adapt.py` |
| Venue adaptation (AdaBN, head fine-tune, keep/reject, export) | `ml/adapt.py` | see its docstring; **not run on real data yet** |
| Venue simulation | `ml/venue_sim.py` | `.venv/Scripts/python ml/venue_sim.py` (~4 min) |
| Motion `M`, fall rule | `engine/lifefi/motion.py`, `engine/lifefi/fall.py`, `ml/tune_fall.py` | `.venv/Scripts/python ml/tune_fall.py` |
| Fall-rule thresholds from our recordings | `ml/tune_fall_own.py` | `.venv/Scripts/python ml/tune_fall_own.py --empty empty.csirec falls.csirec:labels.jsonl ...` |
| Label reading tests (no data needed) | `ml/tests/test_own.py` | `.venv/Scripts/python ml/tests/test_own.py` (also in CI) |
| Breathing check on E1 | `ml/tune_breathing.py` | `.venv/Scripts/python ml/tune_breathing.py` |
| Presence check on E4 | `ml/check_presence.py` | `.venv/Scripts/python ml/check_presence.py` |
| Trained models | `ml/models/{gbm.txt,gbm.onnx,gbm.json,csinet.pt,csinet.onnx}` | ONNX vs original ≤ 1e-4 checked |

The ML packages live in `.venv/` (PyTorch 2.11 cu128 on the RTX 5050,
LightGBM 4.7, onnxruntime 1.31), pinned in `ml/requirements.txt` (its
header has the install steps). `ml/models/` is gitignored: rebuild with
`--final` and `ml/export.py`.

### 9.2 Data problems found and fixed

- **E1 line-ending corruption.** The logger wrote a `13` before every
  value `10` (CR LF), shifting the rest of the row by one, so imaginary and
  real parts swap. **61 % of all E1 rows** are affected, and no `10` in the
  whole set is without its `13`, so the repair is exact. Rows were cut to
  a fixed length, so the last subcarriers of an affected row are lost and
  copied from their neighbour; rows missing more than 4 pairs are dropped.
  The authors' `x_trn.npy` was most likely built from the corrupted rows.
- **E1 events have no clear fast-motion peak** (int8 amplitudes around 20,
  so noise is 0.3–1 dB per sample). Event times come from the *slow*
  profile change instead: located in 62–86 % of E1 clips instead of ~5 %
  (`ml/data.py`).
- **E1 "falls" are gentle**: weaker than E1's own sit-downs. They stay in
  the movement model but are useless for the fall rule. (The reason given
  before, "removing them dropped unseen-room fall detection from 95 % to
  77 %", was an E8 fall number on the old threshold-free score, which is
  close to automatic there: model-audit A.1.)
- **E8 activity 1 ("run") looks exactly like activity 2 ("fall")** on
  every measure; one of the two labels may be wrong. "run" is left out.
- 463 of 2,240 E8 clips have > 1 % saturated frames and are left out of
  training (dataset-preparation §4.4).

### 9.3 Movement model (sit / stand / lie / get up / walk / fall / none)

| Test | Simple model (LightGBM) | Neural network (CNN) |
|---|---|---|
| Unseen E1 people, **transition F1** (sit / lie / get up; mean of 5 folds) | **0.24** | 0.17 |
| Unseen E1 people, events found at p > 0.5 (constant guess: 0.31) | 0.28 | 0.32 |
| Unseen E1 people, walking clips with a false event | **32 %** | 36 % |
| 3 locked E1 people (scored once), right movement, top-1 (constant guess: 0.27) | 14 % | 20 % |
| Unseen E8 room, macro-F1 over none / walking / fall (mean of 4) | 0.54 | 0.38 |
| Unseen E8 room, quiet clips with a false event | 7 % | 24 % |

Re-scored 2026-10-29 with `ml/evaluate.py` v2 (model-audit A.1). The E8
rooms hold no sit / lie / get up, so their rows say nothing about
transitions; their `fall` is the unconfirmed E8 label. On people they
have not seen, **neither model recognises a transition better than always
answering the most common one**. The simple model stays the default
(better transition F1, fewer false events), but posture goes into the
demo only if room B (R6) clearly beats the constant guess.

**Venue simulation** (`ml/venue_sim.py`): each E8 room in turn played the
venue; half its recordings were the "setup", the other half the "demo".

| Model | No adjustment | + free movement (AdaBN) | + 5 min guided reps |
|---|---|---|---|
| Neural network | 0.38 | 0.40 | **0.56** (false events 25 % → 2 %) |
| Simple model | 0.54 | — | **0.61** |

Read with care (model-audit A.3): the guided set was random E8 clips, so
it held falls, which our guided reps will not; the gain is mostly `fall`
and `none`; walking got worse in 3 of 4 rooms; and setup and demo halves
are the same people in one session. **Consequence for §6:** guided reps
(step 4) probably matter more than free movement, which barely helps, but
that is a suggestion until rooms A and B test it on transitions.

### 9.4 Rules

| Rule | Result | Consequence |
|---|---|---|
| **Breathing rate** (E1, 66 paced files, targets not a reference) | Current gates: a rate in 16 % of 30 s windows, 91 % of them within ± 2 /min of the metronome. New `MIN_CONFIDENCE = 0.40`: 15 %, **95 %** right. Held out (gates picked on half the subjects, scored on the other half): 98–99 % right, 14–24 % of windows valid, so the sweep did not flatter it. A looser band ratio (1.5) gave more readings but let movement through in the TypeScript motion test, so it stays 2.0 | Changed in both `breathing.py` and `breathing.ts`; all 4 test suites pass. Weakest at 15 /min (78 % right; 10 /min 99 %, 20 /min 88 %). Only 30 of 66 recordings give any valid window |
| **Presence, still person** (E4, 3 days) | Static profile: an empty room drifts as much in 10 min (0.03–0.2 dB) as a still person changes it (0.15–0.5 dB); AUC 0.62–0.90; a threshold from a 2-min calibration flags later empty recordings as occupied. **Breathing-band energy: AUC 0.98–1.00 every day**; threshold from one day's empty room: still person found in 55–100 % of 30 s windows, empty flagged ≤ 3 %, also two days later | Presence for a still person must lean on **breathing energy `B`**, with the static profile `S` only as a helper. `T_S` from a 2-min calibration is far too tight |
| **Fall rule** (E8) | E8 impacts (45–170× quiet level) overlap walking / jumping (up to ~230×); E8 subjects move again right after falling, so the stillness stage cannot be tested; E1 falls are gentle | **No public set can tune or prove the fall rule.** Code is ready (`lifefi/fall.py`); thresholds are placeholders to set from our mat falls (impact *then* lying still) with `ml/tune_fall_own.py` |

### 9.5 What tomorrow's recordings must cover first

1. **Mat falls with 10 s lying still** + hard sit-downs / dropped bag: the
   only data that can set the fall rule.
2. **Transition reps in rooms A and B**, especially `stand_up` (no public
   source), for the fine-tune and the honest new-room number.
3. **Empty room vs one person sitting still** for 5+ min each: confirms
   the breathing-energy presence threshold on our hardware.
4. **Breathing with phyphox on the chest**: the first real breathing
   accuracy number.

Then: `python engine/tools/inventory.py` on the files, label them, and
re-run `ml/train_gbm.py` / `ml/train_cnn.py` with our sessions added.
