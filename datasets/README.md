# Datasets

Public CSI datasets selected in
[training-data-sources.md](../docs/research/training-data-sources.md).
The data lives in `raw/` (about 10 GB unpacked) and is **gitignored**.
To get it again on another machine, run `bash datasets/download.sh`, then
`python datasets/fetch_csibench_esp32.py` for E9 (needs a Kaggle token).

IDs (E1, E2, …) match the summary table in the research doc. Since
2026-10-30 these are the **only** data the models and thresholds use (no
own recordings: model-training-plan §0; which set feeds what is in
[docs/models.md](../docs/models.md)). They are still not our board or our
rooms: never report their accuracy as Life-Fi accuracy.

The processed stores in `processed/` are rebuilt with
`python datasets/readers/build.py e1 e8` (movement model) and
`build.py e15 e9` (fall-rule check; E9 needs h5py and is evaluation only).

What the files really contain, the cleaning plan and the splits are in
[dataset-preparation.md](../docs/plan/dataset-preparation.md). Where that
document and this one disagree, dataset-preparation wins: it is based on
opening the files.

## Downloaded (`raw/`)

| Folder | Dataset | Size | License | Format, as found |
|---|---|---|---|---|
| `E1_Embedded_WiFi_Sensing` | Embedded_WiFi_Sensing (Armenta-Garcia 2025) | 1.8 GB | MIT / CC BY 4.0 | `Datasets/`: 64-sc LLTF rows, `[imag, real]`, 50 Hz |
| `E2_WiFall` | WiFall (KNN-MMD) | 122 MB | not stated | `WiFall/ID0…ID9/{fall,Jump,sit,stand,walk}`; ~3 s clips at ~83 Hz, ID2 holds 640 of 928 files |
| `E3_ESPectre` | ESPectre (sparse checkout of `data/`) | 252 MB | GPL-3.0 | `data/{empty,static_presence,motion}/*.npz` + `dataset_info.json`; **HT-LTF**, not LLTF |
| `E4_3DO` | 3DO | 2.4 GB | CC BY 4.0 | `3DO/`: complex `.npy` + CSV, 100 Hz. The `.npy` pairs are off by one int8: read the CSV only |
| `E5_Wallhack1.8k` | Wallhack1.8k | 616 MB | CC BY 4.0 | `wallhack1.8k/`: LLTF (52) + HT-LTF (56) CSV |
| `E6_OpenCSI` | OpenCSI LCN 2026 | 691 MB | CC BY 4.0 | `opencsi-dataset-release/` + README / DATASHEET. **Dropped**: 40 of 52 sc, ~22 Hz bursts |
| `E7_ESP32_LOS_NLOS_HAR` | ESP32 LOS/NLOS HAR (Mendeley) | 464 MB | CC BY 4.0 | ESP-CSI CSV, raw complex, `len=104` (52 sc), 3 environments; ~38 Hz, HT40, chunks out of order |
| `E8_ESP-Fi-HAR` | ESP-Fi HAR | 3.0 GB | CC BY 4.0 | `.mat` amplitude **and** the raw CSVs (I/Q, timestamps, gain columns), 100 Hz, 4 environments. Activity numbering unresolved |
| `E10_RF_ESP32` | RF_ESP32_Dataset | 14 MB | CC BY 4.0 | `.npy` CSI + AGC + FFT gain, `events.csv`. **Dropped**: the gains are all zero, 200–500 frames per session, no timestamps |
| `E15_SG_106B07` | SG_106B07 (ESP32-S3 fall project) | 266 MB | MIT | `data/`: raw CSV + `.npy`; HT40, mostly synthetic falls |
| `E9_CSI-Bench` | CSI-Bench, **ESP32 part of FallDetection only** | 16 MB | CC BY-NC-ND 4.0 | `.h5` per sample: `CSI_amps` float32 (64 sc × 500 × 1) = 5 s at 100 Hz (rate from the paper; the files have no time), amplitude only; `FallDetection/metadata/sample_metadata.csv` lists all 6,700 samples |

**E9 is a partial download on purpose.** The full Kaggle set is 79 GB, and
almost all of it comes from non-ESP32 devices. The metadata shows
FallDetection has 6,700 samples: **494 ESP32** (277 Fall / 217 Nonfall,
9 users, 1 environment) and 6,206 from a device labelled `HP` (17 users,
6 environments). Only the ESP32 files are downloaded, via
`datasets/fetch_csibench_esp32.py`. It needs the Kaggle CLI and your own token
in `~/.kaggle/`. "Nonfall" is one class; the metadata doesn't say which
activity each non-fall is.

The E7 download settles two [unverified] items in the research doc: its
10 activities are *bouncing ball, forward bend, hand swing, jogging in
place, jumping jack, sitting down, squatting, standing, walk to Rx, walk
to Tx*. The data is raw complex with 52 subcarriers.

## Which dataset feeds which model, and why

| Model (plan-v2 §6) | Use | Why these |
|---|---|---|
| **Presence** incl. still person (6.1) | **E3**, **E4**, E5 | E3 is the only open ESP32 set with an explicit *still person* class (~2 h), on 5 chips in 4 rooms (HT-LTF, so report it separately). E4 adds sitting and lying through a wall over 3 days, which also tests drift. E5 gives empty vs walking. E6 was meant for occupancy but is dropped (dataset-preparation §3.3). Use them to check that `S` / `B` separate empty from still in rooms that aren't ours, and to get starting multipliers for `T_on`. |
| **Motion** (6.2) | E1–E5, E8 | Motion needs no labels, so any set checks the ranking walking > arm-waving > still > empty. E10 was meant to test the `gain_comp` handling, but its gains are all zero; E8's `agc_gain` / `fft_gain` columns are the only remaining public gain test. |
| **Breathing rate** (6.3) | **E1** (breathing files) | 22 subjects × paced 10 / 15 / 20 BPM × 3 min, ESP32 LLTF at 50 Hz, so it matches our chain closely. Use it to tune `c_min`, the top-8 subcarrier pick and the autocorrelation agreement. The labels are *target* rates with no reference sensor, so it can't measure true accuracy. |
| **`no_breathing`** (6.4) | none open | No downloadable ESP32 breath-hold set exists. See "Not downloaded" below. |
| **Fall → fainted + hard negatives** (6.5) | **E1**, **E2**, E8, E7, E9 (ESP32 part), (E15) | E1: Fall vs Lie Down vs Sit Down for 22 people; Lie Down is the natural hard negative. E2: ESP32-S3 at ~83 Hz with ~3 s clips, too short for the stillness after the fall (stage 2); fall-verifier features only. E8: falls vs squat / jump in 4 rooms, for leave-one-room-out tests of the GBM verifier. E7: no falls, but *bouncing ball*, *squatting* and *jumping jack* are useful negatives. Bouncing ball is the closest public stand-in for a dropped object. E15 is only a sanity check (HT40, 5 real falls). |
| **Posture transitions** (6.7–6.8) | **E1**, E2, E7 | E1 is the closest public match to our label set: Sit Down, Lie Down, Get Up, Walk on ESP32 LLTF, 15 reps × 22 people. Pretrain or warm-start the CNN on it, and run the GBM vs CNN leave-one-subject-out dry run before our data exists. E2 *sit* / *stand* and E7 *sitting down* / *standing* add a second and third room. None of them has onset marks, so use motion-peak snapping. |
| **Bed exit** (6.9) | none | No public set has this label. Self-record everything. |
| **Count 1 vs 2+** (6.9) | WiCount (not downloaded) | The only open candidate is WiCount (below). The other ESP32 counting sets are paid or on request. |

## Not downloaded: get these yourself if you want them

| ID | Dataset | Would feed | How to get it |
|---|---|---|---|
| E9 rest | CSI-Bench non-ESP32 tasks (breathing, motion source with fan / pet / robot vacuum) | Presence false-alarm ideas only | Skipped: ~79 GB on other devices. Single files can be fetched with `kaggle datasets download guozhenjennzhu/csi-bench -f <path>`. |
| E11 | **Respiration rate, older adults in care** (ESP32 + Neulog belt) | Breathing rate, with a **real reference** | IEEE DataPort needs a paid subscription; a free login is not enough: <https://ieee-dataport.org/documents/respiration-rate-measurement-validity-and-repeatability-ubiquitous-non-contact-wi-fi>. Ask the school or the supervisor about institutional access, or email the authors. Only 65 MB. |
| E12 | **Sleep disturbances, older people** (ESP32, central / obstructive apnea + belt) | **`no_breathing`**, breathing rate | Same DataPort restriction: <https://ieee-dataport.org/documents/wi-fi-csi-sensing-sleep-disturbances-care-older-people>. The only ESP32 apnea data found, so it's **the most valuable one to request**. Email the authors directly. |
| E14 | **Multi-human HAR, ESP32-NodeMCU** (1–3 people) | Count 1 vs 2+ | IEEE DataPort subscription: <https://ieee-dataport.org/documents/channel-state-information-dataset-multi-human-activity-recognition-indoor-environments> |
| — | **WiCount** (ESP32-S3, 52 LLTF sc, ~100 Hz, 0–3 people; cited in [csi-people-counting.md](../docs/research/csi-people-counting.md)) | Count 1 vs 2+ | Open on HuggingFace: <https://huggingface.co/datasets/RS2002/WiCount>. Not downloaded or checked yet; check the licence first. |
| E13 | **WiFiVision counting** (0–7+ people, ESP32) | Count 1 vs 2+ | Email the authors via <https://github.com/nguyen-phan-duc-minh/WiFiVision-Counting-Tools>; academic use only. |
| N13 | **eHealth CSI** (breath-holds, Nexmon) | `no_breathing` ideas | On request with a signed data use agreement (see the paper on ResearchGate). |
| E16 | BUET presence / motion | Presence | Skipped: the repo says it is not open-licensed. Ask the authors first. |
| E17, N1–N15 | HALOC and the non-ESP32 sets | architecture comparison only | Skipped as low fit. Links are in the research doc §4 if needed. |

**Still self-record** (no public substitute): breath-holds with a chest
reference, bed exit, 2 people sitting still, enter / leave events,
calibration-protocol sessions in our rooms, and long unlabelled runs for
FA/h.
