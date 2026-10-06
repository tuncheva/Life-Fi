# Model Scope and Phases

This document covers the model side of [plan-v2.md](plan-v2.md). It answers
three questions:

1. Which models and detectors exist, and what does each one need?
2. Which of them actually learn from data, and how much data?
3. In which phases is the model work done, and what is the gate for each?

Where to get data from outside the project is covered in
[training-data-sources.md](../research/training-data-sources.md). The CSI details per
model are in [csi-for-models.md](csi-for-models.md). Where this file and
plan-v2 disagree, plan-v2 wins.

Tags: **[V]** stated in plan-v2 / csi-for-models, **[H]** estimate or
heuristic in this document.

---

## 1. Scope: every model and detector

The key point: **only three components learn weights.** Everything else is
DSP, a rule or a state machine whose thresholds are set from recordings.
That is deliberate (plan-v2 D6): the core demo needs no training data.

| # | Output | Kind | Learns weights? | Tier | Needs calibration? | Data it needs | Main metric |
|---|---|---|---|---|---|---|---|
| 1 | Motion `M` | statistic (2–20 Hz variance + turbulence) | no | Must | scaling only | empty room (P99) | checked vs walking/static segments |
| 2 | Presence | state machine on `S`, `B`, `M` | no (thresholds) | Must | yes (empty) | empty + still + moving, ≥ 2 rooms | enter < 1 s, still person PRESENT 10 min, EMPTY < 90 s |
| 3 | Breathing rate | DSP (PC1 + FFT) | no | Must | no | paced + natural breathing **with chest reference** | median error ≤ 2 bpm |
| 4 | `no_breathing` | rule (breath counting on frozen `v`) | no (threshold) | Must | no | breath-holds 15–30 s + long runs | alert ≤ 18 s; FA/h with CI |
| 5 | Fall → fainted | two-stage rule | no (thresholds) | Must | no | falls on mat + hard negatives + long runs | recall + FA/h with CI; phone ≤ 5 s |
| 6 | Calibration / drift | statistic + Page–Hinkley | no | Must / Should | is calibration | empty runs over days | drift caught, no false re-baseline |
| 7 | **Transition model** | **GBM → 1D CNN (~43 k params)** | **yes** | Should | **no** | 4–6 labelled sessions, ≥ 2 rooms | event macro-F1, within-room and new-room |
| 8 | Posture | state machine on transitions | no | Should | no | (uses #7) | follows transitions |
| 9 | **Fall verifier** | **GBM on stage-1 features** | **yes** | Should (optional) | no | fall candidates + hard negatives | removes FA without losing recall |
| 10 | Bed exit | profile correlation | no | Should | empty + bed profiles | bed empty / in bed / exits | exit detected, link crosses bed |
| 11 | **Count 1 vs 2+** | **small model on `x`** | **yes** | Could | no | 1 vs 2 people, moving and still | accuracy while moving |
| 12 | Occupancy level | statistic | no | Could | via presence | normal lesson vs empty | — |
| 13 | Long inactivity / restlessness / routine | server statistics | no | Should / Could | no | days of history (or labelled-as-simulated) | — |
| 14 | `onsite_adapt` | AdaBN + head fine-tune of #7 | adapts #7 | Should | no | 12-min guided procedure | keep/reject decision correct |

**Out of scope** (plan-v2 §13): heart rate, gestures, identification, sleep
stages, phase-based features. Do not spend data or time on them.

### 1.1 What "learning data" means per component

| Component | Data is used to… | Volume |
|---|---|---|
| Rules and detectors (#1–6, 10, 12) | set and tune thresholds, then **evaluate** | minutes per scenario, plus hours of long runs for FA/h |
| Transition model (#7) | **train** + validate + locked test | ~350 positive windows per session, ~1,400 over 4 training sessions [V] |
| Fall verifier (#9) | train a small GBM | 10–20 falls + 30 hard negatives per session [V] |
| Count (#11) | train a small model | 5 min moving + 3 min still with 2 people per session [V] |
| Pretraining (optional) | self-supervised / warm start of the CNN | unlabelled long runs (free) and public ESP32 datasets |

---

## 2. Total data budget

| Data | Amount | Who / when | Feeds |
|---|---|---|---|
| Labelled sessions | 4–6 sessions × 60–75 min = **4–7.5 h** active, ≥ 2 rooms, 1–2 sessions locked for test [V] | 2–3 people, ~2 evenings per room | #2, #5, #7, #9, #11, #10 |
| Breathing reference | per person: 5 × 1 min paced (10/15/20 /min) + 5 min sitting + 5 min lying ≈ **15 min** [V] | each volunteer | #3 |
| Breath-holds | 10 × 15–30 s per volunteer ≈ **10–15 min** incl. recovery [H] | volunteers only, ≤ 30 s | #4 |
| Unlabelled long runs | overnight + workdays, **days** total; ~100 MB/h raw [V] | from Phase 2 on, running unattended | FA/h, drift, routine, pretraining |
| Fixture | one small real `.csirec` + labels + expected `F` | Phase 5 | CI |

FA/h needs time, not effort: with zero alarms in T hours, the 95 % upper
bound is 3/T per hour [V]. A claim of "< 1 false alarm per day" therefore
needs about **3 days** of long runs. Start them early.

---

## 3. Model phases

These phases sit on top of the build phases in plan-v2 §9. M-phases are
about the models and the data; the P-number shows which build phase they
run alongside. Each phase ends with a gate.

```
P1 ─ M0 data tooling ─┐
P2 ─ M1 signal + measurements + long runs start ───────────────▶ (long runs keep going)
P3 ─ M2 detectors (no training) ─┐
P4 ─ M3 fall rule ───────────────┤
P5 ─ M4 labelled sessions ───────┴─▶ P6 ─ M5 transition model ─▶ M6 optional models ─▶ P7 ─ M7 adaptation + report
```

### M0: Data tooling (with P1, no hardware)

**Why:** every later step reads data through these tools. Bugs here
silently corrupt every model.

- [ ] `.csirec` read/write with round-trip tests
- [ ] `fakesensor`: empty room, breathing that stops, spike + stillness,
      gain steps, packet loss, reboot. **For tests only, never training**
      (plan-v2 §6.12)
- [ ] `lifefi.dsp` skeleton shared by engine and `ml/`
- [ ] Dataset converter stub: public data → `F` `[T, 52]` dB 50 Hz
      (see [training-data-sources.md](../research/training-data-sources.md))

**Gate:** round-trip tests pass; a fake file goes through the pipeline.

### M1: Real signal, measurements, start collecting (with P2)

**Why:** every model is only valid for the CSI configuration it was trained
on. Fix that configuration first.

- [ ] Run the measurement checklist ([csi-for-models §8](csi-for-models.md)):
      rate, frame mix, `shift`, LLTF vs HT-LTF, gain across reboots, clock
      drift, empty-room σ, breathing vs placement
- [ ] Freeze `PIPELINE_VERSION = 2` and write `model_io.md`
- [ ] `dump_features` + chunk-invariance CI test
- [ ] **Start unlabelled long runs** and keep them going
- [ ] Optional: load 1–2 public ESP32 datasets through the converter and
      check that their `F` looks similar to ours (level, noise, band
      energies). If it doesn't, don't use them for pretraining

**Gate:** checklist filled; ≥ 80 Hz, < 5 % loss; `F` from live and from
`dump_features` identical.

### M2: Detectors with no training (with P3)

**Why:** presence, motion, breathing and cessation work from day one and
are the fallback for everything learned.

- [ ] Motion `M`, presence state machine, breathing PC1/FFT, `no_breathing`
- [ ] Thresholds from the empty calibration (`T_on = 1.5–2 × P99`,
      `T_off = P95`) [V]
- [ ] `label-cli` (marks + segments) so recordings can be labelled now
- [ ] `evaluate`: event recall, FA/h with CIs, breathing error
- [ ] **Record:** paced + natural breathing and breath-holds, all with chest
      reference (phyphox phone or belt), synced by a tap
- [ ] Unit tests for every detector on `fakesensor`

**Gate (plan-v2 P3):** breathing ±2 bpm median on 3 recordings; still
person PRESENT 10 min; EMPTY within 90 s; breath-hold ≥ 15 s → alert
within 18 s.

### M3: Fall rule (with P4)

**Why:** the most important alert, and it's a rule, so it needs data for
thresholds and evaluation, not training.

- [ ] Stage-1 features (variance ratio, 2–20 Hz share, burst length, max
      |diff|, kurtosis), stage-2 stillness, fainted escalation
- [ ] `T_fall` = P99.9 of `M` during walking and sit-downs [V]
- [ ] **Record:** 10–20 falls on a mat + 10 of each hard negative per
      session (safety rules in plan-v2 §10.4)
- [ ] Report recall + FA/h with CIs on long runs

**Gate:** staged fall → phone ≤ 5 s; fainted after 20 s still; never
fainted for lying down in bed without a fall.

### M4: Labelled sessions (with P5, can overlap P4)

**Why:** the transition model is gated by data, not code. This is the
largest piece of human time in the project.

- [ ] Labelling page + `check_session` (labels in range, no overlaps, marks
      snapped to the motion peak within ±1.5 s)
- [ ] `session.json` for every session (room, placement photo, subjects)
- [ ] Record 4–6 sessions in ≥ 2 rooms (blocks in plan-v2 §10.1)
- [ ] **Lock 1–2 test sessions now**, including one from a room not used
      for training. Write them into the split config before any training
- [ ] Commit one small fixture to `contracts/fixtures/`

**Gate:** a UI-labelled session passes `check_session`, and its replay
gives the same events as live.

### M5: Transition model (with P6)

**Why:** sit/stand/lie transitions cannot be done with a threshold.

1. [ ] `ml/` loader: `lifefi.dsp` + `labels.jsonl` → windows `[150, 52]`
       with the 70 % overlap labelling rule; −100 for ambiguous windows
2. [ ] Splits: leave-one-session-out for model selection; leave-one-room-out
       reported; locked sessions refused by the training script
3. [ ] **GBM baseline** on `lifefi.features` (LightGBM, class-weighted)
4. [ ] **1D CNN** (~43 k params) on model view `x` with the augmentations
       in plan-v2 §6.8
5. [ ] Optional: **pretrain** the CNN encoder on unlabelled long runs (and
       public ESP32 data if M1 showed it is similar), then fine-tune. Keep
       it only if leave-one-session-out F1 improves
6. [ ] Temperature scaling on a held-out session; `uncertain_below`
7. [ ] Pick GBM vs CNN by event-level macro-F1; export ONNX opset 18 + `.pt`;
       PyTorch vs ORT ≤ 1e-4
8. [ ] Engine: load, refuse version mismatches, transitions → posture state
       machine, `uncertain` → rule fallback
9. [ ] Report with CIs on the **locked** sessions: within-room and new-room

**Gate (plan-v2 P6):** test vectors pass in CI; live posture follows
transitions; report shows both F1 numbers with CIs.

**Expectation:** good within the trained room, clearly weaker in a new
room (ESP32 studies report drops of 10–15 points day-to-day or after
furniture moves [V, csi-sufficiency-research §3.2]). That is why M7 exists.

### M6: Optional learned models (with P6/P7)

Do these only if M5 is done and there is time left.

| Model | Do it when | Training data | Keep it if |
|---|---|---|---|
| Fall verifier (GBM) | fall FA/h in M3 is too high | stage-1 features of all fall candidates: falls vs hard negatives | FA drops and recall on locked sessions does not drop |
| Count 1 vs 2+ | School page is in the demo | 2-person blocks | clearly better than chance while people move; shown as "1 / several" |

### M7: Adaptation, drift and final report (with P7)

- [ ] `onsite_adapt`: empty calibration → 5 min guided recording → AdaBN
      → head fine-tune → **separate** 2 min validation → keep/reject
      (≈ 12 min). Rehearse once in an unfamiliar room
- [ ] Drift re-baseline (Page–Hinkley) tested on the long runs
- [ ] Bed exit (Clinic), if in the demo
- [ ] `docs/models.md`: data used, splits, metrics with CIs, cross-room
      result, honest limits (plan-v2 §13)

**Gate:** plan-v2 §12 checks 3–8 and 13 pass.

---

## 4. Evaluation rules (all phases)

- Split by **whole session**, never by window. Neighbouring windows are
  near-copies.
- Locked test sessions are chosen before training and never looked at
  while tuning.
- Report every rate with a 95 % CI: Wilson for proportions, rule of three
  / Poisson for FA/h.
- Event-level metrics (one detected event per real event), not window
  accuracy.
- Public datasets are **never** the test set. Results must be on our own
  hardware, configuration and rooms.

## 5. What public data can and cannot do here

| Use | Worth it? | Why |
|---|---|---|
| Pretraining / warm start of the transition CNN | maybe | Only ESP32 amplitude data is close enough; check similarity in M1 first |
| Comparing GBM vs CNN architectures | yes, cheap | Any HAR dataset works for that |
| Sanity-checking breathing DSP | yes | Datasets with a reference sensor let us test the algorithm before our recordings exist |
| Setting our thresholds | **no** | Thresholds depend on our room, router, `shift` and placement |
| Final evaluation | **no** | Different hardware and configuration; not our claim |
| Replacing our own recordings | **no** | Nothing public matches LLTF, 52 subcarriers, 50 Hz, our router and our labels (transitions, hard negatives) |

The candidate datasets and their fit are in
[training-data-sources.md](../research/training-data-sources.md).

### 5.1 Which public data goes into which phase

| Phase | Public data to use | What for |
|---|---|---|
| M0 | Embedded_WiFi_Sensing (ESP32, 50 Hz, LLTF layout) | First target for the converter; real CSI to develop `lifefi.dsp` on before our hardware works. Check the suspicious `13,10` byte pairs first |
| M1 | ESPectre data, 3DO | Compare their `F` (level, noise, band energies) with ours |
| M2 | ESPectre (empty / still / motion, 4 rooms); Embedded_WiFi_Sensing breathing (paced 10/15/20 /min, **no** reference sensor) | Develop presence and breathing code; paced rate is a weak ground truth |
| M3 | Embedded_WiFi_Sensing falls vs lie-down; WiFall; CSI-Bench ESP32 fall slice (licence: internal use only) | Develop the fall features and see which hard negatives fool them |
| M5 | Embedded_WiFi_Sensing (sit down, get up, lie down, walk), WiFall (sit, stand, walk), 3DO | Pretrain / warm-start the CNN; compare GBM vs CNN |

**Gaps that only our own recordings can fill:** breath-holds with a chest
reference (the biggest safety gap; the only ESP32 apnea set is paid), bed
exit, dropped objects as a hard negative, `stand_up` as its own class,
two still people, and transition onset marks (public sets label whole
clips).
