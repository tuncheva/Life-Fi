# Training Data Sources

This document lists public datasets that Life-Fi can use as learning data:
pretraining, warm-starting, architecture comparison, evaluation and
threshold tuning. It checks and extends the short lists in
[plan-audit §B.5](../archive/plan-audit-and-model-research.md) and
[csi-sufficiency §3.2](csi-sufficiency-research.md), and maps each dataset
to the detectors and models of [plan-v2 §6](../plan/plan-v2.md) and the recordings
of [plan-v2 §10](../plan/plan-v2.md) / [csi-for-models §7, §12](../plan/csi-for-models.md).

**Our setup, for comparison:** one ESP32-S3, one antenna, pinging our own
router at ~88–100 Hz, LLTF amplitude only (52 subcarriers, k = ±1…±26,
HT20, 2.4 GHz), converted to dB, resampled to 50 Hz, 3 s windows.

**Fit rating:**

| Fit | Meaning |
|---|---|
| **High** | ESP32 raw CSI with LLTF (or a 64-subcarrier HT20 buffer we can cut to LLTF), ≥ 50 Hz, timestamps |
| **Medium** | ESP32 but a different configuration, rate or amplitude-only export; or other hardware with subcarriers we can map |
| **Low** | Other hardware (Intel 5300, Atheros, Nexmon, 802.11ax, MIMO). Architecture comparison only |

**Tags:**

| Tag | Meaning |
|---|---|
| **[V]** | Checked on the primary source in this research: the repo, the Zenodo / Mendeley / IEEE DataPort / Hugging Face page, the data files themselves or the paper |
| **[I]** | Our inference from the sources |
| **[unverified]** | Seen only in a search snippet or secondary page; confirm before relying on it |

**Bottom line.** No public dataset replaces our own recordings. Three ESP32
datasets come close enough to be worth converting now:
**Embedded_WiFi_Sensing** (fall, get up, lie down, sit down, walk, plus
paced breathing; ESP32, LLTF, 50 Hz, 22 subjects), **WiFall** (ESP32-S3,
52 subcarriers, ~100 Hz, fall / sit / stand / walk / jump) and
**ESPectre's dataset** (empty / still person / motion, five ESP32 chips,
four rooms). Nothing public covers **breath-holds with a reference sensor on
ESP32 that is openly downloadable**, **bed exit**, or **1 vs 2+ people on a
single ESP32 link**. Those stay on the self-recording plan.

---

## Contents

1. Summary table
2. Per-model sources and gaps
3. Converting a dataset to our `F` format
4. References

---

## 1. Summary table

Abbreviations: Pres = presence (incl. still person), Mot = motion,
BR = breathing rate, Apn = breathing cessation, Fall = fall rule and
verifier, Tr = transition model (`sit_down`, `stand_up`, `lie_down`,
`get_up`, walking), Bed = bed exit, Cnt = count 1 vs 2+. "sc" = subcarriers.

### 1.1 ESP32 datasets

| # | Dataset | Hardware / config | Data | Labels | Size | Access, license | Feeds | Fit |
|---|---|---|---|---|---|---|---|---|
| E1 | **Embedded_WiFi_Sensing** (Armenta-Garcia 2025) [D1, P1] | ESP32-DevKitC-VIE (ESP32-D0WD-V3) Tx and Rx, 1 antenna, HT20 2.4 GHz, UDP at **50 pkt/s** [V]. Files have 128 int8 values per row = 64 sc **LLTF layout** (null band visible), `[imag, real]` pairs [V, from the files] | raw complex, timestamp per packet | **Fall, Get Up, Lie Down, Sit Down, Walk**; 15 reps × 20 s each [V]. Breathing: paced **10 / 15 / 20 BPM**, 3 min per file [V] | 22 subjects, 1,647 activity files (~9 h) + 66 breathing files (~3.3 h); one computer lab with other Wi-Fi around [V] | Open on GitHub; repo MIT, paper data CC BY 4.0 [V] | Tr, Fall, BR, Mot | **High** |
| E2 | **WiFall** (Zhao et al., KNN-MMD, IEEE TMC) [D2, P2] | ESP32-S3, 1 antenna, 2.4 GHz HT20, 802.11n, **~100 Hz** [V] | raw complex, 104 values = 52 sc; RSSI, timestamp [V] | fall, jump, sit, stand, walk; 60 s samples [V]. Whether "sit"/"stand" are transitions or static [unverified] | 10 participants, one meeting room, 233 k rows [V] | Open on Hugging Face; license not stated [V] | Fall, Tr, Mot | **High** |
| E3 | **ESPectre dataset** [D3] | ESP32, S3, C3, C5, C6; HT20, 64 sc; nominal 100 pkt/s, measured ~102–121 [V] | raw CSI in `.npz` per recording [V] | `empty`, `static_presence`, `motion` [V] | 87 recordings, ~3.9 h (empty 0.97 h, still 1.95 h, motion 0.97 h); bedroom, living room, hobby room, vacation home [V] | Open in repo; repo license GPL-3.0, no separate data license [V] | Pres, Mot, drift checks | **High** |
| E4 | **3DO** (Strohmayer, WiFlexFormer) [D4, P3] | ESP32-S3-DevKitC-1U + ALFA APA-M25 directional antenna, **100 Hz**, through-wall [V] | raw complex (`csiposreg_complex.npy`) + CSV [V] | per packet: empty, walking, sitting, lying + 3D position [V] | 42 × 5 min (~3.5 h, ~1.25 M packets), 1 person, 3 days [V] | Zenodo, CC BY 4.0 [V] | Pres, Mot, static postures, drift (3 days) | **High** (antenna differs) |
| E5 | **Wallhack1.8k** (Strohmayer) [D5, P4] | ESP32 variant with biquad or PIFA antenna, **100 Hz**, LLTF (52) + HT-LTF (56) [V] | raw complex `[I, R, …]` CSV + amplitude spectrograms [V] | no presence, walking, walking + arm-waving [V] | 1,806 samples × ~4 s, LoS and through-wall, 5 rooms [V] | Zenodo, CC BY 4.0 [V] | Pres, Mot | **High** |
| E6 | **OpenCSI LCN 2026** [D6, P5] | ESP32-S3, C3, C6; 3 rooms, 4 board batches [V] | raw CSI + per-trial calibration state [V] | binary occupancy [V] | 4 × 12 min sessions, 724 MB [V] | Zenodo, CC BY 4.0 [V] | Pres, calibration / cross-chip tests | **High** for presence; rate [unverified] |
| E7 | **ESP32 LOS/NLOS HAR** (Data in Brief 2024) [D7] | ESP32 Rx, D-Link AX3000 Tx; "52 CSI subcarriers" via ESP-CSI tool [V] | CSV; raw vs amplitude, rate [unverified] | 10 activities; "sitting down on chair", "standing" appear [unverified]; full list not seen | 8 volunteers × 20 trials × 10 activities × 3 setups (4,800 trials) [V] | Mendeley, CC BY 4.0 [V] | Tr (if the list holds), Mot | **Medium** |
| E8 | **ESP-Fi HAR** [D8] | ESP32 modules, 52 sc [V] | **amplitude only**, 1 × 950 × 52 per sample, `.mat` [V]; rate [unverified] | run, **fall**, walk, turn, jump, squat, arm wave [V] | 8 people, 4 rooms (corridor, office, meeting room, lab), 2,240 samples [V] | GitHub (.rar), CC BY 4.0 [V] | Fall (falls vs squat/jump), architecture | **Medium** |
| E9 | **CSI-Bench**, ESP32-S3 part [D9, P6] | Mostly NXP 88W8997; a smaller ESP32-S3 1×1, 2.4 GHz part in Fall Detection [V]; 100 Hz (30 Hz for breathing) [V] | **amplitude only**, 5 s samples, sc zero-padded or clipped [V] | Fall: 2,770 falls vs 3,930 non-falls (walking, sitting, lying down) [V]. Breathing: sleep breathing vs empty vs fan, no ESP32 [V] | 461 h total, 35 users, 26 rooms; Fall 17 users, 6 rooms [V] | Kaggle (account), **CC BY-NC-ND 4.0** [V] | Fall + hard negatives, Pres (fan), Low for breathing | **Medium** (ESP32 slice) / Low (rest) |
| E10 | **RF_ESP32_Dataset** [D10] | ESP32 Rx (1 antenna), TP-Link Tx, HT20, 64 sc [V] | raw complex + AGC + FFT `.npy` per session, `events.csv` [V] | human activity (71 sessions), metal objects, environments; activity label list [unverified] | 192 sessions, 13.8 MB total [V] | Zenodo + GitHub, CC BY 4.0 [V] | AGC handling tests, Mot | **Medium** (tiny) |
| E11 | **Neulog respiration, older adults in care** (IEEE DataPort) [D11] | ESP32 via ESP32-CSI-Tool, **120 pkt/s**, 3 × 3 m room [V] | CSV + notebooks [V] | 12–28 BPM validity set; 30 repeats at 14 BPM [V]. **Reference: Neulog NUL-236 belt, 100 Hz** [V] | 64.8 MB [V] | **DataPort subscription**; license not stated [V] | BR (with reference) | **High** signal fit, **access-limited** |
| E12 | **Wi-Fi CSI sleep disturbances, older people** (IEEE DataPort) [D12] | ESP32-DevKitC-VE, PCB antenna, 2.4 GHz, 120 pkt/s [V] | raw CSI, CSV/TXT [V] | **central and obstructive apnea**, posture shifts, leg restlessness, arousals, rest vitals [V]. Neulog belt + heart-rate logger (50 Hz), action sheets [V] | 10.8 MB, Living Lab [V] | **DataPort subscription** [V] | Apn, BR, restlessness | **High** signal fit, **access-limited** |
| E13 | **WiFiVision counting** [D13] | ESP32 (CP2102 boards), Tx-Rx 11 m apart [V] | CSI + camera; sc, rate [unverified] | 0…7+ people, 1,200 samples per class [V] | 9,600 samples, one 5 × 4 m lab [V] | **On request**, academic only [V] | Cnt | **Medium** |
| E14 | **Multi-human HAR, ESP32-NodeMCU** (IEEE DataPort) [D14] | ESP32-NodeMCU + ESP32-CSI-Toolkit [V] | 271 MB zip; rate, sc [unverified] | 6 activities, 1-, 2- and 3-person setups [V] | 80+ participants [V] | **DataPort subscription** [V] | Cnt, Mot | **Medium** |
| E15 | **SG_106B07** (ESP32-S3 fall project) [D15] | ESP32-S3, **HT40**, 100 Hz sent, ~60–65 Hz logged [V] | 37 raw CSV + processed `.npy` [V] | fall vs walking / sitting; only 5 real fall recordings, the rest synthetic [V] | 37 recordings, 889 windows [V] | GitHub, MIT badge [V] | Fall (sanity check only) | **Low** |
| E16 | **BUET presence/motion** [D16] | 3 × ESP32-S3 (1 Tx, 2 Rx), ch 6 HT20, ~50 pkt/s [V] | **amplitude only**, 107 sc (51 LLTF + 56 HT-LTF) [V] | EMPTY / STATIC / MOVING [V] | 39 sessions, 227,505 packets, 3 subjects, 1 room [V] | "**not released under an open-source license**" [V] | Pres, Mot | **Medium** signal fit; ask before use |
| E17 | **HALOC** (Strohmayer) [D17] | ESP32-S3-DevKitC-1, directional antenna [V] | CSI CSV + 3D position [V] | position only [V] | 6 sequences [V] | Zenodo, CC BY 4.0 [V] | Pres (occupied segments) only | **Low** for us |

Not released, so not usable: the **PulseFi** ESP32 set (2 × ESP32, 80 Hz,
64 sc, 7 people, pulse-oximeter reference; no download link in the paper)
[P7]; the **Wi-CaL** ESP32 crowd-counting data [P8] (no public download
found [unverified]); and **kisum-fall-detection** (ESP32-C6). Kisum ships
recording scripts but no CSV data [V]. Its README is still worth reading:
it reports that single-antenna CSI could not tell a fall from lying down
on purpose [V] [D18]. That backs plan-v2's "spike, then stillness"
design and the hard negatives.

### 1.2 Non-ESP32 datasets (Low fit; architecture, ideas, sanity checks)

| # | Dataset | Hardware | Labels relevant to us | Size, access | Use |
|---|---|---|---|---|---|
| N1 | **UT-HAR** [D19] | Intel 5300, 3 antennas × 30 sc [V] | lie down, **fall**, walk, pick up, run, **sit down, stand up** [V] | 3,977 / 996 windows; GitHub (via SenseFi) [V] | Tr / Fall architecture comparison |
| N2 | **NTU-Fi HAR / HumanID** (SenseFi) [D19] | Atheros, 3 × 114 sc [V] | box, circle, clean, **fall**, run, walk [V] | 936 / 264; Google Drive, MIT [V] | architecture |
| N3 | **MM-Fi** [D20] | TP-Link N750, Atheros CSI Tool, 5 GHz, 114 sc [V] | 27 actions (14 daily, 13 rehab) [V] | 40 subjects, 4 rooms, 320 k frames [V] | architecture, pretraining ideas |
| N4 | **Widar3.0** [D19] | Intel 5300 [V] | 22 gestures (BVP features) [V] | 43 k samples [V] | not relevant to our labels |
| N5 | **SignFi** [D21] | Intel 5300, 3 × 30 sc, 5 GHz, 5 ms spacing [V] | 276 sign gestures [V] | 8,280 instances, 5 users [V] | not relevant to our labels |
| N6 | **OPERAnet** [D22] | Intel 5300, 3 × 3, 5 GHz, 30 sc, **1,600 Hz**; plus UWB, passive radar, Kinect [V] | walk, sit, stand from chair, **lie down, stand up from floor**, body rotate, background; **crowd counting up to 6 walking people** [V] | ~8 h, 6 subjects, 2 rooms; figshare [V] | Tr architecture; Cnt ideas |
| N7 | **Alsaify LOS/NLOS HAR** [D23] | Intel 5300, 1 Tx × 3 Rx, 2.4 GHz ch 3, 320 pkt/s [V] | 12 activities incl. sitting, standing, walking, **falling**, lying down, standing up, pick-up [V] | 30 subjects × 5 experiments × 20 trials, 3 rooms; Mendeley CC BY 4.0 [V] | Tr / Fall architecture; cross-room tests |
| N8 | **WiMANS** [D24] | Intel 5300, 3 antennas, 30 sc, 2.4 + 5 GHz, 1,000 Hz [V] | **0–5 simultaneous users**; nothing, walking, lying down, sitting down, standing up, … [V] | 11,286 × 3 s, 3 rooms; CC BY-NC-SA 4.0 [V] | Cnt architecture (1 vs 2+) |
| N9 | **EHUNAM** [D25] | Broadcom (Nexmon) and Atheros, 20 / 80 MHz [V] | people counting **up to 8**, HAR, machine activity [V] | ~38 h, 21 people, 8 rooms, 72 GB figshare [V] | Cnt; non-human motion negatives |
| N10 | **WiFi crowd counting (RadioPoints)** [D26] | Intel 5300 [V] | 0–7 people, 3 rooms [V] | GitHub, GPL-3.0, non-commercial [V] | Cnt |
| N11 | **FallDeFi** [D27] | Intel 5300 (thesis) [I] | falls + daily activities, 6 rooms [V via search; repo shows only a data link] | GitHub, MIT [V] | Fall features (STFT), cross-room |
| N12 | **FallDeWideo** [D28] | 3 receivers + camera; hardware [unverified] | falls; only processed data (pickles), no raw [V] | Baidu / Mega [V] | Fall, weak |
| N13 | **eHealth CSI** [P9] | Raspberry Pi + Nexmon, 2.4 GHz, 3 × 2, 30 sc [unverified sc] | clap, walk, wave, jump, **sit, fall**; 17 positions incl. breath-holds (20 s normal / 10 s hold) [V via PulseFi paper] | 118 participants; **on request, signed data use agreement** [V] | Apn ideas, Fall |
| N14 | **HKU lab_wifi_sensing** [D29] | hardware [unverified], multiple links [V] | controlled and varied breathing, **1 and 2 people**, **PLUX respiration belt** reference [V] | OneDrive download [V] | BR algorithm checks with a real reference |
| N15 | **CSI-Bench** (non-ESP32 part) [D9] | Echo, Nest, HomePod, Qualcomm, NXP … [V] | breathing vs empty vs **fan**; motion source: human / pet / robot vacuum / fan [V] | Kaggle, CC BY-NC-ND [V] | Pres false-alarm ideas (fans, pets) |

Not usable: the **Intel Wi-Fi CSI Respiratory** set on Zenodo (Intel AX,
52 sc, 100 Hz, 200 h). The Zenodo record is open but the data are
"private to Intel Corporation and authorized MultiX consortium partners"
[V] [D30]. **VitalCSI** (Raspberry Pi, nasal cannula reference) is
available on request only [V] [P10].

---

## 2. Per-model sources and gaps

### 2.1 Presence, including a still person (6.1)

- **Best sources:**
  - E3 ESPectre: `empty` / `static_presence` / `motion` on five ESP32
    chips in four rooms, about 2 h of still presence;
  - E4 3DO: empty, plus sitting and lying through a wall, over three days;
  - E6 OpenCSI: occupancy on S3 / C3 / C6 in three rooms;
  - E5 Wallhack1.8k: empty vs walking.
- **Use:**
  - check that `S` and `B` separate empty from still on rooms that are not
    ours;
  - set rough starting multipliers for `T_on = k × P99_empty` [I];
  - test the drift detector on 3DO's three days.
- **They lack:**
  - our calibration protocol: 2 min of empty room at the start, in the
    same session;
  - enter and leave events;
  - long empty-but-drifting runs;
  - fans and curtains. CSI-Bench's fan class is not ESP32.
- **Still self-record:** empty / still / moving in ≥ 2 rooms, enter and
  leave, overnight runs (plan-v2 §10.1, §10.3).

### 2.2 Motion (6.2)

- **Best sources:** any of E1–E5. Motion needs no labels; these sets serve
  as a check that `M` ranks walking > arm-waving > still > empty.
- **They lack:** our `gain_comp`. Most sets store no AGC or FFT gain.
  E10 is the exception: it stores AGC and FFT arrays, so it is the one
  public set for testing the gain-step handling [V].
- **Still self-record:** nothing extra.

### 2.3 Breathing rate (6.3)

- **Best sources:**
  - E1 Embedded_WiFi_Sensing breathing: 22 subjects × 10 / 15 / 20 BPM ×
    3 min, ESP32 at 50 Hz, LLTF. The label is the **paced target rate**;
    no reference sensor is documented, and the authors say the data "have
    not been used nor tested" [V].
  - E11 Neulog, older adults: ESP32 at 120 Hz with a **respiration belt at
    100 Hz**. The best ground truth, but behind a DataPort subscription [V].
  - N14 HKU: belt reference, includes 2-person cases. Hardware
    [unverified].
- **Use:**
  - E1 to tune `c_min`, the top-8 subcarrier selection and the 2 bpm
    autocorrelation agreement over 66 recordings from people who are not
    ours;
  - E11, if the school has DataPort access, for an error-vs-reference
    figure.
- **They lack:** a still-vs-shifting person, lying in bed, and fast rates
  (> 20 BPM in E1; E11 reaches 28).
- **Still self-record:** paced and natural breathing with our **chest
  reference** (phyphox in a chest pocket or a belt), as planned in
  plan-v2 §10.2. Paced-only labels cannot measure accuracy against true
  breathing.

### 2.4 Breathing cessation, `no_breathing` (6.4)

- **Best sources:**
  - E12 sleep disturbances: ESP32, **central and obstructive apnea** with
    a belt reference [V]. The only ESP32 apnea data found, and it is
    subscription-only.
  - eHealth CSI (N13): 10 s breath-holds inside 17 positions [V]. Nexmon,
    and available on request only.
- **They lack:** an openly downloadable ESP32 breath-hold set. Nothing in
  this search fills that.
- **Still self-record:** all of plan-v2 §10.2's breath-holds
  (10 × 15–30 s per volunteer, chest reference). This is the largest gap
  and the one most important for safety. Long unlabelled runs for FA/h
  also have no substitute.

### 2.5 Fall → fainted, with hard negatives (6.5)

- **Best sources:**
  - E1: Fall vs Lie Down vs Sit Down, 22 subjects. **Lie Down is the
    natural hard negative** [V].
  - E2 WiFall: fall vs sit / stand / jump / walk at ~100 Hz on an
    ESP32-S3 [V].
  - E9 CSI-Bench Fall: 3,930 non-falls incl. sitting and lying down, part
    of it ESP32-S3. Amplitude only, CC BY-NC-ND [V].
  - E8 ESP-Fi HAR: fall vs squat / jump in four rooms (amplitude) [V].
- **Use:**
  - first estimate of `T_fall` (P99.9 of walking / sitting motion);
  - first check of the stage-1 features (variance ratio, 2–20 Hz share,
    burst length, kurtosis) and of the GBM verifier;
  - leave-one-dataset-out tests of the verifier.
- **They lack:**
  - "sitting down **hard**";
  - **dropped objects** (no dataset found with this label);
  - quick lie-down on a sofa;
  - the 3 s+ stillness after the fall, which stage 2 needs. E1 has 20 s
    clips, which is enough to check this; WiFall has 60 s clips, which is
    better [I].
  - Falls in all of them are staged by young adults [I].
- **Still self-record:** falls onto a mat and all three hard-negative kinds
  (plan-v2 §10.1). Also hours of normal life for FA/h.

### 2.6 Posture transitions (6.7–6.8)

- **Best sources:**
  - **E1 is the closest public match to our label set:** Get Up, Lie Down,
    Sit Down, Walk (plus Fall), ESP32, LLTF, 50 Hz, 22 people,
    15 reps each [V]. It has no `stand_up`.
  - E2 WiFall "sit" / "stand" (transition vs static [unverified]).
  - E7 ESP32 LOS/NLOS, if its activity list holds [unverified].
  - Low fit, for architecture comparison only: UT-HAR (sit down, stand up,
    lie down), OPERAnet (stand from chair, lie down, stand up from floor),
    Alsaify LOS/NLOS, WiMANS.
- **Use:**
  - pretrain or warm-start the CNN on E1 + E2, then fine-tune on ours and
    adapt on site with AdaBN plus the head;
  - GBM vs CNN comparison on E1 with leave-one-subject-out, as a dry run
    of plan-v2 §6.8 before our data exists.
- **They lack:**
  - **onset marks.** E1 labels whole 20 s clips. Use our N15 snapping
    (motion-energy peak) to find the onset, then apply the 70 % window
    rule [I];
  - `stand_up` as its own class in E1;
  - more than one room in E1;
  - our router geometry.
- **Still self-record:** all four transitions × 20 reps per session, as
  planned. With E1 as pretraining, the 4-session minimum is unchanged,
  because the room shift dominates [I, L22/L29 in csi-sufficiency].

### 2.7 Bed exit (6.9)

- **Sources:** none found. E12 has posture shifts in bed but no bed exit
  label [V]. 3DO has a "lying" class.
- **Still self-record:** everything (`bed_empty`, `in_bed`, 10 exits).

### 2.8 Count 1 vs 2+ (6.9)

- **Best ESP32 sources:**
  - E13 WiFiVision (0–7+, on request);
  - E14 multi-human ESP32-NodeMCU (1–3 people, subscription).
  - Neither is openly downloadable.
- **Low-fit, open:** WiMANS (0–5), EHUNAM (≤ 8), OPERAnet (≤ 6 walking),
  RadioPoints (0–7).
- **They lack:** still people. Our 1 vs 2+ must also cover 2 people
  sitting still, which no counting set labels.
- **Still self-record:** 5 min of 2 people moving + 3 min still per session.

### 2.9 Summary

| Model | Best public start | Open? | Must self-record |
|---|---|---|---|
| Presence | E3, E4, E6 | yes | calibration-protocol sessions, enter/leave, overnight |
| Motion | E1–E5 (E10 for AGC) | yes | — |
| Breathing rate | E1 (paced), E11 (belt) | E1 yes, E11 paid | reference-sensor sessions |
| `no_breathing` | E12 (apnea, belt) | paid | **all breath-holds** |
| Fall + hard negatives | E1, E2, E9, E8 | yes (E9 NC-ND) | hard sit, dropped objects, sofa lie-down, FA/h |
| Transitions | **E1**, E2 | yes | all four, our rooms, onset marks |
| Bed exit | — | — | **everything** |
| Count 1 vs 2+ | E13, E14 | request / paid | everything with still pairs |

---

## 3. Converting a dataset to our `F` format

The goal is to run the **same** `lifefi.dsp` chain ([csi-for-models §4](../plan/csi-for-models.md))
on foreign data, so a model never sees a different preprocessing.
Write a small reader per dataset that emits synthetic `.csirec`-like
records (timestamp, 52 LLTF amplitudes, flags), then reuse steps 4–8.

### 3.1 Steps

1. **Pick the LTF block.**
   - ESP32 rows with 128 values are one 64-sc LTF block (E1 [V], E3 [I]).
   - Rows with 256 values (or 384 with STBC) are LLTF followed by HT-LTF;
     keep the first 128.
   - Wallhack's 52 + 56 split [V] means the extractor already dropped the
     nulls. Use its LLTF part only.
2. **Map subcarriers.** In a 64-pair block, pair `j` holds `[imag, real]`;
   `k = j` for j = 0…31 and `k = j − 64` for j = 32…63. Keep
   k = −26…−1, +1…+26 in that order ([csi-for-models §3.2](../plan/csi-for-models.md)).
   - In E1 files, columns after the timestamp follow exactly this layout:
     j = 27…37 are zero [V].
   - For 52-value exports (E2's 104 numbers, E7, E8), first confirm the
     order. Plot the mean amplitude and check that the band edges and the
     DC dip sit where expected [I].
   - Apply the `first_word_invalid` repair (copy k = +2 into k = +1) when
     unsure.
3. **Amplitude and dB:** `a = max(1, sqrt(re² + im²))`, `L = 20·log10(a)`.
   - Amplitude-only sets (E8, E9, E16): take the logarithm of the stored
     amplitude.
   - There is no `gain_comp` for any public set except E10. Skip step 3 of
     the chain and rely on dB plus per-window mean removal to cancel
     constant gain [I].
   - Inside a clip, an uncompensated AGC step stays visible as a step. Flag
     clips with steps larger than ~3 dB across all subcarriers at once and
     drop them from fall training [H].
4. **Time base.** Use the per-packet timestamps (E1: ms, ~20 ms spacing
   [V]; E3: rates 102–121 Hz [V]). Run the Hampel filter, then step 7
   (linear to 100 Hz → 20 Hz low-pass → every 2nd sample) and the gap
   policy, unchanged.
   - E1 is already at 50 Hz. Resampling to 50 Hz only fixes jitter; there
     is **no content above 25 Hz**.
   - 100–120 Hz sets match our ~88–100 Hz well.
5. **Windows.** 3 s = 150 samples. Model view `x` = per-window,
   per-subcarrier mean removal, which also removes the board-to-board
   offset.
6. **Labels.** Map dataset classes to ours, e.g.:
   - E1: SD → `sit_down`, LD → `lie_down`, GU → `get_up`, WA → walking,
     FA → fall (not a transition class: use it for the verifier and as
     `none` for the transition model);
   - E3: `empty` / `static_presence` / `motion` → presence and motion
     checks.

   For clip-level labels, find the onset with the motion-energy peak and
   apply the plan-v2 §6.8 window rule.
7. **Splits.** Split by subject or recording, never by window. E1 gives
   subject IDs in folder names (`s1`…`s24`) [V].
8. **Version tag.** Store the dataset name, the reader version and
   `PIPELINE_VERSION` with every converted file, as for our own
   recordings.

### 3.2 Non-ESP32 data (Low fit)

- Intel 5300 reports 30 grouped subcarriers per antenna pair. Atheros and
  Nexmon report 56–256.
- To feed our CNN shape, take **one** antenna pair and interpolate
  amplitude to 52 points across the band [I]. This keeps tensor shapes but
  not the physics: different bandwidth, band (often 5 GHz), and rates of
  320–1,600 Hz.
- Use these sets only to compare architectures (GBM vs CNN vs a small
  transformer) and training recipes. Do not mix them into training data
  [I].

### 3.3 Caveats

- **Rate mismatch hurts.** Training and testing at different rates cost a
  lot in a 2026 study (93.6 % → 55.1 %) [L22 in csi-sufficiency]. Resample
  everything onto the 50 Hz grid, and treat E1 (native 50 Hz) and the
  ~100 Hz sets as different domains in experiments [I].
- **Configuration differences:**
  - antenna (3DO and Wallhack use directional antennas);
  - Tx device (an ESP32 peer in E1 vs a router for us);
  - HT40 (E15);
  - `channel_filter` / `ltf_merge` settings, which are not always recorded.

  Any of these can change the amplitude shape across subcarriers [I].
- **Licenses:**
  - CSI-Bench is **NC-ND**: fine for internal training and evaluation,
    but do not redistribute converted copies [I];
  - ESPectre data sits in a GPL-3.0 repo;
  - WiFall states no license, so ask the authors before redistributing;
  - BUET (E16) is explicitly not open-licensed.
- **Possible artefacts in E1:** the value pair `13, 10` (ASCII CR LF)
  shows up unusually often in rows [I, from inspecting one file]. It may
  be a serial-framing artefact. Check its frequency per file before
  training, and treat affected subcarriers as outliers (Hampel).
- **Staged data:** every dataset here is scripted. None has real falls,
  older adults falling, or uncontrolled daily life (CSI-Bench is the
  closest). Public results do not predict FA/h at home.
- **Do not report public-data accuracy as Life-Fi accuracy.** Use public
  sets for pretraining, dry runs and sanity checks. Report final numbers
  only on our locked sessions (plan-v2 §10.1).

---

## 4. References

**ESP32 datasets (D):**
D1 [Embedded_WiFi_Sensing (GitHub)](https://github.com/AlbanyArmenta0711/Embedded_WiFi_Sensing) ·
D2 [WiFall (Hugging Face)](https://huggingface.co/datasets/RS2002/WiFall), [KNN-MMD code](https://github.com/RS2002/KNN-MMD) ·
D3 [ESPectre](https://github.com/francescopace/espectre), [dataset_info.json](https://raw.githubusercontent.com/francescopace/espectre/main/data/dataset_info.json) ·
D4 [3DO (Zenodo)](https://zenodo.org/records/10925351), [3DO (GitHub)](https://github.com/StrohmayerJ/3DO) ·
D5 [Wallhack1.8k (Zenodo)](https://zenodo.org/records/13950918), [GitHub](https://github.com/StrohmayerJ/wallhack1.8k) ·
D6 [OpenCSI LCN 2026 dataset (Zenodo)](https://zenodo.org/records/19861032) ·
D7 [ESP32 LOS/NLOS HAR (Mendeley)](https://data.mendeley.com/datasets/x4x5xttvwt/1), [Data in Brief article](https://www.sciencedirect.com/science/article/pii/S2352340924010631) ·
D8 [ESP-Fi HAR (GitHub)](https://github.com/AutoSmartGroup/ESP-Fi-HAR) ·
D9 [CSI-Bench (GitHub)](https://github.com/guozhen-jenn-zhu/CSI-Bench-Real-WiFi-Sensing-Benchmark), [Kaggle](https://www.kaggle.com/datasets/guozhenjennzhu/csi-bench) ·
D10 [RF_ESP32_Dataset (Zenodo)](https://zenodo.org/records/23053384), [GitHub](https://github.com/Mohammed-Baqir/RF_ESP32_Dataset) ·
D11 [Respiration rate, older adults in care (IEEE DataPort)](https://ieee-dataport.org/documents/respiration-rate-measurement-validity-and-repeatability-ubiquitous-non-contact-wi-fi) ·
D12 [Sleep disturbances, older people (IEEE DataPort)](https://ieee-dataport.org/documents/wi-fi-csi-sensing-sleep-disturbances-care-older-people) ·
D13 [WiFiVision-Counting-Tools](https://github.com/nguyen-phan-duc-minh/WiFiVision-Counting-Tools) ·
D14 [Multi-human HAR, ESP32 (IEEE DataPort)](https://ieee-dataport.org/documents/channel-state-information-dataset-multi-human-activity-recognition-indoor-environments) ·
D15 [SG_106B07](https://github.com/Ken35943/SG_106B07) ·
D16 [BUET ESP32 presence/motion](https://github.com/Tahmid-Mahmud-Fahim/esp32-based-presence-and-motion-detection-using-wifi-csi) ·
D17 [HALOC (Zenodo)](https://zenodo.org/records/10715595) ·
D18 [kisum-fall-detection](https://github.com/ki-sum/kisum-fall-detection)

**Other datasets (D):**
D19 [SenseFi benchmark (UT-HAR, NTU-Fi, Widar)](https://github.com/xyanchen/WiFi-CSI-Sensing-Benchmark) ·
D20 [MM-Fi](https://github.com/ybhbingo/MMFi_dataset) ·
D21 [SignFi (as described in the SSL survey)](https://arxiv.org/pdf/2506.12052) ·
D22 [OPERAnet paper](https://arxiv.org/html/2110.04239), [figshare](https://figshare.com/s/c774748e127dcdecc667) ·
D23 [Alsaify LOS/NLOS (Mendeley)](https://data.mendeley.com/datasets/v38wjmz6f6/1), [GitHub](https://github.com/lcsig/Dataset-for-Wi-Fi-based-human-activity-recognition-in-LOS-and-NLOS-indoor-environments) ·
D24 [WiMANS](https://github.com/huangshk/WiMANS), [paper](https://arxiv.org/html/2402.09430) ·
D25 [EHUNAM](https://github.com/GuillermoDiazSM/EHUNAM-dataset) ·
D26 [RadioPoints crowd counting](https://github.com/RadioPoints/Device-free_RF_Human_Sensing_Datasets) ·
D27 [FallDeFi](https://github.com/dmsp123/FallDeFi) ·
D28 [FallDeWideo](https://github.com/shawnnn3di/falldewideo) ·
D29 [HKU lab_wifi_sensing](https://github.com/hku-aiot-courses/lab_wifi_sensing) ·
D30 [Intel Wi-Fi CSI Respiratory Sensing (Zenodo, private data)](https://zenodo.org/records/17974806)

**Papers (P):**
P1 [Armenta-Garcia et al., Sensors 2025, 25(19):6220](https://pmc.ncbi.nlm.nih.gov/articles/PMC12526573/) ·
P2 [KNN-MMD (arXiv 2412.04783)](https://arxiv.org/abs/2412.04783) ·
P3 [WiFlexFormer / 3DO](https://arxiv.org/pdf/2411.04224) ·
P4 [Wallhack1.8k / data augmentation](https://arxiv.org/html/2401.00964v1) ·
P5 [OpenCSI](https://arxiv.org/abs/2607.26665) ·
P6 [CSI-Bench](https://arxiv.org/html/2505.21866v1) ·
P7 [PulseFi](https://arxiv.org/html/2510.24744) ·
P8 [Wi-CaL](https://catalog.lib.kyushu-u.ac.jp/opac_download_md/7161171/7161171.pdf) ·
P9 [eHealth CSI (ResearchGate)](https://www.researchgate.net/publication/372297250_eHealth_CSI_A_Wi-Fi_CSI_dataset_of_human_activities) ·
P10 [VitalCSI](https://pmc.ncbi.nlm.nih.gov/articles/PMC12788229)

L-numbers (L22, L29) refer to the literature list in
[csi-sufficiency-research.md](csi-sufficiency-research.md).
