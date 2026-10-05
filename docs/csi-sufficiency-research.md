# Is ESP32-S3 CSI Enough? Hardware Limits and Model Feasibility

This document answers two questions:

1. Does the ESP32-S3 give us all the data it can, and does our plan
   capture it?
2. Is that data enough to train models that give correct predictions?

It also audits the three existing docs
([implementation-plan.md](implementation-plan.md),
[plan-audit-and-model-research.md](plan-audit-and-model-research.md),
[build-guide.md](build-guide.md)) against primary sources.

**Scope note.** No device logs exist yet: there are no `.csirec`, serial or
CSV captures in the repo or its history. Every hardware number below comes
from ESP-IDF source, Espressif components, ESPectre's published
measurements and papers, not from our own ESP32. Section 6 lists what to
log on the first capture so these numbers can be confirmed on our hardware.

**Tags:**

| Tag | Meaning |
|---|---|
| **[V]** | Checked in the primary source: header, docs, component zip or full paper |
| **[A]** | Checked in an abstract or repo page only |
| **[I]** | Our inference from the sources |

References are listed at the end; numbers in brackets point to them.

---

## 1. Short answer

**The hardware gives enough data for a credible single-room demo of:**
- motion;
- presence, including a still person, with conditions;
- breathing rate when the person is still and placed correctly;
- fall followed by not getting up, within the trained room;
- walking and posture transitions.

**It does not give enough data for:**
- reliable 1 vs 2+ person counting;
- apnea alerts that are safe to rely on;
- falls that generalise to new rooms without re-training;
- heart rate.

These limits come from the hardware: one antenna, one link, 2.4 GHz. More
data or better models will not remove them.

**Our plan captures most of what the chip offers, but loses some of it:**
- it uses HT-LTF only, so it drops LLTF and the 108-subcarrier option;
- it reads gain from the wrong source;
- it ignores phase, which the raw buffer already contains;
- it does not guard against a router configured for HT40.

All of these can be fixed in firmware or the engine at no hardware cost
(section 5).

**The cheapest large improvement is a second ESP32 link (~€10).** It
addresses the weakest outputs: still presence, breathing blind spots and
counting (section 5.3).

**Where to look:**
- Section 7 shows which ESP32 data feeds which model.
- Section 8 lists what can be fixed, what can't, and what each output
  will look like on one or two ESP32s.

---

## 2. What the ESP32-S3 can and cannot provide

### 2.1 Available data

| Data | Detail | Source |
|---|---|---|
| Radio | 1T1R, 802.11b/g/n, 2.4 GHz, 20/40 MHz | [V R6] |
| CSI per packet | int8 `[imag, real]` per subcarrier; order LLTF → HT-LTF → STBC-HT-LTF | [V R3] |
| LLTF | 52 usable subcarriers (±1…±26); present in **every** frame type, legacy and HT | [V R3, R8] |
| HT-LTF (HT20) | 56 subcarriers (±1…±28), pilots at ±7/±21; HT frames only | [V R3, R8] |
| Buffer size | non-HT 128 B; HT20 256 B; HT20 STBC 384 B. With a secondary channel set: HT40 384 B, HT40 STBC **612 B** | [V R3] |
| `rx_ctrl` | `rssi`, `rate`, `sig_mode`, `mcs`, `cwb`, `stbc`, `sgi`, `channel`, `secondary_channel`, `timestamp` (32-bit µs), `noise_floor`, `ant` (1 bit), `sig_len`, `rx_state` | [V R1] |
| `wifi_csi_info_t` | also `mac`, `dmac`, `first_word_invalid`, `rx_seq`, `hdr`, `payload` | [V R1] |
| AGC / FFT gain | no named field; read with `esp_csi_gain_ctrl_get_rx_gain(rx_ctrl, &agc, &fft)` (component v0.1.5, enabled on S3/C3/C5/C6/C61) | [V R7] |
| Packet rate | ping at 100 pps → **92–100 CSI/s**; only 55–66 % of intervals within 8–12 ms; gap p95 ≈ 15 ms, p99 ≈ 17 ms; 1–2 gaps ≥ 20 ms per 17 s | [V R12, R13] |

### 2.2 Data the hardware cannot provide

| Missing | Why | What it rules out |
|---|---|---|
| Phase difference between antennas | one RX chain; antenna switching via `esp_phy_set_ant` is time-multiplexed, each packet has its own random phase | AoA, conjugate multiplication, Anti-Fall-style phase segmentation [V R4, R17; I] |
| Absolute phase / ToF | PLL phase is random after reset or LO change; linear detrending removes it together with ToF | ranging, localization [V R17, R18] |
| Signed Doppler | needs coherent phase | walking direction, entry vs exit, signed velocity |
| MIMO matrix | 1 stream | separating 2+ people, multi-person breathing [A R19-lit] |
| 5 GHz / HE-LTF | S3 lacks `acquire_csi_*`; only C5/C6/C61 have it (C5: 5 GHz, HE20 −122…+122) | the shorter-wavelength, wider-band option [V R1, R2] |
| Fall Doppler peak | a falling adult reaches 32–56 Hz Doppler at 2.4 GHz; Nyquist at ~95 Hz is ~47 Hz, so the peak aliases. The energy burst (mostly < 14 Hz) survives | fine-grained fall kinematics [V L10] |

### 2.3 Usable phase on one antenna

Raw phase is unusable, but a **cross-subcarrier CSI ratio** cancels the
common random offset. SA-WiSense did this on an ESP32 and went from
amplitude-only blind spots (2 of 5 positions failing, near 0 at 8 m) to
≥ 91 % respiration detection at every position up to 8 m [V L2].

**Caveat:** SA-WiSense used **HT40 with 218 subcarriers**. The method
needs a path-length difference above about 4.1 m at 40 MHz, roughly double
that at 20 MHz [V L2; I]. So the gain at HT20 in a small room is
uncertain. It is cheap to test, because our `.csirec` already stores raw
I/Q.

---

## 3. Per-task verdict

"Single-link ESP32" evidence is rare. Most strong numbers use several
ESP32 nodes or multi-antenna Intel cards; the table says which.

| Task | Best ESP32 evidence | Cross-room / cross-day | Verdict |
|---|---|---|---|
| **Motion** | ESPectre, 5 ESP32 variants: F1 0.979–1.0, FP 0–2.2 % (self-reported) [V L8] | recall > 90 %, FP < 10 % on weak signal [V L8] | **Sufficient** |
| **Presence, moving** | same | same | **Sufficient** |
| **Presence, still** | OpenCSI: empty vs static F1 0.986–0.993, but with **8 nodes / 56 links** at 20 Hz [V L6] | cross-room F1 0.90–0.98 after per-link z-score + 120 s empty bootstrap [V L6] | **Sufficient with conditions:** fresh empty baseline, breathing-band energy, person near the link. No single-link result exists, so we must measure it |
| **Breathing rate** | ESP32 sleep study: mean error **2.6 bpm** (1.38 normal, 2.98 slow) [A L3]; SA-WiSense ≥ 91 % within 1 bpm, but HT40 + phase ratio [V L2] | none on ESP32 | **Sufficient with conditions:** still person, 0.3–1.5 m from the line of sight, facing the link, ≤ 2–4 m for amplitude-only [V L16, L17] |
| **Breathing stopped** | no clinical validation on ESP32; UbiBreathe 92 % (RSS, 1 AP) [V L15] | none | **Insufficient as a safety alarm.** A Fresnel blind spot or the person shifting looks the same as apnea. Usable as a "breathing signal lost" flag with the gating in the audit |
| **Fall** | ESP32 study F1 98.5 % with 10-fold CV, which is a leakage risk [A L39]; CSI-Bench puts ESP32-S3 falls in its "Hard" tier, in-distribution F1 ~95 % across all devices [V L9] | Intel 5300: FallDeFi 93 → ~80 %; Anti-Fall after a sofa move: detection 83 → 76 %, FP 9 → **34 %** [V L11, L14] | **Sufficient with conditions** in one room with our own staged falls. **Insufficient** across rooms without `onsite_adapt` |
| **Count 0 / 1** | same as presence | — | **Sufficient with conditions** |
| **Count 2+** | Wi-CaL: MAE 0.41, but **4 ESP32 links**, people walking; a single link is worse [V L7] | lower across days [V L7] | **Insufficient** on one link, especially with still people |
| **Walking** | 3DO (ESP32-S3, through-wall): 98 % day 1 [V L5] | 85–87 % on days 2–3 [V L5] | **Sufficient** |
| **Static posture** | 3DO sitting / lying within the 3 classes; 1 subject [V L5] | −11 to −13 points day to day; LOS→NLOS 36–59 % [V L4, L5] | **Sufficient with conditions** in one room and one day; the audit's switch to transitions plus a state machine is the right call |
| **Transitions** | no ESP32 single-link study; Anti-Fall's segmentation needs 2-antenna phase [V L11] | — | **Plausible, unproven.** Must be measured on our data |
| **Heart rate** | PulseFi MAE ~0.5 bpm, but windows with a 1-packet stride are randomly shuffled into train/test, so the result leaks [V L1] | no cross-subject test | **Insufficient.** Do not demo |

### 3.1 Sample rate

- **Breathing:** about 10 Hz is enough [V L15]. Our ~95 Hz has plenty of
  margin.
- **Falls and activities:** WiFall, RT-Fall and Anti-Fall all used
  100 pps [V L11, L14].
- **Below 100 Hz:** a 2026 study reports losses below 100 Hz, and large
  losses when the training rate differs from the deployment rate
  (93.6 % → 55.1 %) [V L22].
  - **Consequence:** keep resampling to one fixed grid, as planned.
  - Also record the measured rate per session, and **do not lower the ping
    rate at the venue** without re-training.
- **Effective dimensionality** [I]: indoors, adjacent 312.5 kHz subcarriers
  are strongly correlated, so 52 amplitudes carry only a handful of
  independent components. This supports small models and PCA inputs
  (< 100 k parameters, as the audit recommends) over the plan's 1 M.

### 3.2 Data volume and drift

- **ESP32 HAR datasets are small:** about 1.8k samples (Wallhack), 42 × 5
  min (3DO), 60–170 min (Wi-CaL) [V L4, L5, L7]. The plan's section 5
  volume is in the same range, so it is reasonable for within-room results.
- **More data helps only a little:** Wi-CaL counting MAE went 0.47 → 0.41
  as data per scenario grew from 30 to 120 s [V L7].
- **Pretraining:** CSI foundation-model work says data, not model size, is
  the bottleneck [V L27], but none of that data is ESP32. Public ESP32
  datasets help only for pretraining or warm-starting (list in
  [plan-audit §B.5](plan-audit-and-model-research.md); additions: 3DO,
  OpenCSI, ESP-Fi HAR, CSI-Bench [V L5, L6, L9, L34]).
- **Drift:** expect −10 to −15 points day to day and after furniture moves
  on ESP32 [V L5, L11, L29]. This is the strongest argument for the
  baseline drift detector and `onsite_adapt`.

---

## 4. Audit of the existing docs

### 4.1 Factual corrections

| Doc / claim | Verdict | Correct statement |
|---|---|---|
| audit A.2 #12–16, build-guide §1.5: "ESP32-S3 at 100 pps ≈ 88 Hz (83–90)" | **Wrong / unsourced** | ESPectre measures 92–100 CSI/s, with heavy jitter: gap p95 ≈ 15 ms, 1–2 gaps ≥ 20 ms per 17 s [V R12]. The real risk is jitter, not mean rate, so the "mark gaps > 50 ms invalid" rule (build-guide §2) is fine but rarely triggers |
| build-guide §1.3: "`len ≤ 384`" | **Wrong in general** | Up to 612 B with HT40 STBC. Size the buffer at 612, or reject frames with `secondary_channel ≠ 0` [V R3] |
| audit #13, build-guide §2: "buffer order 0..31 then −32..−1" | **Conditionally right** | Only when the secondary channel is none. If the router is set to HT40, even 20 MHz frames use a 0..63 / −64..−1 layout [V R3]. `setup.md` must force 20 MHz on the router, and the engine must check `secondary_channel` |
| audit #1, plan §3.1: no gain in `rx_ctrl` | **Right, but incomplete** | The component reads gain from reserved `rx_ctrl` bits [V R7]. Its `set_rx_force_gain` "may cause packet loss", and ESPectre reverted gain lock [V R15]. Keep AGC on and use the scale-free feature path |
| audit B.2 / B.4: "cross-room accuracy falls to 40–70 % (arXiv 2503.08008)" | **Not in the source** | Use cited numbers instead: Wallhack cross-domain 30–59 % [V L4]; CSI-Bench cross-device 87.8 → 66.3 % [V L9] |
| audit B.2: "count papers with 1–10 people report 45–56 %" | **Misattributed** | 39–56 % is multi-person *gait identification* [A L21]. Counting: Wi-CaL MAE 0.41, 81.8 % within ±1, on 4 links [V L7] |
| audit B.2: "ESP32 sleep studies ≈ 1 bpm error" | **Overstated** | 2.6 bpm mean, 1.38 for normal breathing [A L3] |
| audit B.2: PulseFi heart rate | **Real, but leaky** | Random window split; cite only as "lab claim" [V L1] |
| build-guide §0: `esp_csi_gain_ctrl_get_gain_compensation` | **Right** | v0.1.5; prebuilt for IDF 4.4, 5.0–5.5, 6.0. An unlisted minor version would have no library, so pin the IDF version [V R7] |
| Antenna switching via `esp_wifi_set_ant` (if anyone tries it) | **Deprecated** | Use `esp_phy_set_ant`; it is gone from IDF master [V R5] |
| WiFall/RT-Fall/FallDeFi, UbiBreathe τ, Anti-Fall μ+6σ, ReWiS, RF-Diffusion, 802.11bf (26 Sep 2025), field layout, `ltf_merge_en`, `channel_filter_en`, `first_word_invalid`, 32-bit timestamp | **Correct** | [V L11–L15, L25, L26, R1, R3] |

### 4.2 Consistency between the docs

- **The plan was never updated after the audit.** `implementation-plan.md`
  still has:
  - presence = motion variance (audit blocker #2);
  - gains read from `rx_ctrl` (blocker #1);
  - 4-class static posture;
  - `rolling` calibration with no freeze;
  - `fainted_suspected` on `lying` + 10 s;
  - a 1 M-parameter budget.

  Commit `ef41753` *added* synthetic pre-training to the plan about an
  hour before the audit recommended against it. Whoever builds from the
  plan alone will build the version the audit rejected.
  **Fix:** fold Part C of the audit into the plan, or mark the plan
  superseded by the build guide.
- **Unresolved LLTF vs HT-LTF choice:**
  - the plan says HT-LTF only;
  - the audit says use LLTF as a fallback;
  - the build guide leaves it as a `model_io.md` setting.

  Espressif's own `csi_recv_router` example uses **LLTF only**, "to ensure
  the compatibility of routers" [V R9]. LLTF and HT-LTF are different
  effective channels when the router has several antennas (cyclic shift
  diversity differs between the legacy and HT parts) [I R3], so they must
  never be mixed in one model input.
  **Decision needed** (recommendation in 5.1).
- **Unresolved engine language.** Python vs C++ is still open in both the
  audit (#11) and the build guide (§9). It decides whether half of
  section 3.6 of the plan exists.

---

## 5. What to change so the data is enough

### 5.1 Capture everything the chip gives (firmware, no cost)

1. **Forward the full CSI buffer** (LLTF + HT-LTF) plus `rx_ctrl.timestamp`,
   `rx_seq`, `ant`, `secondary_channel`, `sgi` and the gain values from
   `esp_csi_gain_ctrl`. Decide in the engine what to use. Raw I/Q in
   `.csirec` keeps the phase-ratio and 108-subcarrier options open without
   re-recording.
2. **Make LLTF the primary model input** (present in every frame, the
   Espressif default for router traffic). Keep HT-LTF as a second,
   separately trained variant if it tests better. Never average them:
   `ltf_merge_en = 0`.
3. **Set `wifi_csi_config_t` explicitly:**
   - `channel_filter_en = 0`;
   - `manu_scale = 1` with a fixed `shift`.

   Choose `shift` on the first capture so the strongest subcarrier stays
   well under ±127 with no clipping, while typical amplitudes stay above
   about 10 LSB. int8 resolution is coarse for the ~1 % amplitude change
   breathing causes [I], so dynamic range matters.
4. **Router:**
   - 20 MHz only, so `secondary_channel = 0`;
   - fixed channel;
   - TxBF off;
   - no band steering.

   Log the router model and antenna count per session.
5. **Bluetooth off; `WIFI_PS_NONE`.** Default power save is
   `WIFI_PS_MIN_MODEM` [V R5].

### 5.2 Engine features that use the data better

- **Breathing:** add a cross-subcarrier CSI-ratio phase path next to
  amplitude PCA, and pick whichever has higher spectral confidence per
  window [V L2; I].
- **Presence and motion:** keep the scale-free path (CV / profile
  correlation) as the gain-robust default [V R15].
- **Resampling:** fixed 50 Hz grid, as planned. Store the measured mean
  rate and jitter in `meta.json`, and refuse models trained at a
  different nominal rate.

### 5.3 Hardware options, ranked by value for cost

| Option | Cost | Fixes | Evidence |
|---|---|---|---|
| **Second ESP32-S3 node** on a different link (e.g. across the bed or perpendicular) | ~€10 | still presence, breathing blind spots (a second Fresnel geometry), 0 / 1 / 2+ estimate, fall robustness | multi-link systems are the ones with strong counting / presence numbers [V L6, L7]; Fresnel zones differ per link [V L16] |
| External-antenna `-1U` module | ~€3 more | link budget, range | [V R6; audit] |
| ESP32-C5 instead of S3 | ~€10 | 5 GHz (shorter wavelength, stronger breathing phase), HE-LTF up to 245 subcarriers, 12-bit LLTF | [V R2, R3, R11]; needs IDF 5.5+, and the gain library only for 5.5/6.0 [V R7] |
| Router with a 40 MHz clean channel | — | the SA-WiSense phase-ratio range result | [V L2]; 2.4 GHz HT40 is rarely clean |

Adding a second node fits the existing contract: `node_id` is already
there. Train per node and fuse at the decision level, so one node still
works alone.

### 5.4 Model and evaluation changes

- Follow the audit's model set (B.3). This research supports it:
  - presence FSM, breathing, cessation flag and fall → inactivity are the
    feasible core;
  - transitions are plausible;
  - count 2+ and static posture stay "could".
- **Avoid leaky evaluation:** papers that report 95–99 % on ESP32 often use
  random window splits (PulseFi, the 10-fold fall study). Our
  session-level split will give lower, honest numbers. Say so on the slide.
- Report within-room, cross-day and cross-room results separately.
  Published ESP32 drops are 10–15 points cross-day [V L5]. If ours are
  similar, that is a normal result, not a failure.

---

## 6. First-capture checklist

Turn these into real logs as soon as the firmware streams (plan Step 2),
then rerun this audit on them.

| Measure | How | Pass |
|---|---|---|
| Rate and jitter | 10 min idle capture; `host_rx_us` deltas | ≥ 90 Hz mean; gap p99 < 25 ms; loss < 5 % |
| Frame mix | histogram of (`sig_mode`, `cwb`, `stbc`, `secondary_channel`, `len`) | ≥ 95 % one layout; `secondary_channel = 0` |
| Clipping / scale | histogram of raw int8 I/Q per subcarrier | < 0.1 % at ±127; median amplitude > 10 |
| AGC behaviour | `agc` / `fft` over 10 min, empty room, then walk-through | log step size and frequency; check the CV path is flat across steps |
| Empty-room stability | profile correlation `S` over 30 min empty | sets `T_S` thresholds; check drift |
| Still-person presence | 5 min sitting still at 3 distances from the link | `S` or `B` separates from empty at every spot |
| Breathing blind spots | paced breathing at 5 positions (on, 0.5 m, 1 m, 2 m off the line of sight) × amplitude vs CSI-ratio | which positions reach ±2 bpm; decides placement and whether the phase path is worth it |
| Gap between LLTF and HT-LTF | same recording, both LTFs | pick the model input (section 5.1) |

---

## 7. What data is used, and for which model

### 7.1 From ESP32 fields to signals

Every model is built from a small set of signals the engine derives from
the raw ESP32 packet.

| ESP32 data | Derived signal | Used for |
|---|---|---|
| LLTF I/Q, 52 subcarriers | **Amplitude** `A[52]`, gain-compensated, Hampel-filtered, resampled to 50 Hz, z-scored against the empty room | main model input `[150, 52]`; motion; breathing; fall burst |
| LLTF I/Q | **Scale-free profile** `p = A / mean(A)` and **turbulence** `std(A)/mean(A)` | presence (static deviation `S`), motion backup, drift, bed exit; works even if gain compensation is wrong |
| I/Q across subcarriers | **CSI-ratio phase** | second breathing path (blind-spot test, section 2.3) |
| HT-LTF I/Q, 56 subcarriers | alternative amplitude | second model variant, only if it tests better (section 5.1) |
| `agc`, `fft` gain via `esp_csi_gain_ctrl` | gain compensation; AGC-step flag | cleaning `A`; marking windows with a gain jump |
| `rssi`, `noise_floor` | link quality | device-health tile, `sensor_offline`; **not** a model input |
| `sig_mode`, `cwb`, `stbc`, `secondary_channel`, `len` | frame-layout filter | dropping frames with a different layout |
| `rx_ctrl.timestamp` / `esp_timer`, `host_rx_us` | clock map → uniform 50 Hz grid | every time-based feature; aligning labels |
| `seq`, `rx_seq`, `boot_id` | loss rate, reboot detection | stream health; never interpolating across a reboot |
| 1 Hz firmware status packet | heap, queue drops, uptime | `sensor_offline`, device health |

### 7.2 Model map

"Rule" and "stat" models need no training data, only thresholds tuned on
recordings. "Learned" models need labelled recordings (plan section 5,
audit B.6).

| # | Model | Kind | Input signals | Window | Output / event | Profiles | Feasible on 1 ESP32? |
|---|---|---|---|---|---|---|---|
| 1 | **Presence FSM** | rule | `S` (profile vs empty), `B` (breathing-band energy), `M` (motion) | 10–30 s | `presence` {EMPTY, PRESENT} | all | **Yes**, with conditions: still person near the link, fresh baseline |
| 2 | **Motion level** | stat | variance of z-scored `A` over 0.5 s; turbulence | 0.5–1 s | `motion` 0–1 | all | **Yes** |
| 3 | **Breathing rate** | DSP | `A` decimated to 10 Hz → top-8 subcarriers → PC1 (or CSI-ratio phase) → 0.1–0.5 Hz FFT | 30 s | `breathing.bpm`, `confidence`, `wave` | Home, Clinic | **Yes**, with conditions: still, placed 0.3–1.5 m from the link, ≤ 2–4 m away |
| 4 | **Breathing-lost flag** | rule | envelope of PC1 vs the person's own 60 s reference, gated by presence + stillness | 10–15 s | `no_breathing` (active / cleared) | Home, Clinic | **As a flag only.** Not a safety alarm |
| 5 | **Fall → inactivity** | rule + optional GBM verifier | `M` spike; burst features (variance ratio, 2–20 Hz energy, burst length, max diff, kurtosis); then stillness + presence held | 3 s burst, then 3–30 s | `fall`, `fainted_suspected` | all | **Yes in the trained room**; cross-room needs `onsite_adapt` |
| 6 | **Baseline drift** | stat | `1 − cos(p, p_base)` during confirmed-empty periods; Page–Hinkley | 30 s steps | `recalibrate_needed`; auto re-baseline | all | **Yes** |
| 7 | **Long inactivity / routine** | stat (server) | motion-minutes per hour from stored results | days | `long_inactivity` | Home | **Yes** (needs history; demo seeds it) |
| 8 | **Transitions + walking (M2)** | learned: LightGBM baseline → 1D CNN < 100 k params | `[150, 52]` z-scored LLTF amplitudes (or 8–16 PCs) | 3 s, 0.5 s hop | `sit_down`, `stand_up`, `lie_down`, `get_up`, `walking`, `none` → posture state machine | all | **Plausible**, must be measured; walking is reliable |
| 9 | **Bed exit / in bed** | rule | `p` vs recorded `p_in_bed` / `p_empty_bed`; `get_up` from M2 | 10–60 s | `bed_exit` | Clinic, Home at night | **Yes**, if the link crosses the bed |
| 10 | **Sleep / restlessness** | stat | motion counts per minute (Cole–Kripke) + breathing trend | 1 min epochs | sleep/wake, restlessness index | Home, Clinic | **Yes** |
| 11 | **Count 0 / 1 / 2+ (M1)** | learned: LightGBM / CNN | same `[150, 52]` input, smoothed over 30–60 s | 3 s → 30–60 s | `count` | School | **0 / 1 yes; 2+ only as a rough estimate** |
| 12 | **Occupancy level** | stat | activity energy over minutes | minutes | `empty / low / busy` | School | **Yes**; the honest alternative to counting |
| — | Heart rate, gestures, localization, identification | — | — | — | — | — | **No** (section 2.2) |

**Training data.** Learned models (8, 11 and the optional fall verifier)
train on the engine's `--dump-features` output (`[T, 52]` amplitudes +
timestamps) and `labels.jsonl`. Rules and stats (1–7, 9, 10, 12) are tuned
with `engine --evaluate` on the same recordings. RSSI and the status
packet are never model inputs; they only drive health and alerts.

---

## 8. What can be fixed, and what the ESP32 gives us after the fixes

### 8.1 Fixable problems

All of these are firmware, engine, configuration or a ~€10 part.

| Problem | Fix | Where | What it unlocks |
|---|---|---|---|
| Gain read from a field that doesn't exist | `esp_csi_gain_ctrl` + scale-free features | firmware, engine | stable amplitudes for every model |
| Default CSI config smooths subcarriers and auto-scales | explicit `wifi_csi_config_t` (5.1) | firmware | clean per-subcarrier features |
| HT-LTF only; legacy frames dropped | forward the full buffer; LLTF as primary input | firmware, engine | more usable frames, one consistent input |
| Router at 40 MHz changes the layout | router at 20 MHz; engine checks `secondary_channel` | setup, engine | no garbage frames |
| Uneven packet timing (gap p95 ≈ 15 ms) | host-clock fit, resample to 50 Hz, mark long gaps | engine | correct time features and label alignment |
| Clipping / coarse int8 values | choose a fixed `shift` on the first capture | firmware | breathing signal above quantization noise |
| Still person reads as "nobody" | presence FSM (model 1) | engine | still presence, posture, `no_breathing` become possible |
| `rolling` calibration absorbs a still person | freeze the baseline while present + drift detector (model 6) | engine | presence survives a long stay |
| `fainted_suspected` fires for anyone resting | require a fall candidate + 20–30 s stillness | engine | usable alerts in Home and Clinic |
| `no_breathing` takes 35–45 s | 10–15 s envelope detector (model 4) | engine | faster flag |
| Breathing blind spots | placement rules + CSI-ratio phase path; second node | setup, engine, hardware | breathing at more positions |
| Static posture learns position, not posture | transitions + state machine (model 8) | ml, engine | a posture output that generalises better |
| Accuracy drops in a new room | empty baseline + AdaBN + head fine-tune (`onsite_adapt`) | ml, scripts | recovers most of the drop in ~15 min |
| Inflated accuracy from random splits | session-level and room-level splits | ml | honest numbers |
| Weak 1-link counting and still presence | **second ESP32 node** (5.3) | hardware | better 0 / 1 / 2+ estimate and presence |

### 8.2 Not fixable on this hardware

| Limit | Why | What would fix it |
|---|---|---|
| Heart rate | signal far below what one int8 amplitude link resolves; no credible result | not in scope |
| Reliable 2+ count with still people | one link mixes everyone into one signal | 3–4 nodes, people moving |
| Separate breathing for 2 people | needs multiple antennas to separate sources | multi-antenna hardware |
| Location, direction, entry vs exit | no phase across antennas, no ToF | several nodes or multi-antenna hardware |
| Clinical apnea detection | blind spots look like apnea; no validation; medical-device regulation | out of scope; "assistive flag" only |
| Gestures, identification | no phase, legal risk | skip |

### 8.3 What we get

| Output | One ESP32 after the fixes | Two ESP32s after the fixes | Demo status |
|---|---|---|---|
| Motion | reliable (F1 ≈ 0.98–1.0 in published ESP32 tests) | same | **show** |
| Presence, moving | reliable | same | **show** |
| Presence, still | good near the link with a fresh baseline | good across most of the room | **show**, placement matters |
| Breathing rate | ±2 bpm when still and placed well (published ESP32 mean error ≈ 1.4–2.6 bpm) | more positions covered | **show** in Home / Clinic |
| Breathing lost | assistive flag after 10–15 s | fewer false flags | **show as a flag**, not an alarm |
| Fall → not getting up | good in the trained room; cross-room needs `onsite_adapt` | more robust | **show** (staged fall on a mat) |
| Walking | reliable | same | **show** |
| Transitions / posture state | plausible; measure on locked test sessions | better | **show if** the test numbers hold; else `still / moving` |
| Bed exit, sleep, restlessness | good with the link across the bed | same | **show** in Clinic / Home |
| Long inactivity / routine | works (demo uses simulated history) | same | **show** |
| Drift / recalibrate | works | same | background feature |
| Count 0 / 1 | good | good | **show** |
| Count 2+ | rough estimate while people move | usable estimate | **show as "several"** or occupancy level |
| Heart rate, localization, gestures | no | no | **don't claim** |

**Bottom line.** With the fixes in 8.1, one ESP32-S3 delivers the Home and
Clinic core: presence including still people, motion, breathing rate, a
breathing-lost flag, fall followed by inactivity, bed exit, sleep and
routine. The School profile works as occupancy (empty / occupied / busy)
rather than an exact count. A second ESP32 is the one upgrade that moves
still presence, breathing coverage and counting up a level.

---

## References

**Hardware (R):**
R1 [esp_wifi_types_native.h](https://github.com/espressif/esp-idf/blob/master/components/esp_wifi/include/local/esp_wifi_types_native.h) ·
R2 [esp_wifi_he_types.h](https://github.com/espressif/esp-idf/blob/master/components/esp_wifi/include/esp_wifi_he_types.h) ·
R3 [ESP-IDF Wi-Fi vendor features (CSI)](https://github.com/espressif/esp-idf/blob/master/docs/en/api-guides/wifi-driver/wifi-vendor-features.rst) ·
R4 [PHY / antenna guide](https://github.com/espressif/esp-idf/blob/master/docs/en/api-guides/phy.rst) ·
R5 [esp_wifi.h v5.4](https://github.com/espressif/esp-idf/blob/release/v5.4/components/esp_wifi/include/esp_wifi.h) ·
R6 [ESP32-S3 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf) ·
R7 [esp_csi_gain_ctrl](https://components.espressif.com/components/espressif/esp_csi_gain_ctrl) ·
R8 [esp-radar](https://components.espressif.com/components/espressif/esp-radar) ·
R9 [esp-csi csi_recv_router](https://github.com/espressif/esp-csi/tree/master/examples/get-started/csi_recv_router) ·
R11 [ESPectre CSI.md](https://github.com/francescopace/espectre/blob/main/docs/CSI.md) ·
R12 [ESPectre ADR: managed CSI traffic](https://github.com/francescopace/espectre/blob/main/docs/adr/2026-08-23-standardize-managed-csi-traffic-sources.md) ·
R13 [ESPectre dataset quality](https://github.com/francescopace/espectre/blob/main/data/auto_generated/DATASET_QUALITY_CHECK.md) ·
R15 [ESPectre ADR: keep AGC active](https://github.com/francescopace/espectre/blob/main/docs/adr/2026-07-04-keep-agc-active-and-standardize-cv-normalization.md) ·
R17 [ESPARGOS phase coherence](https://arxiv.org/html/2502.09405v1) ·
R18 [CSI phase sanitization](https://tns.thss.tsinghua.edu.cn/wst/docs/sanitization/)

**Literature (L):**
L1 [PulseFi](https://arxiv.org/abs/2510.24744) ·
L2 [SA-WiSense](https://arxiv.org/abs/2507.17623) ·
L3 [ESP32 sleep breathing, Appl. Sci. 2024](https://doi.org/10.3390/app14156458) ·
L4 [Wallhack1.8k](https://arxiv.org/abs/2401.00964) ·
L5 [3DO / WiFlexFormer](https://arxiv.org/abs/2411.04224) ·
L6 [OpenCSI](https://arxiv.org/abs/2607.26665) ·
L7 [Wi-CaL counting](https://catalog.lib.kyushu-u.ac.jp/opac_download_md/7161171/7161171.pdf) ·
L8 [ESPectre performance](https://github.com/francescopace/espectre/blob/main/docs/performance/README.md) ·
L9 [CSI-Bench](https://arxiv.org/abs/2505.21866) ·
L10 [Chu 2023, fall Doppler](https://eprints.whiterose.ac.uk/id/eprint/202278/) ·
L11 [Anti-Fall](https://arxiv.org/abs/1507.01057) ·
L14 [Palipana thesis (FallDeFi, RT-Fall)](https://ambientintelligence.aalto.fi/sameera/pdfs/thesis_sameera_palipana_r00119847.pdf) ·
L15 [UbiBreathe](https://arxiv.org/abs/1505.02388) ·
L16 [Fresnel-zone respiration, UbiComp 2016](https://www-public.imtbs-tsp.eu/~zhang_da/pub/Daqing%202016%20UbiComp%20respiration.pdf) ·
L17 [FarSense](https://arxiv.org/abs/1907.03994) ·
L21 [Multi-person ESP32 identification](https://arxiv.org/abs/2601.02177) ·
L22 [CSI sampling-rate study 2026](https://arxiv.org/abs/2605.08308) ·
L25 [ReWiS](https://arxiv.org/abs/2201.00869) ·
L26 [RF-Diffusion](https://arxiv.org/abs/2404.09140) ·
L27 [CSI foundation-model scaling](https://arxiv.org/abs/2511.18792) ·
L29 [Long-term drift study](https://arxiv.org/abs/2212.10802) ·
L34 [ESP-Fi HAR](https://github.com/AutoSmartGroup/ESP-Fi-HAR) ·
L39 [Embedded ESP32 fall study](https://www.researchgate.net/publication/370933610)
