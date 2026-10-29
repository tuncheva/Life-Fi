# Dataset Preparation

What the downloaded public datasets in `datasets/raw/` really contain, which
of them feed which detector or model of [plan-v2 §6](plan-v2.md), and the
cleaning and conversion plan that turns them into our feature stream `F`
([csi-for-models §4](csi-for-models.md)).

This is based on opening the files themselves (2026-10-08), not on the
dataset pages. Where the files disagree with
[training-data-sources.md](../research/training-data-sources.md) or
`datasets/README.md`, the files win; §1 lists the differences.

Tags: **[V]** seen in the files, **[I]** inferred from the files, to be
confirmed in §6.

## Contents

1. What the files changed
2. Inventory, as found
3. Which dataset is used for what
4. Cleaning and conversion plan
5. Per-dataset cleaning
6. Open questions to settle first
7. Work order

---

## 1. What the files changed

| Dataset | Earlier belief | What the files show | Consequence |
|---|---|---|---|
| E2 WiFall | 60 s clips, long enough to see stillness after a fall | **~3 s clips** (2.6–3.0 s, ~250 rows), ~83 Hz, not ~100 [V]. Fall/sit/jump peak in the first 0.5 s [I] | Useless for fall stage 2 (stillness). Onset is at the clip start, so windows are partly cut. ID2 holds 640 of 928 files |
| E3 ESPectre | LLTF, 64 sc | **HT-LTF** (`ltf_type = 'ht-ltf'`), and the bin order differs per chip [V] | Not our signal. Presence/motion checks only, and only after the per-chip map is confirmed |
| E4 3DO | `.npy` ready to use | The `csiposreg_complex.npy` pairs are **off by one int8**: real from one subcarrier, imag from the next [V] | Never use the `.npy`. Rebuild from the CSV `data` field |
| E6 OpenCSI | Occupancy on S3/C3/C6 | S3/C3 keep only j = 0…51, so **k = −12…−1 are missing** (40 of 52). C6 is HT40/HE (246 bins). Per-link rate ~22 Hz in bursts; no usable timestamps [V] | Drop (§3.3) |
| E7 LOS/NLOS HAR | ~100 Hz | **~38 Hz**, HT40 (`cwb = 1`), files stitched from out-of-order chunks (time jumps back in 3,718 of 4,800 files) [V] | Below our 50 Hz grid. Negatives only, low-band features only |
| E8 ESP-Fi | amplitude only | `.mat` is linear amplitude, identical to `hypot` of the first 950 rows of the **raw CSVs, which are also in the repo** [V]. 100 Hz, 10 s clips. **Activity numbering conflicts** between README and model code [V] | Usable and clean in timing, but labels must be fixed first (§6) |
| E9 CSI-Bench | 100 Hz | No timestamps or rate in the files [V]; linear amplitude, centred 64-bin layout | Rate must be taken from the paper/README |
| E10 RF_ESP32 | The one set with AGC / FFT gain | `agc_data` and `fft_data` are **all zero in all 192 sessions**; only 200–500 CSI frames saved per session, no per-frame timestamps; mostly HT40 [V] | Its whole reason to be here is gone. Drop |
| E1 Embedded | k = +1 usable | j = 1 (our k = +1) is the constant `(4, 0)` and j = 0 is `(83, −80)`: the `first_word_invalid` garbage [V] | Apply the first-word repair (copy k = +2 → k = +1) |
| E1 breathing | paced 10/15/20 BPM | A simple Welch peak matches the label ±2 BPM in only ~6–7 of 22 files per rate; many peaks at 30–36 BPM [V] | Use only after a per-file quality screen; never as accuracy |
| E15 SG_106B07 | 5 real falls | 25 real files (5 falls, 10 sit, 10 walk) + 12 synthetic; amplitude/phase already computed, scale varies 30× between sessions (AGC) [V] | Real files only, sanity check |

---

## 2. Inventory, as found

| ID | Files used | Signal | Subcarrier map to our k = −26…−1, +1…+26 | Rate (measured) | Clip | Labels | Usable hours |
|---|---|---|---|---|---|---|---|
| E1 | 1,647 activity + 66 breathing `.txt` | raw int8 LLTF, 64 pairs `[imag, real]` | standard: k = +1…+26 → j 1…26, k = −26…−1 → j 38…63; **repair j = 1** | 50 Hz (host ms) | 20 s / 180 s | folder: FA GU LD SD WA; 10/15/20 BPM; subject `s<N>` (22) | 9.1 + 3.3 |
| E2 | 928 `.csv` | raw, 52 sc already cut | idx 0…25 → k −26…−1, idx 26…51 → k +1…+26 [I] | ~83 Hz (µs) | ~3 s | folder + `taget`; subject ID0–9 | 0.77 |
| E3 | 87 `.npz` | raw int8 **HT-LTF**, 64 bins | c3/c5/c6: k = j − 32 [I]; s3/esp32: raw order [I] | ~100 Hz (µs) | 90–600 s | `empty` / `static_presence` / `motion`; chip; room; `dataset_role` | 3.9 |
| E4 | 51 sessions, `csiposreg.csv` | raw int8, LLTF + HT-LTF (256) | **centred**: k = j − 32 → pairs 6…31, 33…58 | 100 Hz (µs) | 130–600 s | **per packet** `class` 0–3 (empty/walk/sit/lie) + x, y, z; day d1–d3 | 5.0 |
| E5 | 4 × 11 `.csv` | raw int8, LLTF + HT-LTF (256) | centred, as E4 | 100 Hz (µs, uint32 wraps) | 120–610 s | per file: b / w / ww; LOS/NLOS; BQ/PIFA antenna; NLOS room 1–5 | 2.1 |
| E7 | 4,800 `.csv` | raw int8, 52 sc, HT40 | as E2 [I] | **~38 Hz**, chunked | ~5 s | 10 activities; subject; env 1–3 | ~6.3 |
| E8 | 2,240 `.csv` (+ `.mat`) | raw int8, 52 sc, HT40, `agc_gain`/`fft_gain` columns | as E2 [I] | 100 Hz (µs) | 10 s | file `env-person-activity-trial`; **mapping unresolved** | 6.2 |
| E9 | 494 `.h5` | linear amplitude, 64 × 500 | centred, as E4 | unknown | 500 samples | Fall 277 / Nonfall 217; 9 users; 1 room | ~0.7 |
| E15 | 25 real `.csv` | amplitude + phase, HT40 | `amplitude_4…29`, `amplitude_31…56` | ~70 Hz | 7–20 s | fall_forward 5, sitting_down 10, walking 10 | < 0.1 |
| E6 | — | 40 of 52 sc | — | ~22 Hz bursts | 750 s | intervals | dropped |
| E10 | — | no timestamps, gains zero | — | — | 200 frames | — | dropped |

---

## 3. Which dataset is used for what

### 3.1 By model

| Model (plan-v2 §6) | Primary | Secondary | What it is used for | Not for |
|---|---|---|---|---|
| **Transitions** (6.7–6.8) | **E1** (SD, LD, GU, WA; FA as `none`) | E2 *sit* / *stand* (subject-balanced), E7 *sitting down* / *standing* | GBM vs CNN leave-one-subject-out dry run; CNN warm start; checking the window-label rule and motion-peak snapping | Reported accuracy |
| **Fall verifier** (6.5) | **E1** FA vs LD / SD, **E8** fall vs squat / jump / turn | E2 fall vs rest, E9 (eval only), E7 negatives (*bouncing ball*, *squatting*, *jumping jack*, *forward bend*) | Fall features of csi-for-models §6; leave-one-room-out on E8's 4 rooms; `T_fall` starting point | FA/h |
| **Fall stage 2** (stillness after spike) | **E1** FA (falls in 0–6 s, ≥ 14 s after) | E8 (≈ 5–8 s after) | Stillness timing, `S` after the spike | — |
| **Presence** (6.1) | **E4** (empty / sit / lie, 3 days, per-packet labels), **E3** `static_presence` vs `empty` | E5 empty vs walking (5 rooms, 2 antennas) | Does `S` / `B` separate empty from a still person in rooms that aren't ours; `T_on` multipliers; E4 day 1 → day 3 for drift | Thresholds in our room |
| **Motion** (6.2) | E4, E5, E3, E8 | E1, E2 | Ranking walking > arm-waving > still > empty; `M` scaling sanity | Gain-compensation tests (E10 gave none, see §6) |
| **Breathing rate** (6.3) | **E1** breathing, screened (§5) | E4 sit / lie segments (no label) | Tune `c_min`, top-8 pick, autocorrelation agreement on files that pass the screen | Accuracy: labels are targets, no reference |
| **Calibration / drift** (6.6) | E4 (3 days), E3 long empty runs | — | How fast `p_empty` drifts; Page–Hinkley `σ_r` order of magnitude | — |
| **`no_breathing`, bed exit, count 1/2+** | none | — | Self-record (plan-v2 §10) | — |

### 3.2 By dataset

| ID | Tier | Role in one line |
|---|---|---|
| E1 | **A** | Main pretraining and dry-run set: transitions, falls, stage 2, breathing tuning. Closest to our chain (ESP32 LLTF, 50 Hz) |
| E8 | **A** | Fall vs hard negatives in 4 rooms at 100 Hz; leave-one-room-out. Blocked on the label mapping |
| E4 | **A** | Presence incl. sitting / lying still, 3 days; per-packet labels |
| E5 | **B** | Presence / motion in 5 rooms, LOS and NLOS. Directional antennas, so a different domain |
| E3 | **B** | Still-person presence on 5 chips, 4 rooms. HT-LTF, not our LLTF: report it separately |
| E2 | **B** | Short fall / sit / stand clips on ESP32-S3; extra subjects for transitions. Balance ID2 |
| E7 | **C** | Hard negatives and extra rooms, but 38 Hz and HT40. Low-band features only |
| E9 | **C** | Fall eval only. NC-ND, one room, no rate in the files |
| E15 | **C** | 5 real falls; sanity check of the fall rule. Synthetic files excluded |
| E6 | drop | Missing 12 of 52 subcarriers, ~22 Hz bursts, no usable clock |
| E10 | drop | Gain fields empty, 200 frames per session, no timestamps |

Tier A is converted first and used in every dry run. Tier B is converted
second and kept as a separate domain in every result table. Tier C is
used only where named above.

### 3.3 Why E6 and E10 are dropped

- **E6.** Our profile `p` and the model view `x` are both 52 wide. Filling
  12 missing subcarriers would invent data, and ~22 Hz with 300–700 ms
  bursts fails our own quality gate (≥ 50 Hz, csi-for-models §5). Its
  one unique idea, cross-chip/board-batch occupancy, is covered by E3.
- **E10.** It was kept only to test the `gain_comp` handling. With zero
  gains there is nothing to test; the gain test moves to our own Phase 2
  measurement #7 and to injected gain steps in augmentation.

Keep both in `raw/` (they are small or already there) but write no reader.

---

## 4. Cleaning and conversion plan

### 4.1 Principle

One reader per dataset, then the **same** `lifefi.dsp` steps 4–8 as for our
own recordings ([csi-for-models §4](csi-for-models.md)). Readers only
parse, map subcarriers, fix timestamps and attach labels; they never
filter, normalise or resample. That way a public file and our own `.csirec`
reach the model through identical code.

### 4.2 Folder layout

```
datasets/
  raw/        as downloaded, never edited (gitignored)
  interim/    reader output: one .npz per recording (gitignored)
  processed/  F at 50 Hz + windows + labels (gitignored)
  manifest/   one row per recording: source, QC numbers, keep/drop, split (in git, small)
  readers/    one module per dataset + shared qc.py (in git)
```

Add `datasets/interim/` and `datasets/processed/` to `.gitignore`.

### 4.3 Interim format (reader output)

One `.npz` per recording:

| Key | Type | Meaning |
|---|---|---|
| `ts_us` | int64 `[N]` | Monotonic µs, unwrapped, starting at 0 |
| `amp` | float32 `[N, 52]` | **Linear** amplitude, columns k = −26…−1, +1…+26 |
| `sat` | bool `[N]` | Any \|re\| or \|im\| ≥ 127 on > 2 subcarriers |
| `seg_label` | int16 `[N]` | Per-sample label where the dataset has one, else −1 |
| meta (JSON string) | | `dataset`, `reader_version`, `source_path`, `subject`, `env`, `day`, `chip`, `antenna`, `ltf` (`lltf`/`htltf`), `bw` (`ht20`/`ht40`), `clip_label`, `rate_hz_measured` |

Per dataset the reader also writes one manifest row with the QC numbers
of §4.4.

### 4.4 Shared QC (`qc.py`), run on every interim file

| Check | Rule [H] | Action |
|---|---|---|
| Rows / duration | below dataset minimum (§5) | drop |
| Measured rate | median dt; fail if < 40 Hz (except E7, flagged) | drop or flag |
| Gaps | count > 50 ms, > 1 s | > 1 s: split into segments; keep the count |
| Time order | any backward step | split at it (E7), or drop the file |
| Saturation | share of `sat` frames | > 1 %: drop from fall/transition training; > 0.1 %: flag |
| Dead subcarriers | per-sc median amplitude < 1 or std ≈ 0 | > 2 dead: drop; otherwise mark and Hampel |
| Common-mode step | median over sc of \|ΔL\| > 3 dB in one sample | flag (uncompensated AGC); drop from fall training |
| Duplicate rows | consecutive identical `amp` rows | > 1 %: drop |
| Label sanity | label from folder vs in-file label | mismatch: drop and list |

All drops go into the manifest with the reason. Nothing is deleted from
`raw/`.

### 4.5 Into `F`

Interim → `lifefi.dsp` steps 4–8: `L = 20·log10(max(1, amp))`, Hampel,
linear onto 100 Hz → 20 Hz low-pass → every 2nd sample (50 Hz), gap
policy. No `gain_comp` (no public set has it). Output to
`processed/<id>/<recording>.npz` with `F`, `valid`, `ts`, labels, and
`PIPELINE_VERSION`.

Then windows (3 s, hop 0.5 s, model view `x`) and the GBM features, with
labels by the plan-v2 §6.8 rule. Clip-level labels get their onset from
the motion-energy peak (`M`), as plan-v2 already says.

### 4.6 Splits

Fixed once, written to the manifest, never by window:

| ID | Split |
|---|---|
| E1 | 5-fold by subject (22 subjects); 3 subjects locked as test |
| E8 | leave-one-room-out (4 rooms); inside a room, by person |
| E4 | by day (d1, d2 → train, d3 → test) |
| E5 | by room / LOS vs NLOS |
| E3 | the dataset's own `dataset_role` (train / selection / holdout); `exclude` dropped |
| E2 | by subject; ID2 down-sampled to the other subjects' size in training |
| E7 | by subject × environment |
| E9 | all test |

### 4.7 Label mapping

| Our label | E1 | E2 | E4 | E5 | E3 | E7 | E8 (after §6) | E9 | E15 |
|---|---|---|---|---|---|---|---|---|---|
| `sit_down` | SD | sit | — | — | — | sitting down | — | — | sitting_down |
| `stand_up` | — | stand | — | — | — | standing [I] | — | — | — |
| `lie_down` | LD | — | — | — | — | — | — | — | — |
| `get_up` | GU | — | — | — | — | — | — | — | — |
| walking | WA | walk | class 1 | w | (motion) | walk to Rx / Tx | walk | — | walking |
| fall | FA | fall | — | — | — | — | fall | Fall | fall_forward |
| hard negative | LD, SD | Jump | — | — | — | bouncing ball, squatting, jumping jack, forward bend | squat, jump, turn | Nonfall | sitting_down |
| empty | — | — | class 0 | b | empty | — | — | — | — |
| still person | — | — | class 2, 3 | — | static_presence | — | — | — | — |
| motion | — | — | class 1 | w, ww | motion | all | all | — | — |

E7 *standing* and E2 *stand* must be checked as transitions vs static
postures from their motion energy before they are labelled `stand_up`
(E2: peak mid-clip [I]).

---

## 5. Per-dataset cleaning

### E1 Embedded_WiFi_Sensing (Tier A)

1. Parse `.txt`: col 0 = epoch ms → µs; 128 ints as 64 `[imag, real]` pairs.
2. Map k: j 1…26 and 38…63. **Copy k = +2 into k = +1** in every row (j = 1 is constant `(4, 0)`).
3. Drop files < 900 rows or < 19.5 s (e.g. `Activity/GU/s14/csi_data_1722362089.txt`, 866 rows).
4. Check the `13, 10` (CR LF) pair frequency per file; if > 1 % of rows,
   mark those values as outliers before Hampel.
5. Activity: one rep per 20 s file [I]. Onset = `M` peak; files with no
   clear single peak (peak/median < 3 [H]) go to `none`, not to the class.
   WA is a segment, not an event.
6. Breathing: per file, compute the 0.1–0.5 Hz Welch peak on PC1 and keep
   only files whose peak is within ±2 BPM of the target over ≥ 60 % of
   30 s windows [H]. Expect ~1/3 to pass. Record the pass list.
7. Domain note: native 50 Hz, so no content above 25 Hz; keep it as its
   own domain in results.

### E8 ESP-Fi HAR (Tier A, after §6.1)

1. Use the **CSVs**, not the `.mat` (the `.mat` is just `hypot` of them,
   and the CSVs keep I/Q, timestamps and the gain columns).
2. Drop the Excel all-comma rows (`,,,,`; 445 k rows in 462 files).
3. 104 ints → 52 pairs → amplitude; map as E2 after the order check (§6.3).
4. Saturation: 1,387 of 2,240 files have |I| or |Q| ≥ 127. Compute the
   share per file; apply the §4.4 rule. Expect to lose part of the
   high-gain rooms from fall training. Report how many.
5. Look at `agc_gain` / `fft_gain`: if they vary, they are our only public
   gain test (replaces E10). Do not use them as features.
6. Handle the full-width brackets in folder names (`（Office）`) with
   `pathlib`, not string matching.
7. Ignore `Model Code/Data` (a byte copy of room 3).

### E4 3DO (Tier A)

1. Read `csiposreg.csv` only (`csi.csv` in d1/b1–b3 is the same without
   positions). **Never the `_complex.npy`.**
2. `data` = 256 int8 → first 128 = LLTF, 64 centred pairs; keep pairs
   6…31 and 33…58 (k = j − 32).
3. Labels per packet from `class`. Cut each session into
   constant-label segments; drop 2 s on both sides of every change
   (walking in / out of position).
4. Keep x, y, z per packet in interim meta; useful for "distance from link"
   analysis in presence.
5. Note the domain: directional antenna, through wall.

### E5 Wallhack1.8k (Tier B)

1. Same parser as E4 (same 29-column format, same centred layout).
2. Unwrap `local_timestamp` (uint32; wraps in 4 files, e.g. `LOS/BQ/ww5`).
3. Saturation check (`NLOS/PIFA/ww3.csv` reaches 128).
4. Flag the low-RSSI stretches (−91 / −94 dBm) and NLOS `w1`/`ww1`
   (p95 dt ≈ 20 ms).
5. Ignore `spectrograms/` (their own preprocessing).
6. Keep antenna (BQ / PIFA) in meta; results by antenna.

### E3 ESPectre (Tier B, after §6.2)

1. Read `csi_data` int8 `[N, 128]`; per-chip map from §6.2.
2. Drop `dataset_role = exclude` (covers the ~500 Hz c3 files and the
   bursty c6 20260704 files).
3. Mark `ltf = htltf` in meta and never mix it into LLTF training;
   use it for presence/motion checks of the detectors only.
4. Note c5 has no `empty` file and esp32 has only 2 + 2 files: compute
   presence separation per chip only where empty exists.

### E2 WiFall (Tier B)

1. Parse `data` (JSON list of 104); `local_timestamp` µs.
2. Drop the one non-monotonic file (`ID2/fall/2023-11-13_22-26-16-974_104_1.csv`)
   and clips < 2.5 s (e.g. `ID5/walk/2023-11-12_20-11-54-398_104_1.csv`).
3. A 3 s clip gives at most one window, and the onset is often in the
   first 0.5 s. Pad nothing: use these clips for the GBM features of the
   fall verifier and as extra transition windows only where the
   §6.8 ≥ 70 % rule still holds after snapping.
4. Balance: cap ID2 at 32 files (same as other subjects) in training;
   use the rest of ID2 as an extra test set.

### E7 LOS/NLOS HAR (Tier C)

1. Parse `data`; ignore the Excel-mangled `timestamp` column (304 files in
   env 1); use `local_timestamp`.
2. **Split each file at every backward or > 1 s time step**; keep segments
   ≥ 3 s; sort nothing across segments.
3. Drop the 667 non-HT rows (`sig_mode = 0`) or keep only the dominant type
   (HT40 rows), the 5 files with duplicated rows if > 1 %, and
   `E1_S3_A06_T17.csv` (label `"taget"`).
4. ~38 Hz is below our grid. Resampling to 50 Hz invents nothing but
   leaves no content above 19 Hz. Use E7 only for low-band features
   (≤ 10 Hz) and as a third domain.

### E9 CSI-Bench (Tier C)

1. Read `CSI_amps` (64, 500, 1) → transpose; take j 6…31 and 33…58.
2. Already linear amplitude: no sqrt. Timestamps synthetic at the rate
   from §6.4.
3. Eval only. No converted copy leaves the machine (CC BY-NC-ND).

### E15 SG_106B07 (Tier C)

1. Real files only: drop every `sample_synth_*` and ignore
   `data/processed/` (it contains the synthetic falls).
2. LLTF = `amplitude_4…29` (k −26…−1) and `amplitude_31…56` (k +1…+26).
3. Fix the negative timestamps of the 2026-09-06 files (signed 32-bit
   overflow → add 2³²).
4. Strong scale differences between sessions are fine after dB + mean
   removal; still flag common-mode steps.

---

## 6. Open questions to settle first

| # | Question | How | Blocks |
|---|---|---|---|
| 6.1 | **E8 activity numbering**: README (1 run, 2 fall, …) vs model code (… 7 fall) vs CSV `taget` tags | Read the paper (Wen et al., Ad Hoc Networks 2026); check the fall clips have a burst then stillness (`M` profile per Z); if still unclear, email the authors | All E8 use |
| 6.2 | **E3 per-chip bin order** (s3/esp32 raw vs c3/c5/c6 centred) | Read the ESPectre firmware/collector source on GitHub (not in the sparse checkout); confirm with the null pattern | E3 |
| 6.3 | **52-sc order** in E2/E7/E8 (idx 0…25 = k −26…−1?) | ESP-IDF docs for 104-byte exports; check the DC dip/decorrelation between idx 25 and 26 on all three | E2, E7, E8 |
| 6.4 | **E9 sampling rate** | CSI-Bench paper/README (the files have no time) | E9 |
| 6.5 | E2 *stand* and E7 *standing*: transition or posture? | `M` profile per clip | Label map |
| 6.6 | E1 breathing: how many files pass the screen | §5 E1 step 6 | Breathing tuning |

---

## 7. Work order

1. **Settle §6.1–6.4** (desk work, no code beyond quick plots).
2. **Shared code:** `readers/` skeleton, the interim writer, `qc.py`, the
   manifest; `.gitignore` entries. Test: a hand-made file with known
   values round-trips; subcarrier order test per reader (DC/guard
   positions).
3. **Tier A readers:** E1 → E4 → E8. After each: QC report, mean
   amplitude plot per subcarrier (shape check), 3 random files plotted
   as `F` with labels.
4. **Run `lifefi.dsp`** on Tier A once it exists (Phase 1 of plan-v2);
   until then, a temporary resampler with the same parameters, clearly
   marked.
5. **First dry runs:** transition GBM on E1 (leave-subject-out), fall
   features on E1 + E8 (leave-room-out), presence `S`/`B` on E4.
6. **Tier B readers:** E5, E3, E2. **Tier C:** E7, E9, E15 only when a
   dry run needs them.
7. Update `datasets/README.md` and
   [training-data-sources.md](../research/training-data-sources.md) with
   §1 (E2 clip length, E3 HT-LTF, E10 gains, E7 rate, E6 subcarriers).

Rules that hold throughout: `raw/` is read-only; every drop has a reason
in the manifest; public results are reported per dataset and never as
Life-Fi accuracy.
