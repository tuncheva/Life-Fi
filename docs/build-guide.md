# Life-Fi Build Guide

**What this is.** How each part of the system is built, with concrete calls,
parameters and algorithms, followed by a gap list: things that neither
[implementation-plan.md](implementation-plan.md) nor
[plan-audit-and-model-research.md](plan-audit-and-model-research.md) cover
yet.

**Reliability tags:**

| Tag | Meaning |
|---|---|
| **[V]** | Checked against primary source code, documentation or a paper |
| **[I]** | Inferred or from memory; confirm before relying on it |
| **[H]** | An engineering heuristic. A starting value to tune on our own recordings with `--evaluate` |

## Contents

0. Contract changes that must happen first
1. Firmware
2. Engine signal pipeline
3. Detectors (presence, motion, breathing, falls, bed, sleep, routine, drift)
4. Models (training, export, adaptation, smoothing)
5. Engine runtime (ONNX Runtime)
6. Server
7. Phone notifications
8. Dashboard
9. Python-engine alternative
10. What is missing
11. Suggested build order (revised)

---

## 0. Contract changes that must happen first

Everything below assumes these changes. Several of them change the
`contracts/` files, so they should be agreed before Step 1, because every
component depends on them.

| Contract | Change | Why |
|---|---|---|
| `csi_frame.h` | Add `float gain_comp` (the compensation factor from `esp_csi_gain_ctrl_get_gain_compensation`). Keep raw `agc_gain`/`fft_gain`. Add `uint16_t rx_seq`. Update the `static_assert` size and bump `CSI_VERSION` to 2 | The compensation formula is closed-source, so the engine cannot recompute it from agc/fft [V] |
| `csi_frame.h` | Add a `ltf` field: 0 = LLTF, 1 = HT-LTF. Alternatively, always send the full buffer and let the engine choose | Legacy replies carry only LLTF |
| New `status` packet | Firmware sends 1 packet/s: heap, RSSI to the router, queue drops, reboot reason, uptime, config | Device health; see §10 |
| `results.schema.json` | `events[]` gains `state: active \| cleared`; new event types `bed_exit`, `long_inactivity`, `recalibrate_needed`, `sensor_offline` (server-generated); `presence` becomes `{value, state, src}` | Lets the server's `delay_s` and alert lifecycle work (audit #10) |
| `results.schema.json` | Add `config_hash` (hash of `rules.yaml` + calibration id) | Evaluations become reproducible |
| `model_io.md` | CSI config values; LLTF vs HT-LTF choice; causal filter coefficients; calibration mode in `meta.json` and ONNX metadata; opset (see §4.4); models may output `probabilities` instead of `logits` (see §4.3) | Prevents silent train/serve skew |
| `labels.jsonl` | New `kind:"mark"` events for transitions (`sit_down`, `stand_up`, `lie_down`, `get_up`, `bed_exit`, `breath_hold_start/end`) | Needed to train and evaluate the transition model and cessation detection |

---

## 1. Firmware (`firmware/`)

### 1.1 Toolchain

- **ESP-IDF v5.4 or v5.5 [V].** The `esp_csi_gain_ctrl` component (v0.1.5)
  ships prebuilt `.a` files for IDF 4.4 and 5.0–6.0. `esp-radar` 0.3.4 needs
  IDF ≥ 5.4. IDF 6.0 renames some macros.
- **Start from Espressif's example:** `esp-csi/examples/get-started/csi_recv_router`
  ([source](https://github.com/espressif/esp-csi/blob/master/examples/get-started/csi_recv_router/main/app_main.c)).
  It already does the core loop: ping at 100 Hz, CSI callback, gain
  compensation. Fork it rather than writing from scratch.
- **Hardware:** an ESP32-S3 module with an external antenna (`-1U` variant),
  which works better than the PCB antenna [V].

**`sdkconfig.defaults`** (from the example [V], plus our additions):

```
CONFIG_ESP_WIFI_CSI_ENABLED=y
CONFIG_ESP_WIFI_AMPDU_TX_ENABLED=n
CONFIG_ESP_WIFI_AMPDU_RX_ENABLED=n
CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM=128
CONFIG_FREERTOS_HZ=1000
CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240=y
CONFIG_COMPILER_OPTIMIZATION_PERF=y
CONFIG_BT_ENABLED=n          # BLE scanning makes CSI bursty
```

### 1.2 Boot sequence

```c
nvs_flash_init(); esp_netif_init(); esp_event_loop_create_default();
load_config_from_nvs(&cfg);                 // channel, rate, node_id, engine IP/port
wifi_connect_sta(&cfg);                     // + auto-reconnect handler on WIFI_EVENT_STA_DISCONNECTED
esp_wifi_set_ps(WIFI_PS_NONE);              // the example does NOT do this; we must [V]
esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);

wifi_csi_config_t csi = {
  .lltf_en = 1, .htltf_en = 1, .stbc_htltf2_en = 0,
  .ltf_merge_en = 0,          // default 1 replaces HT-LTF with LLTF/HT-LTF average
  .channel_filter_en = 0,     // default 1 smooths adjacent subcarriers
  .manu_scale = 1, .shift = CSI_SHIFT,   // fixed scale; auto-scale changes per packet
};
esp_wifi_set_csi_config(&csi);
wifi_ap_record_t ap; esp_wifi_sta_get_ap_info(&ap);
esp_wifi_set_csi_rx_cb(csi_cb, ap.bssid);   // cb filters on info->mac == router
esp_wifi_set_csi(true);

boot_id = esp_random();
q = xQueueCreate(64, sizeof(csi_item_t));
xTaskCreate(udp_tx_task, "udp_tx", 4096, NULL, 5, NULL);   // below Wi-Fi task priority
xTaskCreate(status_task, "status", 3072, NULL, 3, NULL);    // 1 Hz status packet
start_ping(gateway_ip, 1000 / cfg.rate_hz);                 // esp_ping, count = 0 (forever)
esp_task_wdt_add(...);                                       // reboot if stuck
```

### 1.3 CSI callback

The callback runs inside the Wi-Fi task, so it must be short [V].

```c
static void csi_cb(void *ctx, wifi_csi_info_t *info) {
  if (memcmp(info->mac, ctx, 6) != 0 && !cfg.forward_all) return;
  uint8_t agc; int8_t fft; float comp;
  esp_csi_gain_ctrl_get_rx_gain(&info->rx_ctrl, &agc, &fft);
  if (gain_cnt < 100) { esp_csi_gain_ctrl_record_rx_gain(agc, fft); gain_cnt++; }
  esp_csi_gain_ctrl_get_gain_compensation(&comp, agc, fft);   // valid after baseline
  csi_item_t it = { .ts_us = esp_timer_get_time(), .agc = agc, .fft = fft, .comp = comp,
                    .rx_ctrl = info->rx_ctrl, .rx_seq = info->rx_seq,
                    .fwi = info->first_word_invalid, .len = info->len };
  memcpy(it.buf, info->buf, info->len);          // buf is invalid after return; len ≤ 384
  if (xQueueSend(q, &it, 0) != pdTRUE) drops++;  // never block the Wi-Fi task
}
```

The UDP task loop:
1. `xQueueReceive`.
2. Fill `csi_frame_hdr_t`.
3. `sendto()` to the engine.
4. Increment `seq`.

Use `esp_timer_get_time()`, which is 64-bit. Don't use `rx_ctrl.timestamp`:
it is 32-bit µs and wraps every ~71.6 min [V].

### 1.4 Configuration and updates

- **NVS:** `nvs_open("cfg")`, then `nvs_get_u8("chan")` / `nvs_get_u16("rate")` /
  `nvs_get_u8("node")` / `nvs_get_str("engine_ip")`. Fall back to defaults on
  `ESP_ERR_NVS_NOT_FOUND`.
- **Serial console:** use `esp_console` with commands `set chan 6`,
  `set rate 100`, `set engine 192.168.1.20`, `reboot`.
- **Wi-Fi credentials:** also store them in NVS, so the device can be
  configured at the venue without a rebuild. The plan omits this; it is
  required at an unknown venue.
- **OTA (recommended, see §10):** an `esp_https_ota` endpoint served by the
  server, or the simpler `esp_http_server` upload handler.

### 1.5 Measured expectation

ESPectre's ESP32-S3 benchmark with 100 pps ping reports **~88 Hz mean
(83–90)** [V]. The plan's "≥ 80 Hz" target is achievable but tight.

---

## 2. Engine signal pipeline (`engine/`)

The same code must run live and inside `--dump-features`. **All filters are
causal, with state carried across chunks** (`sosfilt` with `zi`, not
`sosfiltfilt`). Otherwise training features differ from live features [H].

**Per frame:**

1. **Validate:** check magic, version, `hdr_len`, `n_values` and the layout
   tuple (`sig_mode`, `cwb`, `stbc`). Count rejects by reason.
2. **Pick the LTF:** choose LLTF or HT-LTF per the `model_io.md` setting.
   - Buffer order is subcarriers 0..31, then −32..−1, as `[imag, real]`
     int8 pairs [V].
   - Keep k = ±1…±26.
   - If `first_word_invalid` is set, subcarrier +1 is invalid: set it to
     subcarrier +2 [V].
3. **Amplitude:** `a = sqrt(re² + im²) * gain_comp`. Also keep the
   scale-free form `a / mean(a)`, which serves as a fallback feature path
   if the compensation misbehaves.
4. **Clock map** (per `boot_id`). Network jitter only ever adds delay, so
   fit the *lower envelope* of `d = host_rx_us − ts_us` [V, Moon–Skelly–Towsley 1999]:
   - Take the minimum `d` per 5 s bin, over the last 10–30 min.
   - Fit the lower convex hull (Andrew's monotone chain) and take the edge
     spanning the mean timestamp. Theil–Sen on the bin minima is a simpler
     alternative.
   - Use offset-only for the first 2–3 minutes.
   - `host_ts = ts + a + b·ts`.
   - Typical ESP crystal drift is tens of ppm, roughly 36–144 ms/h [I], so
     offset-only is not enough for long sessions.

**Per 0.5 s hop:**

5. **Hampel filter per subcarrier:** half-window 3, k = 3.
   `σ̂ = 1.4826·median|x − median|`. Replace samples beyond k·σ̂ with the
   median.
6. **Resample:**
   - Linear-interpolate onto a uniform **100 Hz** grid using `host_ts`.
     Mark gaps over 50 ms as invalid; never bridge them.
   - Anti-alias low-pass: `butter(4, 20, fs=100, output='sos')`, causal.
   - Take every 2nd sample to get **50 Hz** [H].
7. **z-score** against the calibration baseline (empty-room mean and std per
   subcarrier). Record the calibration id. The baseline is **frozen while
   presence is true** (audit #3).
8. **Output:**
   - window `[150, 52]` → models;
   - streams → detectors (§3);
   - `--dump-features` writes the same arrays plus `meta.json`
     (`pipeline_version`, csi config, calibration mode, filter coefficients).

---

## 3. Detectors

All thresholds are **[H]**. Calibrate them from the empty-room distribution
(e.g. `T_on = 1.5–2 × P99_empty`, `T_off = P95_empty`), then tune on
recordings with `engine --evaluate`.

### 3.1 Motion

`M` = mean across subcarriers of the variance over the last 0.5 s of the
z-scored amplitudes, mapped to 0–1.

Add ESPectre's gain-invariant **turbulence** as a second feature [V]:
- `t = std(A)/mean(A)` across subcarriers per frame;
- then the variance of `t` over 1 s.

ESPectre's lightweight detector feeds lag-1 autocorrelation and IQR/mean of
`t` into a logistic regression, with hysteresis of 4 hits on and 3 hits off.
Both make good baselines to compare against.

### 3.2 Presence, including still people (fixes audit #2)

**Features:**

| Feature | Definition | Detects |
|---|---|---|
| `S` static deviation | `1 − corr(p̄_10s, p_empty)`, where p are 52-value profiles normalised by their own mean (gain cancels) | a person anywhere in the zone, even still |
| `B` breathing energy | Welch power of the breathing PC1 in 0.1–0.5 Hz over 30 s | a still, living person |
| `M` motion | §3.1 | a moving person |

**State machine:**

```
EMPTY ──(M > T_M,on for 1 s) or (S > T_S,on for 10 s)──▶ PRESENT
PRESENT holds while S > T_S,off or B > T_B,off or motion seen in last 30 s
PRESENT ──exit-like motion burst, then S < T_S,off AND B < T_B,off for 60 s──▶ EMPTY
Never drop to EMPTY on stillness alone.
```

Reference point: Espressif's esp-radar does something similar [V]:
- `wander` (distance of the current CSI vector from up to 10 stored
  empty-room vectors) for presence;
- `jitter` (change over the last 4 vectors) for motion;
- thresholds learned from an empty-room training run.

Its maths is in a closed `.a` [V]. Use it as a baseline to beat, not as a
dependency.

### 3.3 Breathing rate

1. Take the 50 Hz z-scored amplitudes, subtract the mean, and decimate ×5 to
   **10 Hz** (`resample_poly(x, 1, 5)`).
2. Band-pass with `butter(2, [0.1, 0.5], btype='band', fs=10, output='sos')`.
   SOS form is required: b/a coefficients at these cutoffs are numerically
   unstable.
3. Over a 30 s buffer (300 samples), pick the top 8 subcarriers by power
   ratio (0.1–0.5 Hz vs 0.6–2 Hz).
4. Take PC1 via SVD of `[300, 8]`.
   - **Sign fix:** flip if `dot(v_now, v_prev) < 0`. This stops the
     waveform polarity jumping between windows.
5. Hann window, then `rfft` with n = 2400 (8× zero-pad).
   - Parabolic interpolation on the log magnitude:
     `δ = 0.5(α−γ)/(α−2β+γ)`.
   - `bpm = 60·(k+δ)·fs/n`.
6. **Confidence and validity:**
   - `confidence = P(peak ± 0.02 Hz) / P(band)`.
   - Cross-check with the autocorrelation peak at lag 2–10 s; accept if it
     agrees within 2 bpm.
   - `valid` requires confidence ≥ c_min and 20 s of low motion.
7. **Reset** the buffer after a motion spike.
8. **Waveform output:** `breathing.wave` = the last 5 samples of PC1.

The 0.1–0.5 Hz band (6–30 bpm) excludes young children at rest, who
breathe up to ~40/min. For School, either widen the band to 0.7 Hz or
leave breathing off.

### 3.4 Breathing cessation (fixes audit #6)

UbiBreathe [V, [arXiv 1505.02388](https://arxiv.org/pdf/1505.02388)] alarms
when, over a sliding 10 s window, `max − min < τ × (range of the last normal
breathing)`, with τ = 0.5–0.67 giving the best results. Clinical apnea is
≥ 10 s.

```
env    = rolling RMS (10 s) of band-passed PC1
ref    = median(env) over the previous 60 s of *valid* breathing
fire no_breathing (state=active) when:
    presence == PRESENT and M < T_still and env < τ·ref  for ≥ 10–15 s   (τ ≈ 0.3–0.5)
state=cleared when env > 0.7·ref for 5 s, or motion resumes
```

Choose τ using breath-hold recordings with a chest reference: a phone
accelerometer in a chest pocket, or a respiration belt.

### 3.5 Fall → fainted (fixes audit #4)

**Stage 1, spike:** `M_0.5s > T_fall`.
- Set `T_fall` at P99.9 of motion during walking and sitting down, or at
  `μ_stable + 6σ_stable` (Anti-Fall [V]).
- Over the 3 s trace-back window ending at the spike (the paper's optimum
  is 2.5–3.5 s [V]), compute:
  - variance ratio `var(last 1 s) / var(prev 2 s)` > 4;
  - fraction of energy in 2–20 Hz > 0.5;
  - burst duration 0.3–2 s;
  - max first difference;
  - kurtosis.

**Stage 2, verify:** motion < T_still for ≥ 3 s **and** presence still held
(`S` or `B` above the off threshold) → `fall` (active).

**Escalate:** stillness continues for 20–30 s → `fainted_suspected`.
**Clear:** sustained motion followed by a `get_up` transition.

**Optional verifier:** a gradient-boosting classifier on the stage-1
features, trained against hard negatives (sitting down hard, dropping a bag,
lying down quickly). Published WiFi fall systems reach ~87–94 % detection
with 10–18 % false alarms on multi-antenna cards. Expect worse on a single
ESP32 antenna, and report false alarms per hour.

### 3.6 Transitions → posture state machine

The model (§4) emits `p(sit_down | stand_up | lie_down | get_up | walking | none)`.
Peak-picking turns these into events:
- smoothed `p > θ`;
- the window is a local maximum;
- a 3 s refractory period after each event.

Posture state:

```
STANDING ──sit_down──▶ SITTING ──stand_up──▶ STANDING
STANDING/SITTING ──lie_down──▶ LYING ──get_up──▶ SITTING/STANDING
walking ⇒ STANDING;  presence EMPTY ⇒ UNKNOWN;  posture.since = time of last transition
```

### 3.7 Bed exit and sleep

**Bed exit.** Setup records two profiles: `p_empty_bed` and `p_in_bed`.
- `IN_BED` when `corr(p, p_in_bed) > corr(p, p_empty_bed) + margin` for
  60 s, with `B` present.
- `bed_exit` = IN_BED, then a motion burst or `get_up`, then the profile
  moves toward `p_empty_bed` for ≥ 10 s.
- Place the link so it crosses the bed.

**Sleep and wake.** Use the Cole–Kripke actigraphy score on 1-minute epochs
[V, [reference implementation](https://github.com/dipetkov/actigraph.sleepr/blob/master/R/apply_cole_kripke.R)]:

`SI = 0.001·(106A₋₄ + 54A₋₃ + 58A₋₂ + 76A₋₁ + 230A₀ + 74A₊₁ + 67A₊₂)`, sleep if SI < 1.

- `A` = number of 0.5 s windows per minute with `M > T_move`, rescaled with
  one or two reference nights.
- Apply Webster rescoring rules.
- Report:
  - restlessness = movement-minutes per hour in bed;
  - breathing-rate trend.

### 3.8 Long inactivity and routine anomaly

This runs on the **server**, not the engine: it needs days of history.

- Store motion-minutes per hour, split into weekday and weekend buckets.
- Learn with an exponential moving average over 7–14 days. This follows
  the per-hour mean ± μ·std approach of Virone et al. [V, secondary source].

Raise `long_inactivity` when any of these holds:
- presence is held with no motion for longer than max(2 h, P99 of learned
  daytime still-bouts);
- there is no motion by the learned P95 wake time + 1 h;
- `P(X ≤ x | λ_hour) < 0.01` summed over 3 h;
- night activity exceeds mean + 3 std.

For the demo there are no 14 days of history. Seed the model with a fixed
"no movement for X min" rule, which is what commercial products offer as a
user setting [V], and show the learned version with simulated history.

### 3.9 Baseline drift

This runs only while the room is confirmed EMPTY.

- Every 30 s compute `r = 1 − cos(p, p_base)`.
- Run Page–Hinkley on r: `m_t = Σ(r_i − r̄ − δ)`, `PH = m_t − min m`, alarm at
  `PH > λ`. Start with δ ≈ 0.5σ_r and λ ≈ 5σ_r, where σ_r comes from the
  calibration period.
- On alarm, if the room has been EMPTY for ≥ 5 min with no motion,
  re-baseline (2-minute median, new calibration id).
- If the room is never empty for more than 24 h, emit `recalibrate_needed`.

---

## 4. Models (`ml/`)

### 4.1 Data loading and labels

**Windows:** 150 samples (3 s), 0.5 s hop, matched to labels on host time.

**Transition labels:**

| Window overlap with `[t_onset − 0.5 s, t_onset + 2 s]` | Label |
|---|---|
| ≥ 70 % | that transition class |
| 0–70 % | `ignore_index = −100` (excluded from the loss) |
| none | `none`, or `walking` inside walking segments |

- Onsets come from marks, shifted by the reaction-time offset, or from
  segment boundaries.
- Count labels come from segments.

**Splits** (via scikit-learn's `LeaveOneGroupOut`):
- `groups = session_id` for development;
- `groups = room_id` for the cross-room report;
- remove the locked test sessions first.

### 4.2 Baseline: gradient boosting on hand-made features

**Features per window:**
- per-subcarrier and PC1–3 variance, mean, max |diff|, kurtosis;
- band energies 0.1–0.5, 0.5–2 and 2–10 Hz;
- cross-subcarrier correlation;
- turbulence statistics.

**Model:** LightGBM, class-weighted.

**Export:** `onnxmltools.convert_lightgbm(clf, initial_types=[("features", FloatTensorType([None, F]))], zipmap=False, target_opset=17)` [V].
The output is **probabilities**, not logits.

**Keeping the `[1,150,52]` input contract** (recommended) [V]:
1. Write the feature extraction as a `torch.nn.Module` and export it to
   ONNX.
   - Compute band energies as a MatMul against a fixed DFT basis instead of
     the `DFT` op.
   - Avoid medians and percentiles; they need Sort.
2. Join the two graphs with
   `onnx.compose.merge_models(feat, gbm, io_map=[("features","features")])`.

The engine then still feeds `[1,150,52]` and stays model-agnostic. The
alternative, computing features in C++, re-creates the train/serve skew
that design rule 1 forbids.

### 4.3 1D CNN

About 43k parameters. The transpose sits inside the model, so the input
stays `[1,150,52]`:

```python
def blk(i,o,k,s): return nn.Sequential(nn.Conv1d(i,o,k,s,k//2,bias=False), nn.BatchNorm1d(o), nn.ReLU())
class CsiNet(nn.Module):
    def __init__(s, n_cls=6):
        super().__init__()
        s.f = nn.Sequential(blk(52,32,7,2), blk(32,64,5,2), blk(64,64,5,2), nn.AdaptiveAvgPool1d(1), nn.Flatten())
        s.head = nn.Sequential(nn.Dropout(0.3), nn.Linear(64, n_cls))
    def forward(s, x): return s.head(s.f(x.transpose(1, 2)))
```

**Training:**
- AdamW, lr 1e-3, weight decay 1e-2.
- Class-weighted cross-entropy with label smoothing 0.05.
- 30–60 epochs, with early stopping on a validation *session*.

**Augmentation**, applied on the fly to z-scored windows:

| Augmentation | Setting |
|---|---|
| Global amplitude scale | U(0.8, 1.2) |
| Per-subcarrier gain jitter | N(1, 0.05) |
| AGC step | constant offset added from a random time onward |
| Gaussian noise | σ = 0.05 |
| Time shift | ±10 samples |
| Time warp | ±10 % |
| Simulated packet loss | hold the last value for 2–8 samples |

### 4.4 Export

- **Choose the exporter and opset deliberately.** Since PyTorch 2.9 the
  default exporter is `dynamo=True`, which targets opset ≥ 18 [V docs; opset
  details I]. Either pass `dynamo=False, opset_version=17`, or bump the
  contract to opset 18.
- **Export folds BatchNorm into Conv [V].** The BN statistics then can't be
  recovered from the `.onnx`. **Ship the `.pt` checkpoint next to every
  `.onnx`.** AdaBN and fine-tuning run on the `.pt`, then re-export.
- **Metadata:** `onnx.helper.set_model_props(m, {"labels": json.dumps(L), "pipeline_version": "2", "window": "150", "rate_hz": "50", "calibration_mode": "empty", "temperature": "1.37"})`.
- **Test vectors:**
  - One seeded random window and one real window, written with
    `x.tofile()`.
  - The expected output from ORT in Python.
  - The C++ result must match within 1e-4, using the same
    `GraphOptimizationLevel` on both sides.

### 4.5 Calibration and smoothing

- **Temperature scaling** (Guo et al. 2017): fit a single `T` on a held-out
  session with L-BFGS. Either bake `logits/T` into the exported graph or put
  `temperature` in the model metadata.
- **`uncertain` output:** emit it when max p < θ. This is the
  "model unsure → rule fallback" trigger.
- **Live smoothing with a causal HMM forward filter:**
  `post ∝ (post_prev @ A) * (p / prior)`.
  - Set A to zero for impossible transitions.
  - Use fixed-lag Viterbi (3 windows) offline for evaluation.
  - About 20 lines of numpy; hmmlearn's API doesn't fit classifier
    outputs well.

### 4.6 On-site adaptation (`scripts/onsite_adapt`)

1. **Empty-room calibration:** 2 min.
2. **AdaBN** on 5–10 min of *unlabelled* normal activity:
   ```python
   for m in model.modules():
       if isinstance(m, nn.modules.batchnorm._BatchNorm):
           m.reset_running_stats(); m.momentum = None; m.train()
   with torch.no_grad():
       for x in loader: model(x)
   model.eval()
   ```
3. **Fine-tune the head only:**
   - freeze `model.f` (backbone in eval mode so BN stays fixed);
   - Adam 1e-3, 20–50 epochs;
   - data: 30–60 s per class from a guided script.
4. **Keep or reject** the new model on a **separately recorded 2-minute
   pass**, then re-export, run the test vectors, and `reload_models`.

---

## 5. Engine runtime (ONNX Runtime, C++)

Pin the prebuilt `onnxruntime-win-x64-<ver>.zip` via CMake
`FetchContent_Declare(URL … URL_HASH SHA256=…)` and copy `onnxruntime.dll`
next to the executable. Windows ships an older `onnxruntime.dll` in
System32, a known DLL-search trap [I].

```cpp
Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "lifefi");
Ort::SessionOptions so; so.SetIntraOpNumThreads(1);
Ort::Session s(env, L"models/m2.onnx", so);
Ort::AllocatorWithDefaultOptions al;
auto md = s.GetModelMetadata();
auto pv = md.LookupCustomMetadataMapAllocated("pipeline_version", al);  // nullptr if absent
if (!pv || std::string(pv.get()) != PIPELINE_VERSION_STR) refuse();
// also check calibration_mode == current calibration mode
```

[V: [ModelMetadata API](https://onnxruntime.ai/docs/api/c/struct_ort_1_1_model_metadata.html)]

Expose `rx`, `rejected_by_reason`, `queue_drops` and `inference_ms (p50/p95)`
through `get_status`.

---

## 6. Server (`server/`, Spring Boot)

| Part | Build |
|---|---|
| Engine client | Plain socket loop on a virtual thread: connect, then `readLine` and dispatch. On `IOException`, sleep 1 s and reconnect. Writes are synchronized. Pending commands sit in a `ConcurrentHashMap<id, CompletableFuture<Ack>>` with `orTimeout(3s)`. Simpler than Spring Integration TCP, whose client mode needs manual reply correlation [V] |
| WebSocket | Raw `TextWebSocketHandler` at `/ws/live`. Wrap each session in `ConcurrentWebSocketSessionDecorator(s, 1000, 64 KB)`, because `sendMessage` isn't thread-safe and slow clients must be bounded. No STOMP |
| History | H2 file mode, `jdbc:h2:file:./data/lifefi`. Store results downsampled to one per 5 s, without `csi`/`wave`. A `@Scheduled` hourly job deletes rows older than the retention period |
| Replayer | `ProcessBuilder(...).redirectErrorStream(true)`. Single instance. Stop with `destroy()`, then `waitFor(2s)`, then `destroyForcibly()`. `onExit()` publishes status. Add a shutdown hook |
| Alerts | State machine below. Persist every transition |
| Routine model | §3.8, a `@Scheduled` job over the history table |
| Sensor watchdog | No result for > 10 s, or `rate_hz < 50` for 60 s → `sensor_offline` alert in **every** profile (§10, gap 1) |

**Alert state machine:**

```
event active ─▶ PENDING (delay_s timer)
PENDING ─cleared before timer─▶ DROPPED
PENDING ─timer expires (or delay_s = 0)─▶ OPEN ─▶ push WebSocket + phone
OPEN ─ack─▶ ACKED ;  OPEN/ACKED ─cleared─▶ RESOLVED
OPEN not acked for N min ─▶ re-notify (escalation), optionally to a second contact
```

---

## 7. Phone notifications (missing from the plan)

The plan promises an alert "on a phone" but has no delivery mechanism.

**Recommended: [ntfy](https://docs.ntfy.sh/publish/) [V].** One HTTP POST, no
account, Android and iOS apps, self-hostable.

```java
HttpRequest.newBuilder(URI.create("https://ntfy.sh/" + topic))
  .header("Title", "Fall detected – Room 1").header("Priority", "5").header("Tags", "warning")
  .header("Click", "http://" + lanIp + ":8080/")
  .header("Actions", "http, Acknowledge, http://" + lanIp + ":8080/api/v1/alerts/" + id + "/ack, method=POST")
  .POST(BodyPublishers.ofString("Fall detected – Room 1")).build();
```

- **Topic:** use an unguessable name, since a topic on ntfy.sh works like a
  password. Store it per profile in `profiles.yml`.
- **Payload:** keep it minimal; it is health data.
- **Acknowledge button:** works only while the phone is on the same LAN.
- **Fallback:** a Telegram bot (`sendMessage`).
- **Rejected:**
  - Web Push needs HTTPS and, on iOS, a PWA added to the Home Screen
    (iOS 16.4+) [V]. Too fragile on a venue LAN.
  - SMS costs money and needs number verification.

---

## 8. Dashboard (`ui/`, Next.js)

- **Types:** `npx json2ts -i contracts/results.schema.json -o ui/src/types/results.d.ts`
  in `prebuild`. CI fails on a diff.
- **Live data:** a `'use client'` hook opens `ws(s)://<host>/ws/live`.
  - Reconnect with exponential backoff, capped at 5 s.
  - Expose a `connected` flag that drives the "connection lost" state.
  - Write `wave` and `csi` rows into a ref-held ring buffer and redraw on
    `requestAnimationFrame`, not with `setState` per message.
- **Charts:**
  - [uPlot](https://github.com/leeoniya/uPlot) (canvas) for the breathing
    wave.
  - A raw `<canvas>` for the CSI heatmap: shift left with
    `drawImage(c, −k, 0)`, then `putImageData` the new 52-pixel columns
    through a colormap lookup table.
  - Recharts only for slow timelines.
- **Static export** (`output: 'export'`) [V]:
  - No rewrites, API routes or Server Actions, so all calls go to the same
    origin.
  - Copy `ui/out/` into Spring's `static/`.
  - Add a `forward:/clinic.html` view controller per page.
  - In development, allow CORS from `:3000`.
- **New screens implied by this guide:**
  - device-health tile;
  - guided calibration ("leave the room / lie in bed now");
  - transition marks on the labelling screen;
  - alert history;
  - Home day-timeline and sleep summary;
  - settings page for profiles and thresholds.

---

## 9. Python-engine alternative

This is still recommended if team skills allow (audit #11).

- **Latency:** a 0.5 s hop is 25 × 52 new samples. Vectorised Hampel
  (`sliding_window_view`), `np.interp`, `sosfilt`, SVD of `[300, 8]`,
  `rfft` and onnxruntime on a 43k-parameter CNN should take well under
  20 ms per hop [estimate, benchmark it].
- **UDP receive:** `loop.create_datagram_endpoint`, stamping
  `time.time_ns() // 1000` first. Alternatively, a blocking socket thread
  feeding a queue.
- **What it removes:**
  - the C++ engine and its CMake/ORT/Winsock setup;
  - the C++/Python feature-parity fixtures;
  - option (b) of §4.2.
- **Optional further step:** FastAPI + SQLite also replaces Spring and the
  TCP :6000 protocol. Only do this if nobody needs the Java component.

---

## 10. What is missing

Ranked by impact on a working, credible demo.

| # | Gap | Why it matters | Fix |
|---|---|---|---|
| 1 | **Sensor-offline alert** | In a care system, a silent sensor looks exactly like "all OK". Every commercial system alerts on loss of signal | Server watchdog → `sensor_offline` in all profiles (§6); the firmware status packet (§0) feeds it |
| 2 | **Phone delivery mechanism** | The Step 6 check ("alert on a phone") can't pass without it | ntfy (§7) |
| 3 | **Event state / alert lifecycle** | `delay_s`, auto-resolve and escalation depend on it | §0 and §6 |
| 4 | **Labelling for transitions and breath-holds** | The new models and the cessation detector can't be trained or evaluated without them | Mark buttons + keyboard shortcuts; `label-cli` support |
| 5 | **Placement guide** | Breathing and presence depend more on geometry than on code | `docs/setup.md`: link 3–5 m line of sight, chest height, person in or near the line between router and ESP32, link crossing the bed (Clinic), away from metal; photograph each setup |
| 6 | **Wi-Fi credentials + engine IP in NVS** | The plan stores channel, rate and node in NVS, but not how the device joins an unknown venue network | Serial console commands; optionally a softAP provisioning page |
| 7 | **Venue network plan** | Venue Wi-Fi often isolates clients or blocks ping | Bring our own router; laptop on Ethernet or the same router; test ping at the venue early |
| 8 | **Auth and network exposure** | Dashboard, `/ack`, UDP :5005 and TCP :6000 are open to anyone on the LAN | Bind engine ports to localhost/LAN. Shared PIN/token for the dashboard and the ack endpoint |
| 9 | **Demo fallback automation** | If live drops mid-pitch, someone has to click to replay | Auto-switch to a looped replay with a banner after N s of no frames. Keep a "fall clip" recording ready |
| 10 | **Observability** | Diagnosing a failure at the venue | Engine counters in `get_status`; Spring Actuator `/actuator/health`; device-health tile |
| 11 | **Privacy controls** | GDPR Art. 9 health data; School and bathroom sensitivity | Retention period, purge-recordings command, School profile stores no breathing, pseudonymous `subject`, consent form for people recorded |
| 12 | **Config versioning** | Evaluations are not reproducible if `rules.yaml` changes silently | `config_hash` in results and alerts |
| 13 | **Rule unit tests** | Rules are the most safety-relevant code and are only tested end to end | Synthetic streams (`synth.py`: spike + stillness, sinusoid + stop, still person) → expected events, run in CI |
| 14 | **Home day-timeline and sleep summary data** | The Home profile promises a day timeline, but nothing aggregates it | Server hourly and nightly aggregates (§3.7, §3.8) |
| 15 | **Time zone handling** | School after-hours and routine-by-hour use local time; stored timestamps are UTC µs | Server converts with a configured `ZoneId` |
| 16 | **Firmware OTA** | Reflashing over USB at the venue is slow and risky | `esp_https_ota` from the server, or skip and bring a flashing script |
| 17 | **Home Assistant / MQTT output** | Cheap and a strong pitch point ("works with your smart home"); ESPectre does this | Optional MQTT publisher with HA discovery for presence, motion and alerts |
| 18 | **Multi-node readiness** | `node_id` exists, but UI and profiles assume one node | At least: per-node status, reject unknown nodes, profile per node/room |
| 19 | **Packaging** | `run_all` is dev-only | One installer script or Docker Compose for server + UI; engine binary in releases |
| 20 | **Model card / data sheet** | Judges and teammates need to see what the models can and can't do | `docs/models.md`: data, metrics with confidence intervals, cross-room result, known limits |
| 21 | **Hardware list** | Nobody has listed what to bring | ESP32-S3-1U + antenna, our router, USB cables, power bank, tripod/mount, fall mat, phone with ntfy, chest-reference phone |

---

## 11. Suggested build order (revised)

This builds on the plan's Steps 1–7. Bold items are new.

1. **Contracts v2 (§0)** → skeleton end to end (Step 1).
2. Firmware from `csi_recv_router` with our config, gain-control component
   and status packet; recorder; **network plan and placement test** (Step 2).
3. Signal pipeline (§2) → motion, **presence FSM**, breathing, **cessation**,
   **drift**; `--dump-features`; Home page (Step 3).
4. Labelling **with transition and breath-hold marks**; replayer; fixtures
   (Step 4).
5. Rules: **two-stage fall → fainted**, no-breathing; **alert state machine,
   ntfy, sensor-offline**; School and Clinic pages (Step 6, moved before
   models: it delivers the main demo value without trained models).
6. Models: **gradient-boosting baseline → transition CNN** → optional count;
   calibration and HMM smoothing (Step 5).
7. **Bed exit, sleep summary, long-inactivity**; hardening;
   **AdaBN + head fine-tune `onsite_adapt`**; docs and model card (Step 7).
