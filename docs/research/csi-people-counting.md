# Counting People with One ESP32: How CSI Sensing Works

This note explains how Wi-Fi CSI "radar" sensing works and what one ESP32
(one receive antenna, one link to the router) can realistically say about
**how many** people are in a room. It also describes what our firmware
does and how to calibrate and validate it. It should take about 10
minutes to read.

**Tags:**

| Tag | Meaning |
|---|---|
| **[V]** | Checked in the linked source |
| **[U]** | Unverified: only found in a secondary source, or the primary source was unreachable |
| **[I]** | Our inference from the sources |
| **[H]** | Heuristic starting value, to tune on our recordings |

Reference IDs in brackets (E1, C3 …) point to the list at the end.

---

## 1. How CSI sensing works

### 1.1 What CSI is

- **OFDM:** a 20 MHz Wi-Fi channel is split into subcarriers 312.5 kHz
  apart (20 MHz / 64). The legacy format uses **52** of them: 48 data and
  4 pilots [V B1]. The ESP32 reports the legacy long training field
  (**LLTF**) for both non-HT and HT 20 MHz packets [V E1], so every
  packet gives the same 52 subcarriers (k = ±1 … ±26) [I].
- **CSI** is the receiver's per-subcarrier estimate of the channel: one
  complex number (amplitude and phase) per subcarrier per packet [V E1].
- **Multipath:** the signal arrives by a direct path plus reflections from
  walls, furniture and people. Each subcarrier has a slightly different
  wavelength, so the paths add up differently on each one. The result is
  a frequency "fingerprint" of the room [I].

### 1.2 Why bodies change the CSI

- A person blocks some paths and adds new reflected ones. Standing still,
  that changes the **shape** of the fingerprint (a static change). Moving,
  it makes the amplitudes **fluctuate** over time [I].
- **Fresnel zones** describe the geometry: they are ellipsoids with the
  transmitter and receiver as foci. Each successive zone adds half a
  wavelength of extra path length [V B2]. At 2.4 GHz (λ ≈ 12.5 cm) a body
  crossing zone boundaries makes the amplitude rise and fall [I].
- **Consequence:** sensitivity depends on position. Near the line of sight
  and in the inner zones, small motions are visible. Far from the link,
  or at some spots ("blind spots"), they are not [V B3, B4].

### 1.3 Why we use amplitude only

- **Raw phase is unusable.** Carrier frequency offset, sampling frequency
  offset, packet detection delay and a random offset reset at every
  power-up all add to the measured phase [V B5].
- **The standard fixes need two antennas.** Conjugate multiplication and
  the CSI ratio work because antennas on one card share an oscillator, so
  the offset cancels between them [V B4, B5]. The ESP32 has one RX chain.
- **Single-antenna option.** A cross-subcarrier ratio worked on an ESP32
  for breathing, but in HT40 with 218 subcarriers [V B6]. It is unproven
  at HT20, and it does not help counting [I].
- **Decision:** use **amplitude only**, normalised per packet (section 4)
  [I].

---

## 2. ESP32 CSI specifics (ESP-IDF 5.5)

| Item | Detail | Tag |
|---|---|---|
| Setup | enable CSI in menuconfig; `esp_wifi_set_csi_rx_cb()`, `esp_wifi_set_csi_config()`, `esp_wifi_set_csi(true)`. The callback runs in the Wi-Fi task: copy and queue, don't process there | [V E1] |
| `wifi_csi_config_t` (ESP32 / S3) | `lltf_en`, `htltf_en`, `stbc_htltf2_en`, `ltf_merge_en`, `channel_filter_en`, `manu_scale`, `shift`, `dump_ack_en` | [V E2] |
| Defaults to change | `ltf_merge_en` averages LLTF and HT-LTF; `channel_filter_en` "smooth[s] adjacent sub-carrier". Both default on. Turn them off to keep subcarriers independent | [V E2] |
| Scaling | `manu_scale = false` (default) scales CSI automatically; `true` uses a fixed left `shift` of 0–15 bits | [V E2] |
| `wifi_csi_info_t` | `rx_ctrl` (RSSI, rate, `sig_mode`, `cwb`, …), `mac`, `dmac`, `first_word_invalid`, `buf`, `len`, `hdr`, `payload`, `rx_seq` | [V E2] |
| Buffer format | signed int8 pairs, **imaginary first, then real** | [V E1] |
| LLTF order (no secondary channel) | entries for subcarriers **0 … 31, then −32 … −1**: 64 entries, 128 bytes. Our 52 are k = −26…−1 (entries 38–63) and +1…+26 (entries 1–26) | [V E1; I] |
| 40 MHz | a secondary channel switches LLTF to 0…63, −64…−1. Force the router to 20 MHz, or drop those frames | [V E1] |
| `first_word_invalid` | "the first four bytes of CSI data is invalid due to a hardware limitation in ESP32": entries k = 0 and k = +1 | [V E1; I] |

### 2.1 AGC and per-packet scaling

- The receiver's automatic gain control changes the gain from packet to
  packet. With auto-scaling on, the int8 values are also rescaled per
  packet [V E2]. Raw amplitudes therefore jump without any change in the
  room [I].
- Locking the gain is possible, but the gain-control component warns it
  "may cause packet loss". ESPectre reverted its gain lock and keeps AGC
  on [V E5, E10].
- **Practical fix:** use features that do not depend on scale. ESPectre's
  turbulence `std(A)/mean(A)` across subcarriers "is gain-invariant"
  [V E7]. Dividing each packet's amplitudes by their mean does the same
  [I].

### 2.2 Getting packets: ping vs sniffing

| Mode | How | Rate | Tag |
|---|---|---|---|
| **Connected + ping** | join the router and ping the gateway every 10 ms; keep only CSI whose source MAC is the router. This is Espressif's `csi_recv_router` example, which also uses LLTF only "to ensure the compatibility of routers" | 100 pps target; ESPectre measured ~91 CSI/s admitted on an S3 and 99–101 on C5→C6, with on-air regularity ~74 % | [V E3, E4, E9] |
| **Sniffer (promiscuous)** | no association. Listen on the AP's channel and keep frames from the AP's MAC. Espressif recommends sniffer mode to get more CSI | beacons alone ≈ 10 Hz (100 TU = 102.4 ms), plus whatever data the AP sends to other clients, so it is irregular | [V E1, B7; I] |

Ping mode is the default; sniffing is the fallback when no credentials
are set. Expect worse and less stable features in sniffer mode [I].

### 2.3 Prior open-source work

- **esp-csi** (Espressif): receive/send examples, the router-ping example,
  and `esp-radar` demos for motion and presence detection [V E3].
- **ESPectre:** on-device motion detection on six ESP32 variants. It
  explicitly does **not** count people [V E6].
  - Per packet, it computes "turbulence" = CV across 12 fixed
    subcarriers. It then evaluates 1 s windows at 100 pps [V E7].
  - Versions 1.2–2.x used Moving Variance Segmentation (MVS) of
    turbulence. 3.0 (Oct 2026) replaced MVS with a "lightweight"
    logistic detector [V E8].
  - Self-reported motion F1 is 0.96–1.0 across chips and signal
    strengths; classic ESP32: 0.99–1.0 [V E11].

---

## 3. People counting in the literature

| Work | Signal / metric | Hardware, links | Reported result | Tag |
|---|---|---|---|---|
| **FCC / Electronic Frog Eye** (Xi et al., INFOCOM 2014) | **PEM**: percentage of non-zero elements in the dilated CSI matrix, mapped to a count with a Grey Verhulst model (monotonic, no site survey) | 802.11n NIC, 1 link | Abstract gives no number. Cited elsewhere as 80 % exact-or-±1, up to 30 people | [V C1] / number [U C5] |
| **Depatla et al.** (JSAC 2015) | RSSI only; models blocking + scattering; KL divergence vs a per-count distribution | 1 Tx/Rx pair | up to 9 walking people, indoor + outdoor, "good accuracy"; numeric error not checked | [V C2 abstract]; numbers [U] |
| Depatla & Mostofi, through walls | RSSI only | 1 link outside the building | up to 20 people, 44 experiments, "high accuracy" | [V C3] |
| **Di Domenico et al.** (WiMob 2016) | Doppler-spectrum features, trained once, reused in other rooms | — | ~80 % up to 7 people (secondary) | [U C5] |
| **Brena et al.** (Electronics 2021) | multi-link Doppler descriptors | 1 vs 6 links | **44 % with one link → 99 % with 6 links** | [V C5] |
| **WiCount** (Liu et al., 2017) | DNN on CSI | Intel NIC | 82.3 % (also cited as 92.8 % up to 10 people); needs > 20 000 training samples | [U C6] |
| **DeepCount** (Liu et al., 2019) | CNN-LSTM on CSI + activity-based correction | Intel 5300, 3 RX antennas, 1500 pps | 86.4 % up to 5 people; 90 % with correction; 75 % at 10 | [V C7] |
| DASECount | domain adaptation | Atheros, 2×3 antennas, HT40 | 96.4 % for 0–8 people. Shows plain models dropping **99 % → 12 %** in a new room | [V C6] |
| Seated-crowd counting (2025) | stationary people | Intel 5300, 1 link, 3 antennas | MAE 1.04 up to 13 people; static is "considerably more challenging" | [V C8] |
| Passenger counting (2024) | CSI amplitude + RSSI | single-antenna Raspberry Pi receivers | one receiver: 77 % / 90 %; two receivers: 94.9 % (0–20 people, in-domain) | [V C9] |
| **Wi-CaL** | ESP32 CSI | **4 ESP32 links**, people walking | MAE 0.41; 81.8 % within ±1 | [V C10, via our earlier audit] |
| **WiCount dataset** (CSI-BERT2) | ESP32-S3, 52 LLTF subcarriers, ~100 Hz, labels 0–3 | 1 Tx, several RX | dataset only; no counting accuracy on the page | [V C11] |

### 3.1 What is realistic on ONE ESP32 link

- **Presence of a moving person:** reliable (motion F1 0.96–1.0 on
  ESP32 boards) [V E11].
- **Presence of a still person:** possible through the static profile
  change, but it depends on where they are relative to the link, and the
  empty baseline must be fresh [V B3; I].
- **Counting:** expect **0 / 1 / 2 / 3+** at best, and only **while
  people move**. Every strong result above uses several links or antennas.
  One link scored 44 % in the only direct 1-vs-many comparison [V C5].
- **Why activity metrics are coarse** [I]:
  - they grow with the number of moving people, then saturate (FCC uses a
    monotonic, saturating model [V C1]);
  - one person walking fast can look like two people walking slowly;
  - still people add almost no activity.
- **Room changes break trained models** (99 % → 12 %) [V C6]. Calibrate
  per room, at the venue.
- **Subcarriers can't separate people** [I, checked in our simulation].
  52 LLTF subcarriers span 16.25 MHz, so the delay resolution is ~62 ns,
  an 18 m path difference. Every person in a room modulates all
  subcarriers with nearly the same pattern. Counting by the rank of the
  subcarrier correlation matrix gave one dominant eigenvalue (15–37)
  whatever the count (`firmware/test/host`, raw-CSI simulation). Subspace
  counting needs more antennas or links.
- **Our simulation agrees with the 44 % figure** [I]. With people at
  random reflection strengths, the learned count was exact 9/18 times and
  within ±1 every time. One strong reflector looks like two weak ones.
- **Honest demo wording:** "empty / 1 / 2 / 3+ (while moving)" plus a
  presence flag. Do not show an exact number for crowds [I].

---

## 4. What our firmware does and why

Code: `firmware/src/csi_capture.c`, tunables in
`firmware/src/lifefi_config.h`.

| Step | What | Why |
|---|---|---|
| Capture | LLTF only; `ltf_merge_en`, `channel_filter_en` off; auto-scale on; source MAC must be the router; drop 40 MHz (`cwb ≠ 0`) and short (`len < 128`) frames | independent subcarriers, one layout [V E1, E2] |
| Traffic | ping the gateway every 10 ms (~100 Hz). With no SSID set, or if connecting fails within 20 s, sniff the strongest AP | [V E4, E9] |
| Amplitude | `A_k = sqrt(I² + Q²)` for 52 subcarriers. If `first_word_invalid`, copy k = +2 into k = +1 | [V E1] |
| Normalise | `a_k = A_k / mean_k(A_k)` per packet | removes AGC and auto-scale gain, which multiply every subcarrier by the same factor [I; cf. E7] |
| Window | 1 s tumbling windows; per-subcarrier mean `μ_k` and variance `σ²_k`; skip windows with < 5 packets | [H] |
| Calibration | at boot, 20 s empty room (after 3 warm-up windows): baseline `σ²_k,empty` and empty profile `μ_empty` | [H] |
| **Motion ratio** `m` | `mean_k (σ_k / σ_k,empty)`, with `σ²_k,empty` floored at ¼ of the median subcarrier | overall fluctuation vs empty; ≈ 1 when empty |
| **Active fraction** `f` | share of subcarriers with `σ²_k > K · σ²_k,empty`, K = 4 | PEM-like: more movers excite more subcarriers [V C1 idea; H value] |
| **Profile deviation** `d` | `1 − corr(μ, μ_empty)` | static change from a still body |
| Presence FSM | goes PRESENT when `m`, `f` or `d` exceeds max(floor, scaled empty P90): `m` ≥ max(1.8, 1.5·P90); `f` ≥ max(0.20, P90 + 0.15); `d` ≥ max(0.005, 3·P90). EMPTY after 30 s without motion, once `d` falls below 0.6 × its on-threshold. UNCERTAIN after 300 s present without motion | hysteresis + hold stop flicker [H] |
| Count | activity score smoothed over the last 8 windows → monotonic thresholds → median of the last 5 raw counts, capped at 5. Defaults until learned: 2 people at score 4, 3 at 7, 4+ at 11 | [H] |
| Learning | serial `learn N` (N = 1…5) records 30 windows with N people. Once ≥ 2 levels are stored, the count is the nearest learned level in (log `m`, 2·`f`) space instead of the default thresholds. Stored in NVS so they survive reboot. 0 is never learned: presence decides it | per-room calibration; trained models do not transfer between rooms [V C6; I] |

---

## 5. How to calibrate and validate

**Setup** [H]:
- Router at 20 MHz on a fixed channel, with band steering off.
- ESP32 and router 3–5 m apart, about 1 m high, so the link crosses the
  area where people will be.
- Do not move either device after calibrating.

**Procedure:**

1. **Empty calibration.** Clear the room, reboot, and stay out for 25 s.
   Repeat after any furniture or device move. Check the console: in an
   empty room `m` should stay near 1 and the state should stay EMPTY for
   10 minutes.
2. **Record levels.** For N = 1, 2, 3, have N people walk around
   normally and run `learn N` (the empty level comes from step 1). Use the
   same people at a normal pace.
3. **Still test.** Record 1 and then 2 people sitting still for 60 s each.
   Note `d` and the state. Do not learn these as counts.
4. **Repeat.** Do a second session on another day or at another time with
   different people. Log the console (`pio device monitor`) to a file.
5. **Check:**
   - **Monotonicity:** the median score must rise with N, with gaps larger
     than the spread within each level. If 2 and 3 overlap, merge them
     into "2+".
   - Within ±1 on the second session.
   - No false PRESENT in the empty room.

**Expected failure modes** [I]:

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Count drops to 1 (or 0) when people sit | still people add little variance | show presence from `d`, and flag the count as "while moving" |
| One fast walker reads as 2 | activity ≠ head count | longer smoothing; learn with a normal pace |
| 3+ reads as 2 | metric saturates; people outside the inner Fresnel zones | cap the display at "3+"; move the link into the crowd |
| PRESENT in an empty room | stale baseline (doors, furniture, people behind a wall); interference | recalibrate; raise floors; channel without neighbours |
| Noisy or slow features | sniffer mode, low packet rate, AP traffic bursts | use ping mode; check packets per window |
| Thresholds stop working after a move | room fingerprint changed (cf. 99 % → 12 %) [V C6] | re-run calibration and `learn` at the venue |

---

## References

**Espressif / ESP32 (E):**
E1 [ESP-IDF v5.5 Wi-Fi guide: Channel State Information](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-guides/wifi.html#wi-fi-channel-state-information) ·
E2 [esp_wifi_types_native.h (release/v5.5)](https://github.com/espressif/esp-idf/blob/release/v5.5/components/esp_wifi/include/local/esp_wifi_types_native.h) ·
E3 [espressif/esp-csi](https://github.com/espressif/esp-csi) ·
E4 [csi_recv_router app_main.c](https://github.com/espressif/esp-csi/blob/master/examples/get-started/csi_recv_router/main/app_main.c) ·
E5 [esp_csi_gain_ctrl component](https://components.espressif.com/components/espressif/esp_csi_gain_ctrl) ·
E6 [ESPectre](https://github.com/francescopace/espectre) ·
E7 [ESPectre ALGORITHMS.md](https://github.com/francescopace/espectre/blob/main/docs/ALGORITHMS.md) ·
E8 [ESPectre CHANGELOG](https://github.com/francescopace/espectre/blob/main/docs/CHANGELOG.md) ·
E9 [ESPectre ADR: managed CSI traffic](https://github.com/francescopace/espectre/blob/main/docs/adr/2026-08-23-standardize-managed-csi-traffic-sources.md) ·
E10 [ESPectre ADR: keep AGC active](https://github.com/francescopace/espectre/blob/main/docs/adr/2026-07-04-keep-agc-active-and-standardize-cv-normalization.md) ·
E11 [ESPectre performance](https://github.com/francescopace/espectre/blob/main/docs/performance/README.md)

**Background (B):**
B1 [IEEE 802.11a OFDM parameters](https://en.wikipedia.org/wiki/IEEE_802.11a-1999) ·
B2 [Fresnel zone](https://en.wikipedia.org/wiki/Fresnel_zone) ·
B3 [Fresnel-zone respiration sensing, UbiComp 2016](https://www-public.imtbs-tsp.eu/~zhang_da/pub/Daqing%202016%20UbiComp%20respiration.pdf) ·
B4 [FarSense (blind spots, CSI ratio across antennas)](https://arxiv.org/abs/1907.03994) ·
B5 [Tsinghua Wi-Fi sensing tutorial: CSI phase sanitization](https://tns.thss.tsinghua.edu.cn/wst/docs/sanitization/) ·
B6 [SA-WiSense (single-antenna ESP32 phase ratio)](https://arxiv.org/abs/2507.17623) ·
B7 [Beacon frame (default 102.4 ms interval)](https://en.wikipedia.org/wiki/Beacon_frame) ·
see also our [csi-sufficiency-research.md](csi-sufficiency-research.md) for the hardware audit

**Counting (C):**
C1 [Xi et al., "Electronic Frog Eye: Counting Crowd Using WiFi", INFOCOM 2014](https://scholar.xjtu.edu.cn/en/publications/electronic-frog-eye-counting-crowd-using-wifi/) ·
C2 [Depatla, Muralidharan, Mostofi, "Occupancy Estimation Using Only WiFi Power Measurements", JSAC 2015](https://web.ece.ucsb.edu/~ymostofi/papers/SAC15_DepatlaMuralidharanMostofi.pdf) ·
C3 [Depatla & Mostofi, "Crowd Counting Through Walls Using WiFi"](https://arxiv.org/abs/1711.05837) ·
C4 Di Domenico et al., "Trained-once device-free crowd counting and occupancy estimation using WiFi: a Doppler spectrum based approach", IEEE WiMob 2016 (original not checked; figures via C5) ·
C5 [Brena et al., "Device-Free Crowd Counting Using Multi-Link Wi-Fi CSI Descriptors in Doppler Spectrum", Electronics 2021](https://doi.org/10.3390/electronics10030315) ([abstract](https://research.tec.mx/vivo-tec/display/AcademicArticleSCO_85099986544)) ·
C6 [DASECount (cites WiCount; cross-domain drop)](https://arxiv.org/abs/2211.10040) ·
C7 [DeepCount](https://arxiv.org/abs/1903.05316) ·
C8 [Fast and Robust Stationary Crowd Counting](https://arxiv.org/abs/2507.14309) ·
C9 [RSSI-Assisted CSI-Based Passenger Counting](https://arxiv.org/abs/2410.11400) ·
C10 [Wi-CaL counting (ESP32)](https://catalog.lib.kyushu-u.ac.jp/opac_download_md/7161171/7161171.pdf) ·
C11 [WiCount ESP32-S3 dataset](https://huggingface.co/datasets/RS2002/WiCount)
