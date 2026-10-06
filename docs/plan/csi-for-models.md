# CSI for the Models

This document lists everything the models and detectors in
[plan-v2.md](plan-v2.md) need from the ESP32's Channel State Information
(CSI). It covers:

- which header fields are used;
- how the radio must be configured;
- where the values sit in the buffer;
- how they become features;
- which quality the signal must have;
- what each model consumes;
- what has to be measured on the real device before any of this is trusted.

Tags: **[V]** checked in a primary source (via the earlier docs), **[I]**
inferred, to be confirmed in §8, **[H]** heuristic starting value.

## Contents

1. What one CSI packet gives us
2. Radio and router configuration
3. Buffer layout and extraction
4. Preprocessing chain (the canonical feature stream `F`)
5. Quality gates
6. Derived signals
7. What each model needs
8. Phase 2 measurement checklist
9. What we deliberately don't use, and why
10. Calibration data
11. Data volumes
12. Recordings each model needs (summary)

---

## 1. What one CSI packet gives us

Every frame the ESP32 receives from the router carries known training
symbols. From those, the ESP32 estimates the complex channel per subcarrier.
`wifi_csi_info_t` delivers that estimate plus receive metadata. The plan
forwards it unchanged inside `csi_frame_hdr_t` v2 ([plan-v2 §4.1](plan-v2.md)).

| Field | Source on the ESP32 | Used for | Used by |
|---|---|---|---|
| `buf` (int8 `[imag, real]` pairs) | `wifi_csi_info_t.buf` | **The signal**: amplitude per subcarrier | everything |
| `first_word_invalid` | `wifi_csi_info_t` | Repair subcarrier +1 | extraction |
| `sig_mode`, `cwb`, `stbc`, `mcs` | `rx_ctrl` | Layout check; frame-type/MCS power check (§8) | validation |
| `agc_gain`, `fft_gain` | `esp_csi_gain_ctrl_get_rx_gain` [V per audit] | Analysis only (raw) | diagnostics |
| `gain_comp` | `esp_csi_gain_ctrl_get_gain_compensation` [V per guide] | Undo receiver gain jumps | extraction |
| `gain_valid` | firmware | Drop frames before the gain baseline exists | validation |
| `rssi_dbm`, `noise_floor_dbm` | `rx_ctrl` | Health tile; sanity check against the amplitude level | health |
| `src_mac` | `wifi_csi_info_t.mac` | Keep only frames transmitted by the router | validation |
| `rx_seq` | `wifi_csi_info_t.rx_seq` | Losses over the air (802.11 sequence gaps) | health |
| `seq` | firmware counter | Losses between ESP32 and laptop (UDP) | health |
| `ts_us` | `esp_timer_get_time()` (64-bit) | Exact sample timing → clock map | resampling |
| `boot_id` | `esp_random()` at boot | Detect reboots: reset clock, gain and filters | everything |
| `host_rx_us` | laptop clock at receipt | Label alignment; clock map | resampling, training |
| `csi_parts`, `csi_shift` | firmware | Find LLTF/HT-LTF in `buf`; record the scale | extraction |

Two things are **not** in `rx_ctrl`, whatever older docs suggest:

- **Gain values.** They come from the `esp_csi_gain_ctrl` component
  [V per audit].
- **A usable timestamp.** `rx_ctrl.timestamp` is 32-bit µs and wraps every
  ~71.6 min [V], so it is not used.

---

## 2. Radio and router configuration

The models are only valid for the configuration they were trained on. Every
value below goes into `model_io.md` and every `session.json`. Changing any
of them bumps `PIPELINE_VERSION`.

### 2.1 `wifi_csi_config_t` (ESP32-S3)

| Field | Value | Why the models care |
|---|---|---|
| `lltf_en` | 1 | LLTF is the signal we use (plan D2) |
| `htltf_en` | 1 | Sent for comparison in §8, and as a fallback |
| `stbc_htltf2_en` | 0 | Not needed. Saves 128 B per packet |
| `ltf_merge_en` | **0** | The default (1) replaces HT-LTF with an LLTF/HT-LTF average, so neither part is clean [V per audit] |
| `channel_filter_en` | **0** | The default (1) smooths neighbouring subcarriers, which couples them and hides the per-subcarrier detail the models use [V per audit] |
| `manu_scale` | **1** | Auto-scaling changes the amplitude scale **per packet**, which is noise for every feature [V per audit] |
| `shift` | measured in §8 (likely 2–6) [I] | Too high: int8 clipping. Too low: the small breathing changes get lost in quantisation |

### 2.2 Choosing `shift`

Done once in Phase 2, then fixed:

1. Put a person **at the closest point they will ever be** to the ESP32,
   moving. That is the strongest signal.
2. For each `shift` from 0 up, record 30 s and count the share of values
   with |re| or |im| ≥ 127.
3. Pick the **largest** shift with < 0.1 % saturated values [H].
4. Check at the far end of the room that the empty-room amplitude median is
   ≥ 8 int8 units on most subcarriers [H]. Below that, quantisation steps
   (1 unit ≈ 1 dB at an amplitude of 8) start to compete with the breathing
   modulation (often ≤ 0.5 dB [I]).

### 2.3 Firmware settings that change the CSI

| Setting | Value | Why |
|---|---|---|
| `esp_wifi_set_ps` | `WIFI_PS_NONE` | With power saving on, the station sleeps and the CSI rate collapses [V per plan] |
| Bandwidth | HT20 | One layout; the 52 LLTF subcarriers |
| AMPDU TX/RX | off [V per guide] | Every frame gives its own CSI callback; aggregated frames would give fewer and burstier samples |
| Bluetooth | off | BLE scanning makes the CSI bursty [V per audit] |
| Ping | gateway, ~100 Hz, forever | The router's replies are our CSI samples. ~88 Hz arrive [V per audit] |
| CSI callback | MAC filter = router BSSID | Only one transmitter, so one channel |
| Callback work | copy into a queue, never block | Blocking the Wi-Fi task loses frames [V per plan] |

### 2.4 Router settings

| Setting | Value | Why |
|---|---|---|
| Channel | fixed 2.4 GHz channel, chosen after a scan | Auto-channel changes the channel and so every subcarrier's response |
| Width | 20 MHz | Matches HT20 |
| Band steering / mesh | off | The ESP32 must stay on one transmitter |
| TxBF / MU-MIMO | off if possible | Beamforming precoding changes the HT-LTF between packets [V per audit]; less so for LLTF [I] |
| ICMP | allowed, not rate-limited | Otherwise the sample rate drops (§8) |
| Transmit power | fixed (no "auto") if the router allows it | Power changes look like gain steps |

---

## 3. Buffer layout and extraction

### 3.1 Layout (HT20, `lltf_en = htltf_en = 1`, no STBC)

| Frame type | `buf` content | Length |
|---|---|---|
| non-HT (`sig_mode = 0`) | LLTF | 128 B |
| HT (`sig_mode = 1`) | LLTF, then HT-LTF | 256 B |

[V per IDF docs, via the audit; confirm the HT-LTF offset on real data, §8]

Inside each 128-byte LTF block there are 64 subcarrier pairs, at index
`j = 0…63`:

- pair `j` = bytes `[2j] = imag`, `[2j+1] = real`, both int8 [V];
- subcarrier number: `k = j` for `j = 0…31`, and `k = j − 64` for
  `j = 32…63` [V].

### 3.2 Which subcarriers

We keep **k = −26…−1 and +1…+26**, which is 52 values:

| k | j (index in the block) | Keep? | Why |
|---|---|---|---|
| 0 | 0 | no | DC, carries no training symbol |
| +1…+26 | 1…26 | yes | data subcarriers |
| +27…+31 | 27…31 | no | guard / zero in LLTF |
| −32…−27 | 32…37 | no | guard / zero in LLTF |
| −26…−1 | 38…63 | yes | data subcarriers |

Output order is always `k = −26 … −1, +1 … +26`, i.e. column 0 is k = −26.
That order is the column order of `F` and of every model input.

### 3.3 Repairs

- **`first_word_invalid = 1`:** the first 4 bytes (j = 0 and j = 1, i.e.
  DC and k = +1) are invalid [V]. Copy k = +2 into k = +1.
- **Amplitude floor:** `a = max(1, sqrt(re² + im²))`, so the log is defined.
- **Saturation:** if |re| or |im| ≥ 127 on more than 2 subcarriers, count
  the frame as saturated. Saturated frames are kept, but the share is
  reported in health. A share above 0.1 % means `shift` is wrong.

---

## 4. Preprocessing chain (the canonical feature stream `F`)

One implementation (`lifefi.dsp`), causal, with state carried across
chunks. Every model and detector reads from its output.

| # | Step | Parameters | Why the models need it |
|---|---|---|---|
| 1 | Validate | magic, version, `hdr_len`, `n_values`, `cwb = 0`, LLTF present, router MAC, `gain_valid = 1` | One consistent signal source. Rejects are counted |
| 2 | Extract LLTF | §3 | The same 52 subcarriers in every frame type |
| 3 | Gain-compensate | `a · gain_comp` | Removes AGC steps **inside** a session, which would otherwise look like motion or falls |
| 4 | Log amplitude | `L = 20·log10(a · gain_comp)` dB | A gain change becomes an added constant, which every later feature cancels. This covers boot-to-boot scale changes and leftover compensation error |
| 5 | Clock map | per `boot_id`: `t_host = ts_us + a + b·ts_us`, fitted on per-5 s minima of `host_rx_us − ts_us` (Theil–Sen, last 10–30 min; offset only for the first 3 min) | Samples get exact ESP32 spacing *and* the label clock. Per-packet host time carries Wi-Fi jitter; the ESP clock alone drifts and restarts at boot |
| 6 | Hampel | per subcarrier, half-window 3, k = 3, σ̂ = 1.4826·MAD, causal (3-sample delay) | Removes one-packet spikes before the filters smear them |
| 7 | Resample | linear onto a 100 Hz grid → Butterworth 4th order low-pass 20 Hz (SOS) → every 2nd sample | Gives the fixed **50 Hz** the models need. The low-pass stops ~88 Hz input folding 25–44 Hz noise into the band |
| 8 | Gap policy | ≤ 50 ms interpolate; 50 ms – 1 s hold + `valid = false`; > 1 s or a new boot: reset filters + warm-up | Models never see invented data; detectors never see a step from a gap as a fall |

**Output:** `F` float32 `[T, 52]` (dB, 50 Hz), `valid` bool `[T]`, `ts`
uint64 host µs. `dump_features` writes exactly these. CI checks that a file
fed in random chunk sizes gives byte-identical output.

Every parameter here is part of `PIPELINE_VERSION = 2`.

---

## 5. Quality gates

A model output is only as good as its input. These gates decide when
outputs are produced at all.

| Gate | Threshold [H] | Applies to | When it fails |
|---|---|---|---|
| Frame rate | ≥ 50 Hz over 60 s (target ≥ 80) | everything | `sensor_offline` (server), outputs held |
| Invalid samples in a window | ≤ 10 % of the 150 samples | models | No inference; posture/count hold their last value with `src = "rule"` |
| Warm-up | 3 s after boot or gap; plus each detector's history (presence 10 s, breathing 30 s) | detectors, events | No event can start |
| Saturation | ≤ 0.1 % of frames | everything | Health warning; fix `shift` |
| Motion | low for 20 s | breathing rate | `breathing.valid = false` |
| Presence | PRESENT | breathing, posture, count, `no_breathing` | outputs `null` |
| Calibration | `ok` and younger than the drift alarm | presence `S`, drift, bed exit | presence works on motion + breathing only; UI warning |
| Model version | `pipeline_version` and `feature_set_version` match | models | Model refused at load |

---

## 6. Derived signals

Everything computed from `F`. Each one has a single implementation in
`lifefi.dsp` / `lifefi.features`.

| Signal | Definition | Rate / window | Calibration? | Used by |
|---|---|---|---|---|
| `z`, detector view | `(F − μ_cal) / max(σ_cal, 0.3 dB)` | 50 Hz | yes | `S`, drift |
| `x`, model view | `clip((F_w − mean_w(F_w)) / 1 dB, ±10)` per subcarrier, over a 3 s window `F_w` | `[150, 52]`, every 0.5 s | **no** | transition CNN, count |
| `F_mot` | `F` band-passed 2–20 Hz (SOS) | 50 Hz | no | `M`, fall features |
| `M`, motion | mean over subcarriers of `var(F_mot)` over 0.5 s, scaled by the empty P99 → 0–1 | 2 Hz | for scaling only | presence, fall, breathing gate, restlessness |
| Turbulence `t` | per frame, `std(A)/mean(A)` across subcarriers (linear `A = 10^(F/20)`); then `var(t)` over 1 s | 50 Hz → 2 Hz | no | motion (second feature), GBM |
| `p`, profile | 10 s mean of `z` over the 52 subcarriers, mean-removed | 0.1 Hz | yes | `S`, bed exit, drift |
| `S`, static deviation | `1 − corr(p, p_empty)` | 2 Hz | yes | presence |
| `F_br` | `F` → 2 Hz low-pass → every 5th sample (10 Hz) → band-pass 0.1–0.5 Hz | 10 Hz | no | breathing, `B` |
| `B`, breathing energy | Welch power of the breathing PC1 in 0.1–0.5 Hz over 30 s | 2 Hz | for thresholds only | presence |
| Breathing PC1, `v` | SVD over the top-8 subcarriers (power ratio 0.1–0.5 vs 0.6–2 Hz) of a 30 s `F_br` buffer; `v` stored as 52-length; sign aligned to the previous `v` | 30 s window, every 0.5 s | no | rate, wave, `v_valid` |
| Breath peaks | peaks in `F_br · v_valid` with prominence ≥ 0.4·`A_ref`, ≥ 1.5 s apart | event stream | no | `no_breathing` |
| Fall features | over the 3 s before a spike: var ratio (1 s / 2 s), 2–20 Hz energy share, burst length, max \|diff\|, kurtosis | per spike | no | fall rule, verifier |
| Drift `r` | `1 − cos(p, p_empty)` every 30 s while EMPTY | 1/30 Hz | yes | drift detector |
| Motion counts | number of 0.5 s windows per minute with `M > T_move` | 1/min | no | restlessness, routine |
| GBM features (`lifefi.features` v1) | per window: PC1–3 and per-subcarrier variance, mean, max \|diff\|, kurtosis; band energies 0.1–0.5, 0.5–2, 2–10 Hz; mean cross-subcarrier correlation; turbulence stats | per window | no | transition GBM, fall verifier |

**Why the model view drops the window mean:** it removes three things the
models must not learn:

- the receiver gain (a dB offset);
- the room's static multipath;
- where the person stands (a static offset).

What is left is how the channel *changes* during the 3 s, which is what a
transition is.

---

## 7. What each model needs

Each card lists: the CSI-derived inputs, the window, whether calibration is
needed, the minimum signal quality, the labels, and the known failure modes.

### 7.1 Presence state machine (Must)

- **Inputs:** `S` (10 s profile vs empty), `B` (30 s breathing energy),
  `M` (0.5 s).
- **Calibration:** yes, for `S` and for every threshold (P95/P99 of the
  empty room for `S`, `B` and `M`).
- **Quality:** ≥ 50 Hz; the empty calibration taken with nobody in the
  Fresnel zone of the link.
- **Labels:** `empty` and occupied segments (static states, walking) to
  tune the thresholds; enter/leave times.
- **Fails when:** furniture is moved or a door changes state (drift → `S`
  high → stuck PRESENT, handled by `uncertain`); the person is far from the
  link; fans or curtains create breathing-band energy.

### 7.2 Motion (Must)

- **Inputs:** `F_mot` variance, turbulence.
- **Calibration:** only for the 0–1 scaling (empty P99).
- **Quality:** ≥ 50 Hz, compensation valid (an un-compensated gain step is
  a fake motion burst).
- **Labels:** none needed. Walking/static segments are used to check it.
- **Fails when:** saturation; gain steps if `gain_comp` is wrong (seen as
  isolated one-sample steps in all subcarriers at once).

### 7.3 Breathing rate (Must)

- **Inputs:** `F_br` (10 Hz, 0.1–0.5 Hz band), 30 s buffer, top-8
  subcarriers, PC1.
- **Calibration:** no.
- **Quality:** ≥ 50 Hz before decimation; motion low for 20 s; **one
  person**; person within or near the line between router and ESP32.
- **Labels:** paced breathing at 10/15/20 /min and natural breathing, with a
  **chest reference** signal (phone accelerometer or belt), synchronised by
  a tap.
- **Fails when:** the person moves; several people; the person is far off
  the link; breathing faster than 30 /min (children); slow drift from
  heating or air conditioning.

### 7.4 Breathing cessation, `no_breathing` (Must)

- **Inputs:** `F_br` projected on `v_valid` (frozen at the last valid
  breathing), breath peaks, `A_ref` (median peak-to-peak of the last 60 s of
  valid breathing), `M`, presence.
- **Calibration:** no.
- **Quality:** breathing must have been `valid` in the last 60 s. That is
  the gate that stops "person walked away" from looking like apnea.
- **Labels:** `breath_hold_start` / `breath_hold_end` marks with a chest
  reference; long unlabelled runs for false alarms per hour.
- **Fails when:** the person turns or shifts slightly during the hold (the
  frozen `v` loses the chest; motion gating catches large moves only);
  shallow breathing near the noise floor.

### 7.5 Fall → fainted (Must; verifier Should)

- **Inputs:** `M` (spike and stillness), the fall features of §6 over the
  3 s before the spike, presence `S` after the spike.
- **Calibration:** no, apart from the motion scaling. `T_fall` comes from
  the walking/sit-down motion distribution.
- **Quality:** ≥ 80 Hz preferred. The 2–20 Hz burst content needs the
  sampling rate; at 50 Hz input the band is close to Nyquist.
  Warm-up blocks events after a reboot or gap.
- **Labels:** `fall` marks (snapped to the motion peak); hard-negative marks
  (`hard_negative_sit`, `hard_negative_drop`, `hard_negative_liedown`);
  long runs for FA/h.
- **Fails when:** a fast sit-down or lie-down (hard negatives); the person
  falls outside the link zone; several people.

### 7.6 Calibration and drift (Must / Should)

- **Inputs:** 2 min of `F` with the room empty → `μ_cal`, `σ_cal`,
  `p_empty`, the P95/P99 of `S`, `B`, `M`; later `r` and Page–Hinkley.
- **Quality:** no motion during calibration (the engine refuses
  otherwise).
- **Labels:** none; the long unlabelled runs show how fast the baseline
  drifts.
- **Fails when:** the room is never empty (→ `recalibrate_needed`).

### 7.7 Transition model + posture state machine (Should)

- **Inputs:** CNN: model view `x` `[150, 52]`. GBM: `lifefi.features` of
  the same window.
- **Calibration:** **no** (by design).
- **Quality:** ≤ 10 % invalid samples in the window; presence PRESENT.
- **Labels:** `sit_down`, `stand_up`, `lie_down`, `get_up` marks (20 reps
  each per session, several spots and speeds), walking segments, everything
  else `none`. Window labelling rule as in [plan-v2 §6.8](plan-v2.md).
  That gives roughly 4–5 positive windows per transition: about 350 per
  session, or about 1,400 over 4 training sessions.
- **Fails when:** in a new room (expected; `onsite_adapt`); several people;
  a missed transition leaves the posture state wrong until the next one.

### 7.8 Bed exit (Should)

- **Inputs:** profile `p` vs `p_bed_empty` and `p_bed_occupied`; `B`; `M`;
  the `get_up` transition if the model exists.
- **Calibration:** yes, two extra profiles (60 s each), via
  `calibrate kind=bed_empty|bed_occupied`.
- **Quality:** the link must **cross the bed**; a fresh empty calibration.
- **Labels:** `in_bed` / `bed_empty` segments, `bed_exit` marks.
- **Fails when:** the link misses the bed; a second person sits on the bed.

### 7.9 Count 1 vs 2+ (Could)

- **Inputs:** model view `x`, only while PRESENT; a 30 s median over the
  outputs.
- **Calibration:** no.
- **Quality:** people must move. Two still people are not separable on one
  link.
- **Labels:** `count` in segments: 1 and 2 people, moving and still.
- **Fails when:** people are still; people stand close together; a new
  room.

### 7.10 Occupancy level (Could, School)

- **Inputs:** presence + the mean of `M` over 5 min.
- **Calibration:** only through presence.
- **Labels:** none; thresholds from a normal lesson vs an empty room.

### 7.11 Long inactivity / restlessness / routine (Should / Could, server)

- **Inputs:** motion counts per minute, presence, in-bed state, breathing
  rate (stored history, 1 row / 5 s).
- **CSI quality:** inherited from motion and presence. `sensor_offline`
  periods are excluded from statistics, so they never count as "inactive".
- **Labels:** none; days of unlabelled runs (or clearly marked simulated
  history for the demo).

### 7.12 Summary matrix

| Model | `F_mot`/`M` | `S`/`p` | `F_br`/PC1 | `x` | GBM feats | Calibration | Min rate |
|---|---|---|---|---|---|---|---|
| Presence | ✓ | ✓ | ✓ (`B`) | | | empty | 50 Hz |
| Motion | ✓ | | | | | scaling | 50 Hz |
| Breathing rate | gate | | ✓ | | | — | 50 Hz |
| `no_breathing` | gate | | ✓ (frozen `v`) | | | — | 50 Hz |
| Fall → fainted | ✓ | after spike | | | verifier | — | 80 Hz preferred |
| Drift | | ✓ | | | | empty | — |
| Transitions | | | | ✓ CNN | ✓ GBM | **none** | 50 Hz |
| Bed exit | ✓ | ✓ | ✓ (`B`) | | | empty + bed | 50 Hz |
| Count 1/2+ | | | | ✓ | (✓) | none | 50 Hz |

---

## 8. Phase 2 measurement checklist

Every [I] in this document is settled here, on the real ESP32 and router,
before the pipeline is trusted. Results go into `model_io.md` and
`docs/setup.md`.

| # | Measurement | How | Pass / decision |
|---|---|---|---|
| 1 | **Rate and loss** | 30 min, person moving occasionally; the `seq` and `rx_seq` gaps; `ping_timeouts` | ≥ 80 Hz, < 5 % loss. If `ping_timeouts` is high, the router rate-limits ICMP → another router, or ping the wired laptop instead |
| 2 | **Frame-type mix** | histogram of `sig_mode`, `mcs`, `n_values` | Note the dominant type. Confirm the 256 B HT layout and the 128 B non-HT layout |
| 3 | **HT-LTF offset** | Plot the amplitude of bytes 128–255 for HT frames: it should show 56 non-zero subcarriers with guards | Confirms §3.1 |
| 4 | **Power steps per type/MCS** | Empty room, 10 min: compare the mean `L` of each (`sig_mode`, `mcs`) group | If groups differ by > 0.5 dB [H], keep only the dominant group (or subtract the group offset) |
| 5 | **LLTF vs HT-LTF stability** | Empty room, 10 min: per-subcarrier std of `L`, and the step count, for both | Keep D2 (LLTF) unless HT-LTF is clearly more stable at equal rate |
| 6 | **`shift`** | §2.2 | < 0.1 % saturation at the closest point; median ≥ 8 at the far point |
| 7 | **Gain compensation** | Walk near and far; reboot 3× in an empty room; log `agc`, `fft`, `gain_comp`, mean `L` | Inside a session: no steps in `L` when `agc` jumps. Across reboots: note the offset of mean `L` (D3 handles it). Confirm that `gain_comp` is a linear amplitude factor |
| 8 | **Clock drift** | 2 h run; slope of the min-envelope of `host_rx_us − ts_us` | Record the ppm. Confirms the need for the drift term |
| 9 | **Empty-room noise** | 10 min empty: σ of `L` per subcarrier; the breathing-band and motion-band P95/P99 | Sets σ_floor and the initial thresholds; flags dead subcarriers (σ near 0 or huge) |
| 10 | **Breathing visibility vs placement** | Seated person, 3 positions (on the link, 0.5 m off, 1.5 m off), 2 heights | Pick the placement for `setup.md`; note how far off the link breathing stays `valid` |
| 11 | **Latency** | `t_rx_last_us` → engine output → browser | Baseline for the latency report |

---

## 9. What we deliberately don't use, and why

| CSI component | Why not (for now) | Kept for later? |
|---|---|---|
| **Phase** | One antenna: every packet has a random phase offset and slope from carrier and sampling-frequency offset. The robust fix (the phase difference between antennas) needs ≥ 2 antennas. Linear-fit sanitisation leaves little usable signal on one chain [I] | Yes: `buf` is stored raw, so a phase experiment can re-process old recordings |
| **HT-LTF** | Only in HT frames; may be affected by the router's spatial mapping [I] | Yes: sent and recorded, compared in §8 |
| HT-LTF subcarriers ±27, ±28 | Not in LLTF; we keep one 52-subcarrier set for every frame | — |
| STBC HT-LTF2 | Only with STBC, which we don't expect from a single-stream link | Disabled |
| RSSI | One number per frame. Much coarser than 52 subcarriers, and moved by AGC | Health tile; sanity check only |
| Noise floor | Varies little | Health only |
| Raw `agc_gain`/`fft_gain` as features | Their compensation is already applied; as features they would teach the model the receiver's state, not the room | Diagnostics only |
| Heart rate band (0.8–2 Hz) | Not credible on single-link amplitude [V per audit] | No |

---

## 10. Calibration data

Stored per node in `data/calibration/<id>.json` + `.npy`. Its id travels
with every result.

| Item | Shape | Source | Used by |
|---|---|---|---|
| `μ_cal`, `σ_cal` | `[52]`, dB | 2 min empty | `z` |
| `p_empty` | `[52]` | 2 min empty | `S`, drift |
| `S`, `B`, `M` P95 / P99 | scalars | 2 min empty | presence and motion thresholds |
| `σ_r` | scalar | 2 min empty, 30 s blocks | Page–Hinkley δ, λ |
| `p_bed_empty`, `p_bed_occupied` | `[52]` | 60 s each | bed exit |
| meta | — | csi config, `PIPELINE_VERSION`, `boot_id`, time, `session` if recorded | reproducibility |

The models store **no** calibration. Their room adaptation lives in the
AdaBN statistics and the fine-tuned head of `onsite_adapt`, saved as a new
model version.

---

## 11. Data volumes

| Stream | Size | Per hour |
|---|---|---|
| One CSI packet (54 B header + 256 B LLTF + HT-LTF) | 310 B | — |
| `.csirec` record (+12 B framing), at ~88 Hz | ~28 KB/s | **~100 MB** |
| `F` (float32, 52 × 50 Hz) | 10.4 KB/s | ~37 MB |
| Results over TCP/WebSocket (2 Hz, with `csi` rows) | ~2–3 KB/s | — |
| History (1 row / 5 s, no `csi`/`wave`) | small | < 1 MB |

An overnight run is ~1 GB of `.csirec`. Keep raw recordings on the laptop
and on one backup drive. Do not put them in git.

---

## 12. Recordings each model needs (summary)

The full plan, with times, is in [plan-v2 §10](plan-v2.md).

| Model | Minimum data | Ground truth |
|---|---|---|
| Presence | empty + occupied (still and moving) in ≥ 2 rooms; enter/leave events | segments |
| Motion | any labelled session | segments (check only) |
| Breathing rate | 5 × 1 min paced + 10 min natural, per person | **chest reference** + metronome |
| `no_breathing` | 10 breath-holds of 15–30 s per volunteer; hours of long runs | chest reference + marks; long runs for FA/h |
| Fall → fainted | 10–20 falls + 30 hard negatives per session; hours of long runs | snapped marks |
| Drift | long unlabelled runs over days | none |
| Transitions | 20 reps × 4 transitions + 5 min walking per session, ≥ 4 sessions, ≥ 2 rooms, 1–2 sessions locked for test | snapped marks |
| Bed exit | bed empty 2 min, in bed 5 min, 10 exits | segments + marks |
| Count 1/2+ | 2 people moving 5 min + still 3 min per session | segments with `count` |
| Long inactivity / routine | days of history (or simulated, clearly labelled) | none |
