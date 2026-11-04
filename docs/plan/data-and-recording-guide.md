# Data and Recording Guide

This guide answers four questions in plain language:

1. **What does "our own recordings" mean**, and why aren't the public
   datasets enough?
2. **Which parts of Life-Fi actually predict something**, and which are
   just rules?
3. **What data does each part need**, and what exactly do we have to do
   for it (a to-do per part)?
4. **How do we record**, step by step?

It pulls together [plan-v2 §6, §9 and §10](plan-v2.md),
[model-scope-and-phases.md](model-scope-and-phases.md),
[csi-for-models.md](csi-for-models.md) and
[dataset-preparation.md](dataset-preparation.md). Where they disagree,
plan-v2 wins.

## Contents

1. The big picture
2. The full table: everything that is needed
3. Rules: the parts that are not trained (with to-dos)
4. The three trained models (with to-dos)
5. Recording tutorial
6. Master to-do, in build order
7. Total data budget
8. Common mistakes

---

## 1. The big picture

### 1.1 What "our own recordings" means

It means: the ESP and our router stand in a real room, a volunteer does
the movements, and **an operator presses a button at the moment each one
happens**. That is all.

Nobody sits afterwards and goes through hours of data. Labelling happens
**live, while recording**:

- The volunteer sits down; the operator taps `sit_down` when they land on
  the chair.
- The software moves that tap to the strongest movement within ±1.5 s, so
  the tap doesn't have to be precise.
- After each block, you fix any wrong taps while you still remember them.

So one 30–75 min session comes out already labelled. Some recordings need
no labelling at all:

- **Empty room**: everyone leaves for 2 minutes.
- **Long normal days**: leave the ESP recording overnight and write a short
  note of who was in the room.

### 1.2 Why the public datasets are not enough

The Wi-Fi signal mostly describes **the room**: the walls, the furniture,
where the router stands. The person is a small change on top. A model
trained on someone else's room gets noticeably worse in ours (studies show
10–15 points lower).

| | Public datasets | Our recordings |
|---|---|---|
| What they are for | Building and debugging the code, choosing the model, pretraining | Tuning to our room, and **proving it works** |
| Our room, router, placement | ❌ | ✅ |
| True breathing (chest reference) | ❌ (E1 has only the *target* rate) | ✅ phone on the chest |
| Breath-holds | ❌ | ✅ |
| Two people at once | ❌ | ✅ |
| False alarms in a normal day | ❌ | ✅ long runs |
| Can be used for final results | **Never** | ✅ locked test sessions |

So the datasets do the expensive part (lots of examples, many people). Our
recordings do the cheap but essential part (a few short sessions in our
own setup).

### 1.3 Who gives what

| Source | What it gives | What it can never give |
|---|---|---|
| **The ESP** | The Wi-Fi signal: 52 measurement points about 100 times per second, with exact timing (the current board on the team router gives 100–180 per second, with pauses on a weak link: [upgrade-roadmap](upgrade-roadmap.md)). Every detector and model reads only this | What actually happened in the room |
| **A person** (button presses) | What happened and when: "sit-down at 12:03:41", "room empty from … to …" | — |
| **A phone on the chest** (or a breathing belt) | The true breathing, to check our breathing numbers against | — |
| **Public datasets** | Other people's ESP signal *with* their labels, from other rooms | Our room, our router, our setup, our final results |

### 1.4 Which parts predict: rules vs trained models

**Most of Life-Fi is not machine learning.** Only three parts learn from
examples (they have weights):

| # | Trained model | Priority |
|---|---|---|
| T1 | **Transition model**: sit down, stand up, lie down, get up | Should (the only one that really matters) |
| T2 | **Fall verifier**: second opinion on a detected fall | Should, optional |
| T3 | **Count 1 vs 2+** | Could, only if time allows |

Everything else is a **rule** or a **calculation** written by hand.
Presence, motion, breathing, breathing stopped and the fall alarm (all the
*Must* parts) need **no training at all**. They work from day one.

Rules don't learn, but they still need short recordings, for two reasons:

- **to set thresholds**: for example, how hard a movement must be to count
  as a fall;
- **to prove they work**: how many falls are caught, how many false alarms
  per day, how far off the breathing rate is.

So "not trained" does **not** mean "needs no data". §3 lists what each
rule needs.

### 1.5 Two tracks: Minimum and Full

| Track | What it covers | Recording time |
|---|---|---|
| **Minimum** | All *Must* parts, plus T1 trained mostly on E1 and checked on our data | ~3 evenings + unattended long runs |
| **Full** (plan-v2 §10) | Everything, including T2, T3, bed exit, occupancy, a properly measured T1 | ~5 evenings + unattended long runs |

Do the Minimum track first. It already gives a working demo with honest
numbers. Move to the Full track only if there is time. Each to-do below is
marked **[Min]** (part of the Minimum track) or **[Full]**.

---

## 2. The full table: everything that is needed

Columns:
- **T1 / T2 / T3**: the three trained models (§4).
- **Rules**: the non-trained parts that need it (§3).
- **ESP?**: can the ESP produce it by itself?
- **Public data**: which downloaded datasets have it
  ([dataset-preparation §3](dataset-preparation.md)).
- **We record**: what we must record ourselves (details in §5).
- **Track**: Min or Full (§1.5).

| What is needed | T1 | T2 | T3 | Rules that need it | ESP? | Public data | We record | Track |
|---|---|---|---|---|---|---|---|---|
| **Wi-Fi signal, 52 points, ≥ 50 per second** | ✅ | ✅ | ✅ | all | ✅ yes | E1, E2, E4, E5, E7, E8, E9 | every session | Min |
| **Empty room** | — | — | — | presence, motion, calibration, drift, bed exit, occupancy | ✅ signal · ❌ knowing it's empty | E3, E4, E5 | 2 min at start + 3 min at end of every session | Min |
| **Person standing / sitting / lying still** | — | — | — | presence, posture | ❌ label | E3, E4 | 2–3 min each, at 2–3 spots | Min |
| **Sit-downs**, labelled | ✅ | as look-alike | — | fall rule (threshold) | ❌ label | E1, E2, E7 | 10–20 per session | Min |
| **Stand-ups**, labelled | ✅ | — | — | — | ❌ label | weak (E2, E7) | 10–20 per session | Min |
| **Lie-downs**, labelled | ✅ | as look-alike | — | — | ❌ label | E1 | 10–20 per session | Min |
| **Get-ups**, labelled | ✅ | — | — | — | ❌ label | E1 | 10–20 per session | Min |
| **Walking** | ✅ | — | ✅ | motion, fall rule (threshold) | ❌ label | E1, E2, E4, E5, E7, E8 | 3–5 min per session | Min |
| **Falls**, labelled | as "none" | ✅ | — | fall rule | ❌ label | E1, E8, E2, E9 | 10–20 onto a mat | Min |
| **Fall look-alikes** (hard sit, dropped bag, quick lie-down) | — | ✅ | — | fall rule | ❌ label | E1, E8, E7 | 10 of each | Min |
| **Paced breathing with a chest reference** | — | — | — | breathing rate | ❌ needs a phone or belt | none (E1 has targets, no reference) | 5 × 1 min per person | Min |
| **Natural breathing with a chest reference** | — | — | — | breathing rate | ❌ needs a phone or belt | none | 5 min sitting + 5 min lying per person | Min |
| **Breath-holds with a chest reference** | — | — | — | breathing stopped | ❌ needs a phone or belt | none | 10 × 15–30 s per volunteer | Min |
| **When each movement starts** | ✅ | ✅ | — | fall rule | ✅ from the movement peak | none (whole clips only) | a button press, snapped automatically | Min |
| **Long normal days** (no labels) | optional pretraining | false alarms | — | breathing stopped, fall rule, drift, inactivity / routine | ✅ just leave it recording | none | from Phase 2 on, overnight and workdays | Min |
| **Several rooms** | ✅ ≥ 2 | ✅ | ✅ | presence | — | E8 (4), E7 (3), E3 (4), E5 (5) | ≥ 2 rooms | Min |
| **Several people** | ✅ | ✅ | ✅ | breathing | — | E1 (22), E8 (8), E7 (8) | 2–3 volunteers | Min |
| **Locked test sessions** | ✅ | ✅ | ✅ | all evaluations | — | never public data | 1–2 sessions, one from an unseen room | Min |
| **1 person and 2 people, moving** | — | — | ✅ | breathing (turns off with 2+) | ❌ label | WiCount, not checked yet (§4.3) | 5 min per session | Full |
| **2 people sitting still** | — | — | ✅ | — | ❌ label | none | 3 min per session | Full |
| **Bed empty / in bed / getting out** | — | — | — | bed exit | ❌ label | none | 2 min, 5 min, 10 exits (Clinic only) | Full |
| **Normal lesson vs empty classroom** | — | — | — | occupancy | ❌ label | none | one lesson (School only) | Full |
| **Short guided recording in a new room** | ✅ re-tune | — | — | calibration | ✅ signal, labels from a script | — | ~12 min per new room | Full |

---

## 3. Rules: the parts that are not trained

These are built first (plan-v2 Phases 3–4), because they need no training
and are the fallback for everything else. For each rule: what it does, how
it works, what data it needs, the pass mark, and a to-do.

### 3.1 Presence (Must)

- **Does:** decides EMPTY / PRESENT / UNCERTAIN, including for a person
  sitting completely still.
- **How:** compares the current signal with the empty room. If it is
  clearly different, or there is motion, or there is breathing, someone is
  there.
- **Needs data for:** its thresholds come from the empty room (on = 1.5–2 ×
  the empty room's 99th percentile, off = its 95th percentile).
- **Pass mark:** entering detected in < 1 s; still person stays PRESENT for
  10 min; EMPTY within 90 s of leaving.
- **Public data:** E4, E3, E5 to develop the code. Thresholds must come
  from our room.

**To do**
- [ ] [Min] Develop the presence state machine on E4 / E3 / E5 (Phase 3).
- [ ] [Min] Record 2 min of empty room at the start of every session; the
      calibration step sets the thresholds from it.
- [ ] [Min] Record the static blocks (standing / sitting / lying still) and
      check a still person stays PRESENT for 10 min.
- [ ] [Min] Walk in and out of the room 5 times; check entering < 1 s and
      EMPTY within 90 s.

### 3.2 Motion (Must)

- **Does:** a 0–1 number for how much is moving.
- **How:** how much the signal jumps around in the last 0.5 s, scaled so
  1 = the empty room's 99th percentile.
- **Needs data for:** scaling only.
- **Pass mark:** walking > waving > still > empty.
- **Public data:** any dataset works for checking.

**To do**
- [ ] [Min] Check the order walking > waving > still > empty on E4 / E5
      (Phase 3).
- [ ] [Min] Scale from our empty-room calibration; repeat the order check
      on one of our sessions.

### 3.3 Breathing rate (Must)

- **Does:** breaths per minute for one still person.

**How it finds breathing in the Wi-Fi signal.** This is physics, not
learning:

1. The chest moves a few millimetres with each breath. That slightly
   changes the paths the Wi-Fi waves take, so the 52 points go up and down
   in time with the breathing.
2. Each point's average is removed. What's left is only the change.
3. A filter keeps only slow rhythms: 0.1–0.5 Hz, which is 6–30 breaths per
   minute. Walking, fidgeting and noise are faster and are cut out.
4. Some points see the chest clearly and some barely at all. The 8 points
   with the cleanest slow rhythm are picked and merged into one signal
   (with PCA, which finds the main pattern they share).
5. Over 30 s, a frequency analysis (FFT) finds the main repetition. A peak
   at 0.25 Hz means 0.25 × 60 = **15 breaths per minute**.
6. A confidence number says how clear the peak is. Below a threshold
   (`c_min`), the UI shows "—" instead of a number.

It "knows" it is breathing because nothing else in a still room repeats
every 2–10 seconds. That is also why it only works when the person is
**still and alone**: walking drowns the rhythm, and two people's rhythms
mix. (Full details: plan-v2 §6.3.)

**What the phone on the chest is for.** The phone is **not** training data.
It is a **measuring stick**. Without it, if the system says
"14 breaths/min", there is no way to know if that is right.

The phone's accelerometer sees the chest rise and fall much more clearly.
The **same** steps (filter, FFT) on the phone data give the **true** rate:

```
Wi-Fi signal  → filter → FFT → 14.5 breaths/min   (our estimate)
Phone on chest → filter → FFT → 15.0 breaths/min  (the truth)
                                → error = 0.5
```

Done for every 30 s window of every breathing recording, this gives:

- **The accuracy number** we report: median error, pass mark ≤ 2 per
  minute.
- **The best settings:** we try different filter bands, window lengths and
  ways of picking the 8 points, and keep whatever gives the smallest error
  against the phone. That is our "training": tuning settings, not
  learning weights.
- **When to trust the number:** how clear the peak must be (`c_min`) before
  the number is shown.
- **Where it works:** recordings at 0.5 m and 1.5 m off the link line show
  where the error starts to grow.

**Lining the two up.** The phone and the laptop have separate clocks. Three
sharp taps on the chest show up as spikes in the phone data *and* as a
small burst in the Wi-Fi signal. Matching the spikes gives the time
offset (§5.6).

- **Public data:** E1 has paced breathing, but only the *target* rate, and
  only about a third of its files match it. Good for developing code, never
  for proving accuracy.

**Already there:** the estimator itself, `engine/lifefi/breathing.py`
(with a TypeScript port). Synthetic tests pass, and the first counted
recording gave 9.2 /min against 10 counted
([engine README](../../engine/README.md)). Until the phone side exists,
counting breaths for a minute is the rough reference.

**To do**
- [ ] [Min] Run the breathing code on the E1 breathing files that pass
      the quality screen ([dataset-preparation §5](dataset-preparation.md))
      (Phase 3).
- [ ] [Min] Install phyphox on a phone; check that a chest pocket or snug
      strap shows a clear breathing wave.
- [ ] [Min] Write the phone side: read the phyphox export, same filter and
      FFT, true rate per 30 s window.
- [ ] [Min] Write the sync step: find the three taps in both signals and
      shift the phone's time to match.
- [ ] [Min] Record §5.6 for 2 people (≈ 15 min each).
- [ ] [Min] Compare per 30 s window; `evaluate` reports the median error.
- [ ] [Min] Tune the settings and `c_min` against the phone; write down the
      final values.
- [ ] [Min] Record the 0.5 m and 1.5 m blocks; write the working zone into
      `docs/setup.md`.
- [ ] [Min] Gate: median error ≤ 2 per minute on 3 recordings.

### 3.4 Breathing stopped (`no_breathing`, Must)

- **Does:** alarm when a person who was breathing stops for ≥ 12 s.
- **How:** counts breaths (peaks in the breathing signal). If a still
  person who *was* breathing has no breath for 12 s, the alarm fires.
- **Needs data for:** how small a peak can be and still count as a breath,
  how fast the alarm comes, and how many false alarms happen.
- **What the phone gives here:** during a breath-hold the phone shows a
  flat line, so we know **exactly** when breathing stopped and started.
  That shows how small the Wi-Fi breathing signal gets during a hold, and
  how many seconds the alarm took.
- **Pass mark:** a hold of ≥ 15 s → alarm within 18 s.
- **Public data:** none. This is **the biggest safety gap**, and it is
  fully on us.

**To do**
- [ ] [Min] Build the rule and test it on a fake signal: a breathing wave
      that stops (Phase 3).
- [ ] [Min] Record 10 breath-holds per volunteer with the phone (§5.7).
- [ ] [Min] Tune the breath size threshold so every hold fires and normal
      breathing doesn't.
- [ ] [Min] Measure the delay from `breath_hold_start` to the alarm; gate:
      ≥ 15 s hold → alarm within 18 s.
- [ ] [Min] Count false alarms on the long runs.

### 3.5 Fall → fainted rule (Must)

- **Does:** stage 1 spots a hard burst of movement; stage 2 confirms
  ≥ 3 s of stillness after it; 20 s more of stillness →
  `fainted_suspected`.
- **Needs data for:** the burst threshold is set from the strongest
  *normal* movement (99.9th percentile of motion during walking and
  sit-downs). Then it is tested on falls and look-alikes, and false alarms
  are counted on long days.
- **Pass mark:** staged fall → phone in ≤ 5 s; fainted after 20 s still;
  **never** fainted for simply lying in bed without a fall.
- **Public data:** E1, E8, E2 to develop the features and see which
  look-alikes fool the rule.

**To do**
- [ ] [Min] Develop the rule on E1 / E8 / E2 falls (Phase 4).
- [ ] [Min] Set the burst threshold from our walking and sit-down blocks.
- [ ] [Min] Record 10–20 falls onto a mat and 10 of each look-alike (§5.5,
      blocks 6–7).
- [ ] [Min] Check every fall fires; write down which look-alikes fire too.
- [ ] [Min] Lie down in bed normally for 5 min; check it never says
      fainted.
- [ ] [Min] Count false alarms per day on the long runs.
- [ ] [Full] If there are too many false alarms, build T2 (§4.2).

### 3.6 Calibration and drift (Must / Should)

- **Does:** learns what the empty room looks like; notices when the room
  changes (moved furniture, open door) and re-learns when it is safe.
- **Needs data for:** how fast the empty room changes over hours and days,
  to set the drift detector.
- **Public data:** E4 spans 3 days; a rough idea only.

**To do**
- [ ] [Min] Calibration from the 2-min empty block (comes with §3.1).
- [ ] [Min] Keep the long runs going with a note of who was in the room.
- [ ] [Full] Measure how fast the empty room drifts; set the drift alarm
      (Phase 7).

### 3.7 Posture (Should)

- **Does:** keeps the current posture (standing / sitting / lying) by
  following T1's transitions.
- **Needs data:** none of its own. It is tested with the static blocks and
  the transitions already recorded.

**To do**
- [ ] [Min] Once T1 works, replay a session and check posture follows the
      transitions (Phase 6).

### 3.8 Bed exit (Should, Clinic only)

- **Does:** knows when someone is in bed and when they get out.
- **Needs data for:** two extra calibrations (bed empty, someone in bed,
  60 s each) and testing.
- **Note:** the link between ESP and router must cross the bed.
- **Public data:** none.

**To do**
- [ ] [Full] Record the bed block (§5.5, block 9).
- [ ] [Full] Check all 10 exits are detected (Phase 7).

### 3.9 Occupancy level (Could, School only)

- **Does:** empty / quiet / busy over 5 minutes.

**To do**
- [ ] [Full] Record one normal lesson and one empty classroom; set the two
      thresholds from them.

### 3.10 Long inactivity, restlessness, routine (Should / Could)

- **Does:** no movement for too long in daytime; restless nights; daily
  patterns.
- **Data:** days of normal history. For the demo, simulated history is
  allowed if it is clearly labelled as simulated.

**To do**
- [ ] [Full] Long-inactivity rule with a fixed time limit; test it on a
      long run.
- [ ] [Full] Restlessness and routine from several days of long runs, or a
      clearly labelled simulated history.

---

## 4. The three trained models

### 4.1 T1. Transition model (sit down, stand up, lie down, get up)

**What it does.** Every 0.5 s it looks at the last 3 s of signal and gives
a probability for each class: `sit_down`, `stand_up`, `lie_down`,
`get_up`, `walking`, `none`. When one class is clearly highest, a
transition event fires. Those events drive the posture display.

**Why it must be trained.** A threshold can say "something moved" but not
*which* movement. Sitting down and lying down are both one burst of
movement; only the shape over 3 s tells them apart. That shape has to be
learned from examples.

**How it learns "what is what".**
1. During recording, the operator presses `sit_down` when the person lands
   on the chair. The software moves the press to the strongest movement
   nearby (the onset).
2. The 3-second windows around that onset are cut out and labelled
   `sit_down`. One repetition gives 4–5 such windows. Windows with no
   transition are `none`, or `walking` during walking.
3. The model sees thousands of these labelled windows and learns which
   signal shapes go with which label.
4. Later, live, it gets a new window with no label and says which shape it
   looks most like.

**The model itself.** The input is the 3-second window of the 52 points
(150 time steps × 52), with each point's average removed. Two versions are
built and the better one wins:
1. a **gradient-boosting model** on hand-made features (how much each point
   varied, sharpest change, energy in slow / medium / fast bands …). Fast,
   works with little data;
2. a **small neural network** (1D CNN, ~43,000 weights) on the window
   itself.

Training adds "fake variety": small shifts in time, speed and level, added
noise, missing packets. That makes up for how few real repetitions we
record.

**Where the data comes from.**

| Source | Role |
|---|---|
| **E1** (22 people × ~15 reps, ESP32, same signal type) | The main one: build the pipeline, compare the two models, pretrain the CNN |
| E2, E7 | Extra stand-ups and rooms |
| **Our sessions** | Fine-tune to our setup and **test** (the only place final numbers come from) |

**Gap only we can fill:** almost no clean stand-ups in public data; no
data from our rooms, router and placement.

**How much of our data.**

| | Minimum track | Full track |
|---|---|---|
| Sessions | 3 short (~30 min): A1 train, A2 locked test (same room), B1 locked test (new room) | 4–6 full, ≥ 2 rooms, 1–2 locked |
| Reps of each transition | 10 per person per session | 20 per person per session |
| Walking | 3 min per session | 5 min per session |
| People | 2 | 2–3 |

With the Minimum track, the scores are honest but rough (few test events,
wide error bars). Say so in the report.

**How it's judged.** By *events*, not windows: was each real transition
found once, at the right time? The score is the average F1 over the
classes (macro-F1), reported **same room** and **new room**. Sessions are
split whole, never by window (neighbouring windows are near copies).

**To do**
- [ ] [Min] Prepare E1 ([dataset-preparation §7](dataset-preparation.md)).
- [ ] [Min] Dry run on E1: gradient boosting vs CNN, leave-one-person-out.
- [ ] [Min] Decide the locked test sessions **before** recording and write
      them into the split config.
- [ ] [Min] Record the transition sessions (§5.5, blocks 1–5 and 10).
- [ ] [Min] Run `check_session` and fix labels after each session.
- [ ] [Min] Train on E1 + our training sessions.
- [ ] [Min] Score on the locked sessions: same room and new room.
- [ ] [Min] Load the model in the engine; check posture follows it live.
- [ ] [Full] Record more sessions to reach 4–6 in total.
- [ ] [Full] `onsite_adapt`: re-tuning in a new room (§5.10), rehearsed once.

### 4.2 T2. Fall verifier (optional second opinion)

**What it does.** The fall rule (§3.5) fires on any sudden hard burst.
Some of these are not falls: sitting down hard, dropping a bag, flopping
onto a sofa. The verifier looks at the burst and says "real fall" or "not
a fall". It can only **cancel** a candidate, never create one, so the
system works without it.

**How it works.** Over the 3 s before the burst peak, five numbers are
computed (how much stronger the last second is, how much fast movement,
how long the burst is, the sharpest change, how "peaky" it is). A
gradient-boosting model learns from these five numbers. Every time the
fall rule fires on a recording, the five numbers form one example: **fall**
if a fall mark is near it, otherwise **not a fall**.

**Data.** The same falls and look-alikes as §3.5, plus the long runs.
Public: E1, E8 (falls vs squats, jumps), E2, E9 (testing only), E7
(bouncing ball as a dropped object).

**How it's judged.** Kept only if it **lowers false alarms per day** while
**not losing any real falls** on the locked test sessions.

**To do**
- [ ] [Full] Only if the fall rule alone gives too many false alarms.
- [ ] [Full] Develop on E1 + E8 (train on 3 rooms, test on the 4th).
- [ ] [Full] Train on our falls and look-alikes; check it on the locked
      sessions and the long runs.

### 4.3 T3. Count: 1 person vs 2 or more

**What it does.** While someone is present, it says "1 person" or
"several". With 2+ people, the breathing number is switched off, because
it would be a mix of both.

**Honest limit.** With one ESP, two people **sitting still** look almost
like one. It only really works **while people move**.

**Data.** 5 min of 2 people moving and 3 min of 2 people sitting still per
session, at least 4 sessions with different pairs. **Public data:** one
open candidate, WiCount (ESP32-S3, 52 LLTF subcarriers, ~100 Hz, labels
0–3, cited in [csi-people-counting.md](../research/csi-people-counting.md)),
not downloaded or checked yet. The other ESP32 counting datasets are paid
or on request.

**To do**
- [ ] [Full] Only if the School page is in the demo and T1 is done.
- [ ] [Full] Download WiCount and check its format and licence
      ([dataset-preparation](dataset-preparation.md) style: open the
      files, not just the page).
- [ ] [Full] Record the two-people block (§5.8) in every session.
- [ ] [Full] Train; check it beats guessing while people move.

---

## 5. Recording tutorial

### 5.0 What must exist first

Until these parts of the plan are built, work with the public datasets.
Status as of 2026-10-29:

| Needed | Plan step | Status |
|---|---|---|
| ESP firmware streaming the signal, laptop saving it to `.csirec` files | plan-v2 Phase 2 | **Done**: `firmware/tools/csi_recorder.py` (USB or Wi-Fi) |
| Measurement checklist done (rate ≥ 80 Hz, loss < 5 %, settings frozen) | [csi-for-models §8](csi-for-models.md) | **Not done.** On a weak link (RSSI around −70) the stream pauses for seconds; check the placement with `firmware/tools/link_check.py` until RSSI is better than −60 and there are 0 pauses |
| A way to press label buttons: the `label-cli` (Phase 3) or the labelling page (Phase 5) | plan-v2 Phases 3, 5 | **Labelling page done** (`/label` in the dashboard; writes `session.json` and `labels.jsonl`). It records through the engine's `record_start`, so real labelled sessions need the real engine on port 6000; today only the mock engine answers it. `label-cli` not built |
| `check_session` (checks labels and snaps marks) | plan-v2 Phase 5 | Not built |

**Do not change any ESP or router setting once recording has started.**
Data recorded with different settings can't simply be mixed.

### 5.1 Equipment

| Item | Why |
|---|---|
| ESP32 + our router, fixed channel, settings from csi-for-models §2 (today a classic ESP32; plan-v2 assumes an ESP32-S3, and the firmware builds for both) | the signal |
| Laptop running the recorder and label buttons | saving and labelling |
| Tape measure, masking tape, phone camera | mark and photograph the placement |
| **Thick mat** (gym or crash mat) | falls |
| Chair, sofa or bed | sit-downs, lie-downs, look-alikes |
| A bag with some weight in it | dropped-bag look-alike |
| Phone with **phyphox** (accelerometer), or a breathing belt | chest reference for breathing |
| Metronome app | paced breathing |
| Consent forms | before anyone is recorded |
| External drive | backup (~100 MB per hour of recording) |

People: **2–3 volunteers** who do the movements, and **one operator** who
presses the buttons. A volunteer can press them alone, but labels are
better with a separate operator.

### 5.2 Before the first session (once)

**To do**
- [ ] Consent form signed by everyone recorded; a guardian signs too for
      anyone under 18.
- [ ] Give everyone a code name (P01, P02, …). The list linking code names
      to real names stays **on paper**, never in files.
- [ ] Practise the safe fall technique on the mat: down to the knees, then
      roll onto the side. Nobody is pushed to do falls.
- [ ] Explain the breath-hold rules: volunteers only, sitting or lying, at
      most 30 s, stop at any discomfort, never alone.
- [ ] Pick at least 2 rooms. Decide which sessions are the locked test
      sessions (§5.11), including one from a room you won't train on.

### 5.3 Setting up in the room (every session)

**To do**
- [ ] Place router and ESP: 3–5 m apart, ~1 m high, with the line between
      them crossing where people will sit and lie (for a bed session, the
      line crosses the bed).
- [ ] Mark both positions with tape; measure distance and height.
- [ ] Run `firmware/tools/link_check.py` for 60 s: RSSI better than −60
      and 0 pauses. Otherwise move the board (closer, higher, clear line of
      sight) and run it again.
- [ ] Photograph the setup.
- [ ] Start the session on the labelling page. It writes
      `data/sessions/<id>/session.json` with session id, room, distance,
      height, code names present and notes, and adds the firmware and
      engine versions itself. Put the photo name, ESP settings, router
      model and channel in the notes.
- [ ] Check on the dashboard the rate is ≥ 80 per second.
- [ ] **Don't move anything** until the session ends.

### 5.4 How labelling works

There are two kinds of labels:

| Kind | When | How | Examples |
|---|---|---|---|
| **Mark** | an instant event | press the button **when it happens** | `sit_down`, `stand_up`, `lie_down`, `get_up`, `fall`, `bed_exit`, `breath_hold_start`, `breath_hold_end`, `hard_negative_sit`, `hard_negative_drop`, `hard_negative_liedown` |
| **Segment** | a state that lasts | press **start** and **stop** | `empty`, `standing`, `sitting`, `lying`, `walking`, `normal_activity`, `in_bed`, `bed_empty`, `paced_breathing_15`, `breath_hold` (with `count` for 2 people) |

These are the names the labelling page and the recordings API use
(`contracts/api.md`). Segments never overlap: starting one ends the open
one.

Tips for the operator:
- Press at the **moment of the movement** (the body landing on the chair),
  not when the person starts to move or when they're done.
- A slightly early or late press is fine: the software moves it to the
  strongest movement within ±1.5 s. Presses with no movement nearby are
  listed for review.
- Wrong press? Note the time and fix it right after the block.
- Call out each repetition ("three … go") so volunteer and operator stay
  in step.
- Optional: film with a visible clock, to check labels later. Only with
  consent; the video stays on the laptop.

### 5.5 The session script

Do the blocks in this order. Every person in the session does every block.
Minimum-track sessions only do the blocks marked **Min**, with 10 reps
instead of 20 (~30 min). A Full session does them all (60–75 min).

| # | Block | What to do | Time | Labels | Feeds | Track |
|---|---|---|---|---|---|---|
| 1 | **Empty room** | Everyone leaves the room. Close the door. Nobody in the doorway | 2 min | segment `empty` (+ run calibration) | presence, motion, calibration, drift | Min |
| 2 | **Static states** | Stand, sit, lie still at 2–3 spots. Breathe normally, don't fidget | 2–3 min each | segments `standing` / `sitting` / `lying` | presence, posture, breathing | Min (once per room) |
| 3 | **Sit down / stand up** | Sit down, wait 3–5 s, stand up, wait 3–5 s. Change chair, spot and speed every 5 reps | ~4–8 min | marks `sit_down`, `stand_up` | T1, fall-rule threshold | Min |
| 4 | **Lie down / get up** | From sitting on the sofa or bed, lie down, wait 3–5 s, sit up. Vary side and speed | ~4–8 min | marks `lie_down`, `get_up` | T1 | Min |
| 5 | **Walking** | Different paths, slow and fast, across the link and along it | 3–5 min | segment `walking` | T1, motion, fall-rule threshold | Min |
| 6 | **Falls** | Onto the mat, practised technique. Lie still ~10 s, then get up slowly. Vary direction. 10–20 falls | ~10 min | mark `fall` | fall rule, T2 | Min (once) |
| 7 | **Look-alikes** | 10 × sitting down hard; 10 × dropping the bag from chest height; 10 × flopping quickly onto the sofa or bed | ~10 min | marks `hard_negative_sit`, `hard_negative_drop`, `hard_negative_liedown` | fall rule, T2 | Min (once) |
| 8 | **Two people** | Both move around for 5 min; then both sit still for 3 min | 8 min | segments with `count: 2` | T3 | Full |
| 9 | **Bed** (Clinic only) | Bed empty 2 min; one person in bed 5 min; 10 times get out of bed and walk away | ~15 min | segments `bed_empty`, `in_bed`; mark `bed_exit` | bed exit | Full |
| 10 | **Empty room** | Everyone leaves again | 3 min | segment `empty` | drift within the session | Min |

Between blocks, a short break is fine. Keep the recorder running; just
don't label the break.

### 5.6 Breathing recordings with a chest reference

The goal is to have the **true** breathing next to the Wi-Fi signal (why:
§3.3).

**To do (setup)**
- [ ] Open phyphox, choose the accelerometer experiment, put the phone in a
      chest pocket or under a snug strap on the chest.
- [ ] Start the phone recording, then the Wi-Fi recording.
- [ ] **Sync taps:** tap the phone sharply three times against the chest.
- [ ] Repeat the three taps at the end, before stopping both recordings.

**Per person** (sitting still on the link line):

| Block | What | Time | Label |
|---|---|---|---|
| Paced 10 | Breathe with the metronome at 10 per minute | 1 min | `paced_breathing_10` |
| Paced 15 | 15 per minute | 1 min | `paced_breathing_15` |
| Paced 20 | 20 per minute | 1 min | `paced_breathing_20` |
| Paced, 2 more | repeat two of the rates | 2 min | as above |
| Natural, sitting | breathe normally | 5 min | `sitting` |
| Natural, lying | breathe normally | 5 min | `lying` |

≈ 15 min per person. Once (not per person): repeat a 2-min natural block
at 0.5 m and 1.5 m off the link line.

### 5.7 Breath-holds

**Safety first:** volunteers only, sitting or lying, at most 30 s, stop at
any discomfort, never alone.

**To do (per volunteer)**
- [ ] Phone running and synced as in §5.6.
- [ ] Breathe normally for at least 60 s (the system must see valid
      breathing first; that is how it knows the person didn't just leave).
- [ ] Breathe out, then hold. Operator presses `breath_hold_start`.
- [ ] Hold 15–30 s, completely still. Operator presses `breath_hold_end` at
      the first breath.
- [ ] Recover with normal breathing for 1–2 min.
- [ ] Repeat 10 times, mixing short (15 s) and longer (30 s) holds.

≈ 10–15 min per volunteer including recovery.

### 5.8 Two-people blocks (Full track)

Only if T3 is built. Use different pairs across sessions. Label every
segment with `count`. Record **both** moving and still blocks: the still
block shows honestly where counting fails.

### 5.9 Long normal days (no labels)

**To do**
- [ ] From Phase 2 on, leave the ESP recording overnight and during normal
      use of the room.
- [ ] Keep a simple paper or phone note: who was in the room, roughly when,
      and anything unusual (door open, furniture moved, fan on, pet).
- [ ] Keep raw files on the laptop **and** the backup drive, never in git
      (~1 GB per night).

Why so much? With zero false alarms in T hours, the honest claim is "at
most 3 / T per hour". Claiming **"fewer than 1 false alarm per day" needs
about 3 days** of recording.

### 5.10 New-room re-tuning (`onsite_adapt`, Full track)

Done when the system is set up in a room it was not trained in. About 12
minutes:

1. **Empty room**, 2 min (calibration).
2. **Guided recording**, ~5 min: the screen asks for 45 s each of
   sit-down, stand-up, lie-down and get-up repetitions, then 60 s of
   walking.
3. Only the model's last layer is re-trained (~1 min).
4. **Separate check run**, 2 min, with a second short guided sequence.
5. The new version is kept only if it scores no more than 0.05 worse than
   the old one on the check run.

The check run must be separate: testing on the same recording would
always say "better". It is a sanity check, not a measurement. Rehearse it
once in a room you've never used.

### 5.11 Locked test sessions

- Choose **1–2 sessions as the final test before any training**, including
  at least one from a room not used for training.
- Write them into the split config. The training script refuses them.
- Never look at them while tuning. Final numbers are reported **only** on
  these.
- Public datasets are **never** the test set.

### 5.12 After each session

**To do**
- [ ] Stop the recorder. Check the file size makes sense (~100 MB per
      hour).
- [ ] Run `check_session`: labels inside the recording, no overlapping
      segments, every mark snapped to a movement peak. Review the marks it
      lists.
- [ ] Fix labels while you still remember the session.
- [ ] Copy the session folder `data/sessions/<id>/` (`.csirec`,
      `session.json`, `labels.jsonl`) plus the photo and phone file to the
      backup drive.
- [ ] Add one line to `data/README.md`: session id, date, room, people
      (code names), blocks done, anything unusual. `data/` is gitignored,
      so this log is not in git: back it up with the sessions.

### 5.13 Suggested schedule

**Minimum track**

| When | What | Time |
|---|---|---|
| Phase 2 onward | Start long normal-day runs and keep them going | unattended |
| Evening 1, room A | Breathing (§5.6) + breath-holds (§5.7) for 2 people; static states | ~1.5 h |
| Evening 2, room A | Falls + look-alikes (blocks 6–7); session A1 (train) and A2 (locked test) | ~2 h |
| Evening 3, room B | Session B1 (locked test, new room) | ~45 min |

**Full track** (adds on top)

| When | What | Time |
|---|---|---|
| Evening 4, room B | Full session, with two-people block if T3 | ~1.5 h |
| Evening 5, room C (or B) | 1–2 more full sessions; bed block if Clinic | ~2 h |
| Any time | New-room re-tuning rehearsal | 15 min |

---

## 6. Master to-do, in build order

Everything from §3–§5 in one list, by plan-v2 phase. **R** = a recording
step.

**Now (public data, in parallel with the hardware work)**
- [ ] [Min] Prepare E1, E4, E8 (dataset-preparation §7).
- [ ] [Min] Dry runs on public data: transition model on E1, fall features
      on E1 + E8, presence on E4.
- [ ] [Min] Consent forms, code names, fall technique (§5.2).

**Phase 2: real signal**
- [x] [Min] Firmware streaming to `.csirec` (`firmware/tools/csi_recorder.py`).
- [ ] [Min] A placement with no pauses (`link_check.py`); measurement
      checklist done; settings frozen.
- [ ] [Min] **R:** start long normal-day runs with a note (§5.9).

**Phase 3: presence, motion, breathing**
- [ ] [Min] Presence and motion code, developed on public data.
- [x] [Min] Breathing estimator (`engine/lifefi/breathing.py`); still to
      run on screened E1 files.
- [ ] [Min] `label-cli` for button presses (fallback; the labelling page
      exists).
- [ ] [Min] Phone side of breathing: phyphox export reader, filter + FFT,
      tap sync.
- [ ] [Min] **R:** empty room, static states, breathing with the phone,
      breath-holds (Evening 1).
- [ ] [Min] Tune breathing and `no_breathing` against the phone.
- [ ] [Min] Gates: breathing ≤ 2 per minute median error; still person
      stays PRESENT 10 min; EMPTY within 90 s; hold ≥ 15 s → alarm within
      18 s.

**Phase 4: fall rule and alerts**
- [ ] [Min] Fall → fainted rule; threshold from walking and sit-downs.
- [ ] [Min] **R:** falls + look-alikes (Evening 2).
- [ ] [Min] Gates: staged fall → phone in ≤ 5 s; fainted after 20 s;
      never fainted for lying in bed.

**Phase 5: labelling pipeline**
- [x] [Min] Labelling page (needs the real engine to record real
      sessions).
- [ ] [Min] `check_session`.
- [ ] [Min] Lock the test sessions in the split config.
- [ ] [Min] **R:** sessions A1, A2 (Evening 2) and B1 (Evening 3).

**Phase 6: models**
- [ ] [Min] T1: train on E1 + A1; score on A2 (same room) and B1 (new
      room).
- [ ] [Min] T1 in the engine; posture follows it live.
- [ ] [Full] More sessions (Evenings 4–5); retrain T1.
- [ ] [Full] T2, only if the fall rule has too many false alarms.
- [ ] [Full] T3, only if the School page is in the demo.

**Phase 7: extras and final numbers**
- [ ] [Min] False alarms per day from ≥ 3 days of long runs.
- [ ] [Full] Drift alarm, bed exit, occupancy, routine.
- [ ] [Full] `onsite_adapt` rehearsal in a new room.
- [ ] [Min] Report all final numbers from the locked sessions and long runs
      only.

---

## 7. Total data budget

| Data | Minimum track | Full track | Feeds |
|---|---|---|---|
| Labelled sessions | 3 × ~30 min + one falls block, 2 rooms | 4–6 × 60–75 min, ≥ 2 rooms | T1, T2, T3, presence, fall rule, bed exit |
| Breathing with phone | ~15 min × 2 people | ~15 min × 2–3 people | breathing rate |
| Breath-holds | 10–15 min × 2 volunteers | same | breathing stopped |
| Long normal days | **≥ 3 days** in total | same | false alarms, drift, routine |
| New-room rehearsal | — | ~12 min per room | re-tuning |
| Public datasets (already downloaded) | ~30 h usable | same | development and pretraining only |

---

## 8. Common mistakes

| Mistake | Why it hurts | Instead |
|---|---|---|
| Thinking public data replaces our recordings | Different hardware and rooms; can't prove anything about our setup | Public data to build, our recordings to tune and prove |
| Moving the ESP or router mid-session | Everything after looks like a different room | Tape the positions; restart the session if moved |
| Changing ESP / router settings between sessions | Data stops being comparable | Freeze settings after the measurement checklist |
| Only one person doing everything | The model learns that body | Every person does every block |
| Same chair, same speed every time | The model learns that chair | Change spot, furniture and speed every 5 reps |
| Splitting train / test by window | Neighbouring windows are copies; scores look great and mean nothing | Split by whole session |
| Testing on public data | Not our result | Report only on locked sessions |
| Breathing without the phone on the chest | No way to know if the number is right | Always a phone or belt, synced by taps |
| Forgetting the sync taps | Phone and Wi-Fi can't be lined up | Three taps at the start and at the end |
| Skipping the empty blocks | No calibration, no drift baseline | 2 min at start, 3 min at end, always |
| Starting long runs late | "< 1 false alarm per day" needs days | Start in Phase 2 and keep them running |
| Labelling from memory the next day | Silent label errors | Fix labels right after each block |
