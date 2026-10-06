# Implementation Plan Audit and Model Research

This document reviews [implementation-plan.md](implementation-plan.md) and
answers two questions:

1. Which parts of the plan are wrong, risky or missing?
2. What can a single ESP32-S3 + router system realistically do, and which
   prediction models are worth building?

Sources are linked inline. Where an accuracy figure comes from a paper
abstract or a project's own benchmark, the text says so. Check exact numbers
before putting them on slides.

---

## Part A — Audit

Findings are ranked by severity:

- **Blocker:** the system will not work as described.
- **Major:** it works, but it gives wrong results in an important scenario.
- **Minor:** worth fixing; it won't sink the demo.

### A.1 Summary

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | Blocker | `agc_gain` / `fft_gain` are not in `rx_ctrl`; the plan's way of obtaining them doesn't exist | 3.1, Step 2 |
| 2 | Blocker | Presence = variance of motion → a person sitting or lying still reads as "nobody here" → posture is `null` and `no_breathing` can never fire | Step 3, 3.6 |
| 3 | Major | `rolling` calibration absorbs a still person within about 60 s, which breaks presence, count and `no_breathing` (the Clinic scenario) | 3.4 |
| 4 | Major | `fainted_suspected` = "`lying` + still 10 s" fires for every patient resting in bed → constant high alerts in Clinic and Home | Step 6 |
| 5 | Major | Train/serve skew: training features are z-scored against an empty-room baseline, but runtime may use `rolling` → design rule 1 is violated | 3.4, 3.6 |
| 6 | Major | `no_breathing` is detected from a 30 s FFT confidence → effective latency of about 35–45 s before `delay_s` | Step 6 |
| 7 | Major | Static 4-class posture from a 3 s window mostly learns position and room; research and products agree it doesn't generalise | Step 5 |
| 8 | Major | `synth.py` pre-training: hand-made synthetic posture/count windows have no physical basis and can teach the model the generator's assumptions | Step 5 |
| 9 | Major | `onsite_adapt` holds out "20 % of the new recording", which is the random-window leakage the plan forbids in Step 5 | Step 7 |
| 10 | Major | Edge-triggered events with no "cleared" state, yet the server's `delay_s` needs to know whether the condition cleared | 3.3, 6 |
| 11 | Major | Scope: 5 languages and 9 components, plus about 10 h of labelled recordings, for a hackathon (and EduHack rules may require code written on site) | whole plan |
| 12 | Minor | The CSI config (`wifi_csi_config_t`) isn't specified; the defaults (`channel_filter_en`, `ltf_merge_en`, auto scaling) distort per-subcarrier features | Step 2 |
| 13 | Minor | HT-only filtering: ping replies can arrive as legacy frames; LLTF is present in both and has the same −26…26 indices | 3.6 step 1 |
| 14 | Minor | `first_word_invalid` makes subcarrier +1 invalid; the plan doesn't handle it | 3.6 |
| 15 | Minor | Resampling about 88 Hz → 50 Hz with no anti-alias low-pass | 3.6 step 5 |
| 16 | Minor | The ESP32-clock → host-clock mapping for `ts.npy` is unspecified (offset + drift per `boot_id`) | 3.6 |
| 17 | Minor | Model outputs aren't smoothed or calibrated over time → count and posture flicker every 0.5 s | Step 5 |
| 18 | Minor | Breathing ground truth from a metronome is approximate; there are no references beyond 3 recordings | Step 3 |
| 19 | Minor | False alarms per hour measured on 30–60 min of data: 0 alarms still has a 95 % upper bound of about 3/h | Step 6, 5 |
| 20 | Minor | Privacy and regulation missing (health data, sensors in school bathrooms, "not a medical device") | 6, 8 |
| 21 | Minor | Engine TCP :6000 and UDP :5005 are unauthenticated; bind to localhost / LAN only | 3.4 |

### A.2 Details and fixes

**1. Gain values: the source doesn't exist as written.**
- **Problem:** On ESP32-S3, `wifi_pkt_rx_ctrl_t` exposes rssi, rate, sig_mode, mcs, cwb, stbc, noise_floor, channel, timestamp and similar fields. It has **no AGC or FFT gain** ([esp_wifi_types_native.h](https://github.com/espressif/esp-idf/blob/master/components/esp_wifi/include/local/esp_wifi_types_native.h)). The gain values come from Espressif's separate [`esp_csi_gain_ctrl`](https://components.espressif.com/components/espressif/esp_csi_gain_ctrl) component, through `esp_csi_gain_ctrl_get_rx_gain(rx_ctrl, &agc, &fft)`.
- **Prior art:** Espressif's example records a baseline over 100 packets and then compensates. Forcing a fixed gain is off by default. The ESPectre project tried forcing it and reverted because of instability and packet loss ([ADR](https://github.com/francescopace/espectre/blob/main/docs/adr/2026-07-04-keep-agc-active-and-standardize-cv-normalization.md)).
- **Fix:** In Step 2, add the component and fill `agc_gain` / `fft_gain` from it. Also add a scale-invariant feature path, e.g. coefficient of variation std/mean per subcarrier, or each subcarrier divided by the frame's mean amplitude. That way a wrong compensation formula only degrades results instead of breaking them.

**2. Presence misses still people.**
- **Problem:** "Presence and motion = variance of normalised amplitudes over 0.5 s" is a motion detector. A person sitting or lying still produces almost no 0.5 s variance. Because M2 and `no_breathing` both require presence, the system goes blind in the scenarios Home and Clinic exist for.
- **Fix:** Compute presence from three signals:
  - (a) static deviation from the empty baseline, e.g. mean |z| over 3–10 s;
  - (b) breathing-band (0.1–0.5 Hz) energy over 20–30 s;
  - (c) motion.
- Wrap these in a hysteresis state machine: once motion is seen, stay "present" until an exit-like motion burst is followed by baseline-level static deviation **and** baseline-level breathing energy.

**3. `rolling` calibration erases a still person.**
- **Problem:** A 60 s rolling median turns a person lying still into the new "normal" after about a minute.
- **Fix:**
  - Freeze the rolling baseline while presence is true. Update it only during confirmed-empty periods.
  - Treat `rolling` as a demo fallback only. Show a UI warning that still-person detection is degraded.
  - Better: take the empty baseline before the audience arrives, then let the drift detector (B.3, model 6) re-baseline during confirmed-empty periods.

**4. `fainted_suspected` fires for anyone resting.**
- **Problem:** "`fall` **or** `lying`, then still for 10 s" matches every patient in bed and every nap.
- **Fix:**
  - Make `fainted_suspected` require a preceding `fall` candidate, or a lie-down transition that was not preceded by a calm approach.
  - Add a "lying in an expected place" notion: bed zone or time of day (see bed-exit, B.3 model 8).
  - Raise the stillness requirement to 20–30 s. Research and Origin Wireless's product both treat "spike → prolonged inactivity" as the robust signal.

**5. Training and runtime see different normalisation.**
- **Problem:** `--dump-features` must z-score against *something*, and the natural choice is the session's 30 s empty start. If the demo runs `rolling`, the models see a different input distribution. That is exactly the silent bug design rule 1 is meant to prevent.
- **Fix:**
  - Make the calibration mode an explicit `--dump-features` argument and record it in `meta.json` and in the ONNX `metadata_props`.
  - Have the engine refuse to run M1/M2 on a calibration mode the model wasn't trained with. Alternatively, train on both: dump each session twice.

**6. `no_breathing` latency.**
- **Problem:** With a 30 s FFT window, the breathing peak lingers for roughly the first half of the window after breathing stops. Then the 20 s confidence rule runs, then `delay_s`. Expect 35–45 s before an alert.
- **Fix:** Add a time-domain cessation detector on the band-passed breathing signal. If the 10 s RMS envelope drops below about 30 % of the person's own envelope over the previous minute, with presence held and motion low, raise the event. Keep the FFT for the *rate* only. Clinical apnea is defined at ≥ 10 s, so a 10–15 s detector is defensible.

**7. Static posture is the wrong target.**
- **Problem:** Standing-still, sitting-still and lying-still differ mainly in static multipath. That pattern depends more on *where* the person is than on posture.
- **Evidence:**
  - Commercial products don't ship posture.
  - Within-room HAR benchmarks (UT-HAR, SenseFi) reach 90 %+ on *activities*.
  - Cross-room accuracy typically falls to 40–70 % ([survey arXiv 2503.08008](https://arxiv.org/abs/2503.08008)).
- **Fix:** Retarget M2 to **transitions + walking**: `sit_down`, `stand_up`, `lie_down`, `get_up`, `walking`, `none`. Each has a distinctive 2–4 s motion signature. Then derive current posture with a state machine: last transition + "still since". See B.3.

**8. Synthetic data.**
- **Problem:** Hand-written z-score windows for "sitting vs lying" or "2 vs 3 people" encode the author's guess of what the signal looks like. Physics-based simulation (ray tracing, e.g. Sionna RT) shows only modest gains, and it ignores ESP32 artefacts such as AGC jumps and jitter. Generative augmentation (RF-Diffusion, [arXiv 2404.09140](https://arxiv.org/abs/2404.09140)) needs real data from the same hardware.
- **Fix:**
  - Use `synth.py` only for pipeline tests, rule unit tests (fall spike + stillness, breathing sinusoid at a known rate) and sanity checks.
  - Do not pre-train M1/M2 on it.
  - For pre-training, use **unlabelled real recordings**: leave the ESP32 recording for hours, for free. Optionally add public ESP32 datasets (B.5).

**9. `onsite_adapt` leakage.**
- **Problem:** A random 20 % of a 10-minute session shares neighbouring windows with the training part, so "new model is better" will almost always be true.
- **Fix:**
  - Hold out a **contiguous block per class**, e.g. the last 20 s of each class segment, with a ≥ 3 s gap.
  - Better: record a second short pass (about 2 min) used only for the comparison.
  - Also add **AdaBN** (B.4): it adapts with *unlabelled* venue data in seconds.

**10. Event lifecycle.**
- **Problem:** The plan says `delay_s` "drops the alert if the condition clears", but events are one-shot.
- **Fix:** Give events a state, `{"id":42,"type":"fall","state":"active"|"cleared","t":...}`, or let the engine report `conditions` (current boolean states) alongside one-shot events. Add the change to `results.schema.json` now; it is a contract change.

**11. Scope.**
- **Problem:** Firmware (C), three C tools, a C++ engine, a Java server, Python ML, a Next.js UI and CI. On top of that, section 5 implies about 2 h of recording per session × 4–6 sessions, with several people.
- **Biggest simplification:** write the engine in **Python** (numpy/scipy + onnxruntime). 50 Hz × 52 values is trivial load. The training code then imports the *same* preprocessing module, which removes the train/serve-skew risk that rule 1, the fixtures and the C++ test vectors all exist to manage. The C++ engine, `--dump-features` parity and part of CI disappear.
- **If a second process language must go:** the Spring server could also be FastAPI inside the same Python process.
- **Constraint:** confirm the EduHack rules first; if code must be written on site, cut scope accordingly.
- **Proposed cut lines:**
  - **Must:** firmware, recorder/replayer, engine with presence, motion and breathing, rules, server, Home page.
  - **Should:** labelling pipeline, transition model, School and Clinic pages.
  - **Could:** count model, `onsite_adapt`, serial bridge, CI for every folder.

**12–16. CSI details** (verified against [ESP-IDF CSI docs](https://github.com/espressif/esp-idf/blob/master/docs/en/api-guides/wifi-driver/wifi-vendor-features.rst) and [esp-csi](https://github.com/espressif/esp-csi)).
- **Set `wifi_csi_config_t` explicitly:**
  - `lltf_en=1`, `htltf_en=1`, `stbc_htltf2_en=0`;
  - `ltf_merge_en=0`: the default replaces HT-LTF with an LLTF/HT-LTF average;
  - `channel_filter_en=0`: the default smooths adjacent subcarriers and couples them;
  - `manu_scale=1` with a fixed `shift`: auto-scaling changes amplitude scale per packet.
  - Record the chosen values in `model_io.md` and bump `PIPELINE_VERSION` if they change.
- **Layout (HT20):** LLTF (128 B) then HT-LTF (128 B). Each is ordered 0..31 then −32..−1, and each pair is `[imag, real]`, as the plan says. HT-LTF has 56 non-zero subcarriers (±1…±28, pilots at ±7 and ±21). LLTF has 52 (±1…±26). The plan's k = ±1…±26 is the shared range, which is a good choice.
- **Use LLTF as the fallback:** legacy replies carry LLTF only. Taking LLTF for non-HT frames keeps the same 52 indices and recovers packets the plan currently drops. Keep model input consistent by training on one of the two variants, or with a flag.
- **`first_word_invalid`:** the first 4 bytes, i.e. DC and +1 in LLTF, are invalid. Interpolate +1 from +2.
- **Anti-aliasing:** realistic rate is **about 88 Hz** (ESPectre's ESP32-S3 benchmark: 83–90 pps at 100 pps ping, [perf](https://github.com/francescopace/espectre/blob/main/docs/performance/ESP32-S3.md)). Low-pass at about 20 Hz before resampling to 50 Hz. The "≥ 80 Hz" target is achievable but tight; turn off Bluetooth scanning, which makes CSI bursty.
- **Timestamps:**
  - Use `esp_timer_get_time()` (64-bit), not `rx_ctrl.timestamp`, which is 32-bit µs and wraps every about 71.6 min.
  - Map ESP32 µs → host µs with a per-`boot_id` linear fit (offset + drift) over `(ts_us, host_rx_us)` pairs. A plain offset drifts by tens of ms per hour; per-packet host time carries network jitter.
- **Router settings for `setup.md`:**
  - fixed 2.4 GHz channel (no auto-channel), 20 MHz width;
  - no band steering or mesh roaming;
  - TxBF / MU-MIMO off if possible: precoding changes HT-LTF CSI;
  - ping allowed by the firewall.
- **Antenna:** an ESP32-S3 module with an external antenna (`-1U`) is preferred over the PCB antenna.

**17. Smoothing and calibration.**
- Add temperature scaling on a held-out session.
- Add an `uncertain` output when max p < threshold; that threshold *is* the "model unsure → rule fallback" condition the plan mentions without defining.
- Add a median or HMM over the last 3–5 windows. Its transition matrix should forbid impossible sequences, e.g. lying → walking without `get_up`.

**18. Breathing reference.** Record a chest reference alongside the metronome: a phone in a chest pocket logging the accelerometer (e.g. phyphox), or a cheap respiration belt. Paced breathing drifts, and a reference lets you also test irregular and stopped breathing (breath-holds of 15–30 s), which is what `no_breathing` must detect.

**19. False-alarm statistics.** Report FA/h with a confidence interval. For a credible "< 1 FA per day" claim, record several hours of unscripted activity. The easy way is to leave the system running overnight and during normal work. Include hard negatives: sitting down hard, dropping a bag, lying on a sofa, a pet if available.

**20. Privacy and regulation** (for the pitch and the design).
- **Health data:** breathing, falls and sleep are GDPR Art. 9 health data. Keep processing local, minimise retention, and pseudonymise `subject` in `labels.jsonl`.
- **School:** aggregate occupancy only, no individual tracking. Don't monitor activity in bathrooms beyond occupied / fall.
- **Clinic:** say "assistive notification, **not a medical device**, does not replace nurse call". A claim of clinical fall or apnea detection would fall under EU MDR or FDA SaMD.
- **Identification:** avoid any form of person identification (EU AI Act).

### A.3 What the plan gets right

- Contracts first, plus a replayer that is byte-identical to the device. This is the right backbone and makes the demo resilient.
- Session-level splits, locked test sessions, and FA/h + per-event recall as metrics.
- Rules for rare events instead of models; profiles decide alerts on the server.
- Honest expectation table (section 8), especially "count 2+ weak" and "posture uncertain".
- Small models so on-site fine-tuning is feasible.

---

## Part B — What the system can do, and which models to build

### B.1 The hardware ceiling

One link, one antenna, amplitude only. Most published WiFi-sensing results use
Intel 5300 / Atheros cards with 3×3 MIMO, phase and often several links.

- **Does not apply to this hardware:** "WiFi DensePose" ([arXiv 2301.00250](https://arxiv.org/abs/2301.00250)), Widar3.0 body-velocity profiles, gestures and sign language. They need multi-antenna phase.
- **Reliable on a single ESP32 link:**
  - motion vs no motion;
  - presence (still people only with a good baseline);
  - breathing rate when the person is still and near the line of sight;
  - coarse activity classes **within the trained room**.

Commercial products are a good guide to what is robust:

- **Cognitive Systems WiFi Motion and Plume Sense:** motion, presence, sleep/activity, routine.
- **Origin Wireless / Aloe Care:** falls, sleep, breathing irregularity, routine deviation, on multi-antenna hardware.
- **Linksys Aware:** motion; a breathing/sleep tier at about 1,500 Hz CSI was later discontinued.

None of them ship posture, people counting, heart rate, gestures or identification. IEEE 802.11bf (sensing) was published in Sept 2025 ([IEEE SA](https://standards.ieee.org/ieee/802.11bf/11574/)); the ESP32 doesn't implement it.

### B.2 Feasibility by capability

| Capability | Single-link amplitude | Evidence / note |
|---|---|---|
| Motion | Robust | Every product and paper; ESPectre reports F1 ≈ 0.99 on own recordings ([report](https://github.com/francescopace/espectre/blob/main/docs/performance/README.md)) |
| Presence, moving person | Robust | Same |
| Presence, still person | Good with fresh empty baseline + breathing-band energy | Fails with baseline drift or far from the link |
| Breathing rate (still) | Good | ESP32 sleep studies report about 1 bpm error (abstract-level figures, verify) |
| Breathing stopped | Usable with gating | Rule on the person's own envelope baseline |
| Heart rate | Not credible | Claimed in lab only (e.g. PulseFi, [arXiv 2510.24744](https://arxiv.org/abs/2510.24744)); do not demo |
| Fall (staged) | Good in the trained room | Papers: about 87–94 % detection, 10–18 % FA (WiFall / RT-Fall, Intel 5300); FallDeFi drops about 93 → 80 % in new rooms |
| Fall → not getting up | Robust-ish | The commercial "spike → inactivity" pattern |
| Transitions (sit / stand / lie down / get up) | Good in the trained room | Distinct motion signatures |
| Static posture | Weak | Learns position, not posture |
| Count 0 / 1 | Good | Same as presence |
| Count 2+ | Weak; only when people move | Papers with 1–10 people report 45–56 % |
| Sleep / wake, restlessness | Robust | Motion counts at night; what products ship |
| Sleep stages | Research only | Multi-antenna CSI ratio |
| Bed exit / in bed | Good with the link across the bed | Baseline "bed empty" vs "in bed" + `get_up` event |
| Coarse zone (2–3 zones) | Fragile, per room | Drifts; needs several nodes to be reliable |
| Entry/exit direction | Unreliable | Doorway link + presence change instead |
| Gait identification | Lab only; legal risk | Avoid |
| Gestures | Not with this hardware | Skip |

### B.3 Recommended model set

Mapped to the plan's components. "Model" includes rules and statistics; not
everything should be a neural network.

| # | Priority | Output | Approach | Profiles | Replaces / adds |
|---|---|---|---|---|---|
| 1 | Must | **Presence** (incl. still person) | Static deviation + breathing-band energy + motion → hysteresis FSM | all | Fixes audit #2 |
| 2 | Must | **Motion level** | As planned (variance), plus CV feature for gain robustness | all | — |
| 3 | Must | **Breathing rate** | As planned (30 s FFT, PCA of top subcarriers); decimate to 10 Hz before filtering, SOS form | Home, Clinic | — |
| 4 | Must | **Breathing cessation** | 10 s envelope vs own 60 s baseline, gated by presence + stillness | Home, Clinic | Fixes audit #6 |
| 5 | Must | **Fall → inactivity** | Stage 1 rule: motion spike. Stage 2: stillness 10–30 s, breathing still present → `fall`. No recovery → `fainted_suspected`. Optional small verifier on the spike window | all | Fixes audit #4 |
| 6 | Must | **Baseline drift detector** | Track the static amplitude profile during confirmed-empty periods; if it shifts, flag "recalibrate" and re-baseline automatically | all | New; makes `rolling` unnecessary |
| 7 | Must | **Long inactivity / routine anomaly** | Per-hour motion histogram over days; alert on "no motion by 10:00", "present but no motion for N h in daytime", unusual night activity | Home | New; cheap and the most-sold elderly-care feature |
| 8 | Should | **Transitions + walking** (M2 v2) | Classes `none`, `walking`, `sit_down`, `stand_up`, `lie_down`, `get_up`; posture via state machine | all | Replaces 4-class posture |
| 9 | Should | **Bed exit / in bed** | Setup records "bed empty" and "in bed" fingerprints; `get_up` while in bed → `bed_exit` event | Clinic (Home at night) | New; high value for fall prevention |
| 10 | Should | **Sleep / restlessness** | Motion counts per minute while in bed at night → sleep/wake, restlessness index, breathing-rate trend | Home, Clinic | New; reuses 2 + 3 |
| 11 | Could | **Count 0 / 1 / 2+** (M1) | 1D CNN or GBM; smooth over 30–60 s; display "1 / several" | School | As planned, but lower priority; for School consider `empty / occupied / busy` |
| 12 | Could | **Occupancy level** (School) | Activity-energy statistics over minutes → `empty / low / busy` | School | Honest alternative to counting |
| — | Skip | Heart rate, gestures, gait ID, sleep stages, fine localization | — | — | Not credible on this hardware, or a legal risk |

**New events this implies for `results.schema.json`:**
- `bed_exit`
- `long_inactivity`
- `recalibrate_needed`
- `breathing_irregular` (optional): high variance of breath-to-breath intervals

**New profile settings:**
- Home: inactivity thresholds per time of day.
- Clinic: `bed_exit` alert level.

### B.4 How to train the learned models (8, 11) on little data

1. **Start with a gradient-boosting baseline** (LightGBM) on hand-crafted window features:
   - per-subcarrier / PCA variance;
   - band energies 0.1–0.5, 0.5–2 and 2–10 Hz;
   - max first difference, kurtosis, spectral entropy;
   - cross-subcarrier correlation.

   At under about 1k labelled windows this often matches a CNN. It is interpretable and trains in seconds. If a GBM wins, export it with `onnxmltools` / `skl2onnx`: same ONNX contract, no engine change.
2. **1D CNN**: subcarriers or 8–16 PCA components as channels, about 3 conv blocks, **< 100 k parameters** (the plan's 1 M is more than the data can support), **BatchNorm** so AdaBN works.
3. **Augmentation** grounded in the hardware:
   - amplitude scale;
   - per-subcarrier gain jitter;
   - injected AGC steps;
   - time warp ± 10 %;
   - packet-loss gaps before resampling.
4. **Self-supervised pre-training** (optional): masked reconstruction or contrastive learning on hours of unlabelled recordings from your rooms. This is the realistic replacement for `synth.py` pre-training.
5. **Evaluation:** leave-one-session-out *and* leave-one-room-out. Report within-room vs new-room, before and after adaptation. That comparison is a strong slide.
6. **Smoothing and calibration:** temperature scaling, `uncertain` class, HMM over windows (audit #17).

**On-site adaptation, upgraded `onsite_adapt`:**

| Step | Data | Time | Effect |
|---|---|---|---|
| Empty-room baseline | 2 min, unlabelled | 2 min | Largest single gain |
| **AdaBN**: recompute BatchNorm statistics ([arXiv 1603.04779](https://arxiv.org/abs/1603.04779)) | 5–10 min of normal activity, unlabelled | seconds | Cheap domain adaptation, no labels |
| Few-shot fine-tune of the **classifier head only** | 30–60 s per class, guided script | about 1 min CPU | Large gains reported (e.g. ReWiS, [arXiv 2201.00869](https://arxiv.org/abs/2201.00869)) |
| Compare on a *separate* 2 min pass | labelled | 2 min | Honest keep / reject decision |

Fine-tuning the whole network on 10 minutes risks overfitting; the head-only
approach is faster and safer. Tent / entropy minimisation ([arXiv 2006.10726](https://arxiv.org/abs/2006.10726)) is optional.

### B.5 Data sources

**Public datasets.** Datasets from Intel 5300 or Atheros cards (UT-HAR, NTU-Fi / SenseFi, MM-Fi, Widar3.0, SignFi) **don't transfer** to ESP32 amplitude features: different subcarriers, antennas and rates. They are useful only for comparing architectures. ESP32 datasets that may help pre-training and drift testing:

- [RF_ESP32_Dataset](https://github.com/Mohammed-Baqir/RF_ESP32_Dataset) (8 environments)
- ESP32 LOS/NLOS HAR ([Data in Brief 2024](https://www.sciencedirect.com/science/article/pii/S2352340924010631))
- [Embedded_WiFi_Sensing](https://github.com/AlbanyArmenta0711/Embedded_WiFi_Sensing) (HAR + breathing)
- Strohmayer's ESP32 through-wall HAR datasets

Map them to your 52 subcarriers and 50 Hz. Expect gains only for pre-training or warm-starting, not zero-shot use.

**Baselines to compare against** (and to borrow from):

- Espressif's [esp-radar](https://components.espressif.com/components/espressif/esp-radar): `wander` for presence, `jitter` for motion, empty-room threshold calibration.
- [ESPectre](https://github.com/francescopace/espectre):
  - coefficient-of-variation turbulence on 12 fixed subcarriers, Hampel filter;
  - an autocorrelation/IQR detector and a small MLP;
  - its docs on CSI layout, gain handling and router setup are directly relevant.

Showing "our presence detector vs esp-radar on the same recordings" makes a credible evaluation.

### B.6 Changes to section 5 (recordings)

- Replace "standing / sitting / lying 6–8 min each" with **transition repetitions**: 20+ each of `sit_down`, `stand_up`, `lie_down`, `get_up` per session, at several spots. Keep 2–3 min of each static state for the state machine and presence tests.
- Add **breath-holds** (15–30 s, with a chest reference) to test `no_breathing`.
- Add **bed recordings** (in bed, getting out, empty bed) if Clinic is in the demo.
- Add **hard negatives** for falls: sitting down hard, dropping objects, lying down quickly on a sofa or bed.
- Add **long unlabelled runs** (overnight, workdays): free data for FA/h, drift testing, routine statistics and self-supervised pre-training.
- The time budget drops if posture minutes are swapped for transition reps; budget about 60–75 min of active recording per session.

---

## Part C — Suggested edits to the plan, in order

1. **Contracts (before Step 1):**
   - event `state` (active / cleared);
   - new event types (`bed_exit`, `long_inactivity`, `recalibrate_needed`);
   - CSI config values and the LLTF/HT-LTF choice in `model_io.md`;
   - calibration mode in `meta.json` / ONNX metadata.
2. **Step 2:**
   - `esp_csi_gain_ctrl` for gains;
   - explicit `wifi_csi_config_t`;
   - `first_word_invalid` handling;
   - Bluetooth off;
   - router checklist.
3. **Step 3:**
   - presence FSM (static deviation + breathing energy + motion);
   - anti-alias filter;
   - per-boot clock fit;
   - breathing cessation detector;
   - rolling baseline frozen while present;
   - drift detector.
4. **Step 5:**
   - M2 → transitions + state machine;
   - GBM baseline;
   - CNN < 100 k params with BatchNorm;
   - `synth.py` limited to tests;
   - temperature scaling + HMM smoothing.
5. **Step 6:**
   - `fainted_suspected` requires a fall candidate and 20–30 s stillness;
   - `bed_exit`, `long_inactivity`;
   - FA/h with confidence intervals.
6. **Step 7:**
   - `onsite_adapt` = baseline + AdaBN + head fine-tune + separate validation pass.
7. **Section 8 / pitch:**
   - privacy-by-design and the "not a medical device" statement;
   - the within-room vs new-room adaptation result.
8. **Decide early:** Python engine vs C++ engine (audit #11), and the EduHack rules on pre-written code.
