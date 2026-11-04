# Track D: fixed transmitter firmware (plan)

Owner: track D. Files: `firmware/**`, `docs/hardware/`. **Compile only, never
flash** (the board is not connected). Worker budget: **≤ 2 h**.

## Critic revisions (final plan: where this list and the text below disagree, this list wins)

Checked against the installed IDF 5.5.0 headers
(`~/.platformio/packages/framework-espidf`), `firmware/src/*.c` and
PlatformIO's `~/.platformio/platforms/espressif32/builder/frameworks/espidf.py`.

1. **Order changed so a partial finish ships TX + guide first** (§4 rewritten):
   TX app + `esp32dev_tx` build → owner guide → receiver lock → extra builds.
   A TX without the receiver lock is of little use (the old sniffer only
   surveys the 3 strongest AP channels), so if the lock is not finished the
   guide must say so plainly at the top, and the receiver files stay
   **untouched** (no half-done receiver change).
2. **Envs cut from three to two**: `esp32dev_tx` (required; also runs on an
   ESP32-CAM, same chip and 4 MB flash) and `esp32cam_tx` (only once the guide
   is written; it differs in LED pin and upload settings). `esp32s3_tx`
   dropped: another ~6 min fresh build for a board the owner is not known to
   have. `.gitignore` entries only for the two kept envs.
3. **Rate API confirmed** in `framework-espidf` 5.5.0 `esp_now.h`:
   `esp_now_set_peer_rate_config(const uint8_t *peer_addr, esp_now_rate_config_t *config)`,
   `esp_now_rate_config_t` = `wifi_tx_rate_config_t { phymode, rate, ersu, dcm }`.
   Use `{ .phymode = WIFI_PHY_MODE_HT20, .rate = WIFI_PHY_RATE_MCS0_LGI, .ersu = false, .dcm = false }`
   after `esp_wifi_start()`, `esp_now_init()` **and** `esp_now_add_peer(broadcast)`.
   Deprecated fallback `esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI)`
   only if the first call returns an error (the header says it is ignored once
   the per-peer call has been made). Send callback type is
   `void (*)(const esp_now_send_info_t *tx_info, esp_now_send_status_t status)`.
   Log which call succeeded in the start line.
4. **`esp_wifi_set_mac` placement**: header: "only when the interface is
   disabled", bit 0 of byte 0 must be 0. Call it after `esp_wifi_set_mode(STA)`
   and **before** `esp_wifi_start()`. `0x1A` = unicast + locally administered:
   valid. On failure log and continue with the factory MAC (the start line then
   shows the real MAC, so the owner sees why the receiver does not lock).
5. **Pacing simplified**: no `esp_timer` + notify. One send task with
   `xTaskDelayUntil(&last, period)` where `period = pdMS_TO_TICKS(1000 / rate)`
   (1 ms tick from `sdkconfig.defaults`); rates that do not divide 1000 are
   rounded, the 10 s status line prints the measured rate. A rate change just
   updates a volatile period.
6. **TX serial commands cut** to `status | channel <1-13> | rate <10-500> | help`
   (NVS namespace `lifefi_tx`, applied live). `id` dropped (build flag
   `LIFEFI_TX_ID` only): no multi-TX tonight and it needs the
   stop / set_mac / restart path.
7. **Receiver probe kept, made default-safe and switchable** (replaces §2.4
   points 1–2 where they differ):
   - The "existing sniffer survey prefers the TX MAC" alternative was checked
     and rejected: `scan_aps()` loops forever when no AP is visible (exactly
     the "no router, no phone" case), only the 3 strongest AP channels are
     surveyed, and station mode never reaches the survey. It cannot lock
     reliably.
   - Gate: `LIFEFI_TX_PROBE` (compile, default 1) **and** NVS key `tx_probe`
     (u8 in the existing `lifefi` namespace, missing = on). **With the probe
     off, `wifi_link_start()` must behave exactly as today.** Implement as
     `bool probe = tx_probe_enabled();` then
     `s_mode = (have_ssid && !probe) ? LINK_STATION : LINK_SNIFFER;`, and put
     the whole probe plus the "not found and have_ssid → promiscuous off,
     `s_mode = LINK_STATION; esp_wifi_connect();`" inside `if (probe)`. The
     existing station-wait / fallback / `start_sniffer()` code below stays as is.
   - Probe timing: `LIFEFI_TX_CHANNEL` for 400 ms, then the other 12 channels
     120 ms each (~1.9 s worst case); lock on the busiest prefix match with
     >= 5 frames (≥ 12 expected at 100 Hz in 120 ms). Skip channels where
     `esp_wifi_set_channel` fails (as `start_sniffer` does).
   - Receiver command: `tx` (prints on/off), `tx on`, `tx off` (save to NVS +
     restart, like `wifi clear`). `tx off` = the old behaviour; it is the first
     line of the guide's troubleshooting.
8. **Pure logic gets a host test**: `bool lifefi_is_tx_mac(const uint8_t mac[6])`
   in new `src/tx_match.c` / `tx_match.h` (only `<stdbool.h>`, `<stdint.h>`,
   `<string.h>`, `lifefi_config.h`, so the host build compiles it), tested for
   prefix match / non-match / other id. Plus the `tx` command cases in
   `test_commands.c` (stub `wifi_link_set_tx_probe`; `tx on` / `tx off` call it
   with true / false and restart; `tx bogus` does neither). Add the new unit to
   both `run.ps1` and `run.sh` the same way existing units are listed.
9. **Glob gotcha** (found in `espidf.py` `is_cmake_reconfigure_required`):
   CMake is re-run only when a `CMakeLists.txt`, sdkconfig or
   `sdkconfig.defaults` is newer than `CMakeCache.txt`, and `src/CMakeLists.txt`
   globs `src/*.c` at configure time. **A new .c file is silently left out of
   an existing build dir** (esp32dev, esp32cam): `tx_match.c` would give an
   undefined reference. Before each receiver build after adding files run
   `(Get-Item firmware\src\CMakeLists.txt).LastWriteTime = Get-Date`
   (mtime only, no content change).
10. **`build_flags` do reach `src`**: `espidf.py` clones `env` into
    `project_env` and compiles the project sources with it, so `build_flags`
    apply. Verify once on the first TX build with
    `pio run -e esp32dev_tx -v | Select-String "tx_main"` and look for
    `-DLIFEFI_ROLE_TX=1` (instead of a temporary `#warning`). The `firmware/tx/`
    fallback stays as written but is not expected.
11. **Receiver status text**: `wifi_link_describe()` for `LINK_FIXED_TX` keeps
    the same trailing fields:
    `FIXED transmitter "Life-Fi TX 01" 1A:4C:46:54:58:01 ch 11 | ping timeouts 0 | disconnects 0`.
    Engine regexes checked in `sources.py`: `link: disconnected (reason`,
    `waiting for the transmitter`, `| STATE people=`; new code must emit none.
12. **Power / thermal / RF**: 100 Hz × ~60 µs at MCS0 is < 1 % airtime and
    duty, no thermal concern; keep default TX power. At 2–2.5 m expect receiver
    RSSI about -30 to -45 dBm (shown in the `link:` probe line: add the RSSI of
    the locked entry); guide: above -25 dBm move them apart.
13. **Channel 11**: fine; in fixed-TX mode the AP survey never runs, so no
    interaction. Country `BG` on the TX too (allows 12 / 13).
14. **Guide additions** (§5): stop the Life-Fi app first (it holds the
    receiver's COM port) before `pio device monitor`; `--upload-port COMx`;
    ESP32-CAM-MB: if upload fails to connect, hold IO0/BOOT while it starts;
    "go back": `tx off` on the receiver (no reflash needed); fully reverting
    the receiver firmware is the owner's call (name the base commit `892526c`
    in the guide, give no git command).
15. **Acceptance builds**: `esp32dev_tx`, `esp32cam_tx` (if reached),
    `esp32cam`, `esp32dev`; `esp32s3` receiver only if time remains (it shares
    every changed file with `esp32dev`). Size check by grepping the TX `.map`
    for `estimator_push` stays (informational).

## 1. Why

The only CSI transmitter so far was the phone hotspot. When the phone moves,
every reading tracks the phone; even lying still the empty-room profile
drifted 7.4 dB in 10 min, and the position / spot models fail across sessions
(plan A). `docs/plan/upgrade-roadmap.md` #2 is a dedicated transmitter. Goal
for 9 am: the owner flashes a spare ESP32 as a fixed transmitter, powers it
from a USB charger, resets the receiver, and gets a steady ~100 Hz CSI link
with **no router and no phone**.

## 2. Design

### 2.1 What the transmitter sends (from Espressif's esp-csi `csi_send` / `csi_recv`)

- **ESP-NOW broadcast** (vendor action frame, FF:FF:FF:FF:FF:FF) from the STA
  interface, not connected to anything, on a fixed channel, **HT20, MCS0**.
  The PHY rate is the critical part: ESP-NOW's default is 1 Mbps 802.11b,
  and 11b frames carry **no CSI** (the receiver's comment in `wifi_link.c`
  about routers falling back to 11b is the same effect). esp-csi sets the
  rate to an OFDM/HT rate for exactly this reason.
- **Fixed, recognisable MAC** set with `esp_wifi_set_mac(WIFI_IF_STA, ...)`:
  `1A:4C:46:54:58:NN` ("LFTX", locally administered unicast; `NN` = TX id,
  default `01`). The receiver locks by the 5-byte prefix `1A:4C:46:54:58`.
  esp-csi does the same (fixed MAC `1A:00:00:00:00:00`, receiver filters
  `info->mac` in the CSI callback), which is exactly how `csi_capture.c`
  already filters (`csi_capture_set_target`).
- **Payload** (12 bytes, not read by the receiver tonight, there for a later
  loss counter via `wifi_csi_info_t.payload`):
  `struct { char magic[4] = "LFTX"; uint8_t version = 1; uint8_t id; uint16_t rate_hz; uint32_t seq; }`.
- **Rate** 100 Hz default (10–500 Hz allowed), paced by a periodic
  `esp_timer` that notifies a send task (`esp_now_send` must not run in the
  timer callback). 1 ms FreeRTOS tick is already set in `sdkconfig.defaults`.
- **Channel** 11 default (esp-csi's default; 1–13 allowed, country `BG` as on
  the receiver). The receiver sweeps all channels, so the TX channel can be
  changed without touching the receiver.
- **Bandwidth** HT20 (`esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20)`),
  power save off (`WIFI_PS_NONE`). The receiver rejects `cwb != 0` frames.

Rate API in the installed IDF 5.5 (checked in
`~/.platformio/packages/framework-espidf/components/esp_wifi/include/esp_now.h`):
`esp_now_set_peer_rate_config(peer, &(esp_now_rate_config_t){ .phymode = WIFI_PHY_MODE_HT20, .rate = WIFI_PHY_RATE_MCS0_LGI })`
after `esp_now_init()` + `esp_now_add_peer(broadcast)`. The older
`esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI)` still exists
but is marked deprecated; use it only as a fallback if the per-peer call
fails on the classic ESP32 (log which one worked; wrap the deprecated call in
`#pragma GCC diagnostic ignored "-Wdeprecated-declarations"`).

### 2.2 Build: same project, role flag, new envs

`src/CMakeLists.txt` globs `src/*.c`, so the TX lives in the same project:

- New `src/tx_main.c` (whole file inside `#if LIFEFI_ROLE_TX`), holding the
  TX `app_main`, the send task, NVS settings, LED and a small serial reader.
- `src/main.c`: wrap `app_main` in `#if !LIFEFI_ROLE_TX` (nothing else
  changes). Receiver modules are still compiled in the TX build; unused code
  is dropped by `--gc-sections`.
- `lifefi_config.h`: new "Fixed transmitter" section with
  `#ifndef` defaults: `LIFEFI_ROLE_TX 0`, `LIFEFI_TX_CHANNEL 11`,
  `LIFEFI_TX_RATE_HZ 100`, `LIFEFI_TX_ID 1`, `LIFEFI_TX_LED_GPIO -1`,
  `LIFEFI_TX_LED_ACTIVE_LOW 0`, `LIFEFI_TX_MAC_PREFIX {0x1A,0x4C,0x46,0x54,0x58}`,
  `LIFEFI_TX_PROBE 1` (receiver side), `LIFEFI_TX_PROBE_MS 150`.
- `platformio.ini`: three envs using `extends`:

  ```ini
  ; Fixed transmitter (docs/hardware/fixed-transmitter.md): ESP-NOW at 100 Hz
  [env:esp32dev_tx]
  extends = env:esp32dev
  build_flags = -DLIFEFI_ROLE_TX=1 -DLIFEFI_TX_LED_GPIO=2

  [env:esp32s3_tx]
  extends = env:esp32s3
  build_flags = -DLIFEFI_ROLE_TX=1

  [env:esp32cam_tx]
  extends = env:esp32cam
  build_flags = -DLIFEFI_ROLE_TX=1 -DLIFEFI_TX_LED_GPIO=33 -DLIFEFI_TX_LED_ACTIVE_LOW=1
  ```

  ESP32-CAM: GPIO 33 is the small red LED (active low). **Never GPIO 4**, the
  flash LED (very bright, draws current). S3 DevKitC's LED is a WS2812 on 48:
  no LED there.
- **First thing to verify (10 min):** that `build_flags` reach the `src`
  component under PlatformIO's ESP-IDF builder. Put
  `#if LIFEFI_ROLE_TX` + `#warning` in tx_main.c on the first build, look for
  it in the output, then remove. **Fallback** if the flag does not arrive:
  a separate project `firmware/tx/` (own `platformio.ini`, `CMakeLists.txt`
  with `EXCLUDE_COMPONENTS esp_lcd`, `src/CMakeLists.txt`, copy of
  `sdkconfig.defaults` minus the CSI lines), built with
  `pio run -d firmware/tx -e esp32cam`. Same code, only the location changes.
- `firmware/.gitignore`: add `/sdkconfig.esp32dev_tx`, `/sdkconfig.esp32s3_tx`,
  `/sdkconfig.esp32cam_tx` and their `.old` (the existing ones are ignored).

### 2.3 Transmitter behaviour (`tx_main.c`)

Boot order: NVS init → load settings (NVS namespace `lifefi_tx`, keys
`channel`, `rate`, `id`; build-flag defaults) → console UART driver (same
`uart_driver_install` + `uart_vfs_dev_use_driver` as `commands.c`) →
`esp_netif_init`, default event loop, `esp_wifi_init`, storage RAM, country
`LIFEFI_COUNTRY`, mode STA, bandwidth HT20, `esp_wifi_set_mac`, start, PS off,
`esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE)` → `esp_now_init`, add
broadcast peer (channel 0 = current, `ifidx = WIFI_IF_STA`), set peer rate →
send task + periodic timer.

- Send callback (`esp_now_register_send_cb`; check its IDF 5.5 signature,
  it takes `const esp_now_send_info_t *` now) counts ok / failed.
- Log once at start (the line the owner looks for):
  `I (...) tx: Life-Fi fixed transmitter v0.1.0: ESP-NOW 100 Hz on channel 11 as 1A:4C:46:54:58:01, HT20 MCS0`.
- Every 10 s: `tx: sent 1000 (+1000), failed 0, 100 Hz, ch 11, heap N`.
- LED: toggle every `rate` frames (1 Hz blink = sending; steady off = not
  sending; fast blink 5 Hz = Wi-Fi/ESP-NOW init failed).
- Serial commands (921600 baud, `help` on boot), saved to NVS and applied
  live (channel via `esp_wifi_set_channel`, rate by restarting the timer,
  id by `esp_wifi_set_mac` needs Wi-Fi stopped: just save and `esp_restart()`):
  `status | rate <10-500> | channel <1-13> | id <1-254> | help`.
  The line reader is ~25 lines; keep it local to `tx_main.c` (commands.c is
  receiver-specific and host-tested; do not touch its parser).

### 2.4 Receiver change (minimal, additive)

`wifi_link.c` / `.h`:

- New mode `LINK_FIXED_TX` in `link_mode_t`.
- New `static bool probe_fixed_tx(void)` run in `wifi_link_start()` **after**
  `esp_wifi_start()` + `csi_capture_start()` and **before** the station
  connect, when `LIFEFI_TX_PROBE` and the NVS key `tx_probe` (default on)
  allow it:
  1. `s_mode` must not be `LINK_STATION` while probing, so the `STA_START`
     handler does not connect: set `s_mode = LINK_SNIFFER` before
     `esp_wifi_start()`, decide the real mode after the probe, and when it
     ends in station mode call `esp_wifi_connect()` explicitly (the event
     has already fired).
  2. Promiscuous on (filter MGMT | DATA, as `start_sniffer`), then for
     channel `LIFEFI_TX_CHANNEL` first (300 ms), then 1..13 except that one
     (`LIFEFI_TX_PROBE_MS` each, ~2.1 s worst case): set channel,
     `csi_capture_survey_start()`, wait, `csi_capture_survey_stop()`, look
     for an entry whose MAC starts with the prefix and has ≥ 5 frames
     (survey_add already requires len ≥ 128 and HT20, so a match proves usable
     CSI). Stop at the first channel with a match; if several TX ids, take
     the busiest.
  3. Found: `s_mode = LINK_FIXED_TX`, copy MAC/channel, `s_ssid = "Life-Fi TX NN"`,
     stay promiscuous on that channel, `csi_capture_set_target(mac)`, log
     `link: fixed transmitter 1A:4C:46:54:58:01 on channel 11, 98 Hz in the probe`
     and return `ESP_OK` (no station, no AP survey). Not found: promiscuous
     off, log `link: no Life-Fi fixed transmitter found (2.1 s probe)` and go
     on exactly as today (station if credentials, else sniffer).
- **The fixed TX wins over saved station credentials**: that is the point of
  it. `tx off` turns the probe off for people who want the router back.
- `wifi_link_describe`: for `LINK_FIXED_TX`, `FIXED TX "Life-Fi TX 01" <mac> ch 11`.
  No new text may contain `disconnected (reason`, `waiting for the
  transmitter`, `| <STATE> people=` (engine regexes in `engine/lifefi/sources.py`).
- `wifi_link_connected()` stays "station only" so `stream_start()` (UDP) is
  skipped; the USB stream (`usbstream`, `@CSI` lines) works in any mode.
  The `.csirec` / `@CSI` format is unchanged: `src_mac` in the frame header
  will simply be `1A:4C:46:54:58:01`, `sig_mode` HT, len 384 as in station mode.
- New `esp_err_t wifi_link_set_tx_probe(bool on)` (NVS key `tx_probe` in the
  existing `lifefi` namespace) and a receiver command in `commands.c`:
  `tx auto` / `tx off` (save + restart, like `wifi clear`), `tx` alone prints
  the current setting. Add it to `print_help()`.
- Host test: `test/host/test_commands.c` stubs `wifi_link_save_credentials`;
  add a stub for `wifi_link_set_tx_probe` and two cases (`tx off`, `tx auto`
  call it with false / true; `tx bogus` does not). Run
  `powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1`.
- If the TX disappears later the receiver logs the existing "waiting for the
  transmitter" warning every second (the engine already turns that into a
  dashboard note). No automatic re-probe tonight; a reset re-probes.

Not in scope tonight: engine/UI changes (track C owns `sources.py`; a
follow-up could set `transmitter_fixed` when `src_mac` starts with
`1A:4C:46:54:58`, mention it in the report, do not edit it), loss counting
from the payload seq, multiple receivers.

## 3. Files

| File | Change |
|---|---|
| `firmware/platformio.ini` | 3 `_tx` envs |
| `firmware/.gitignore` | ignore the new sdkconfig.*_tx files |
| `firmware/src/lifefi_config.h` | fixed-transmitter section |
| `firmware/src/tx_main.c` | **new**, transmitter app |
| `firmware/src/main.c` | `#if !LIFEFI_ROLE_TX` around `app_main` |
| `firmware/src/wifi_link.c`, `wifi_link.h` | `LINK_FIXED_TX`, probe, `wifi_link_set_tx_probe` |
| `firmware/src/commands.c` | `tx [auto\|off]` command + help |
| `firmware/test/host/test_commands.c` | stub + cases |
| `firmware/README.md` | step "dedicated transmitter: firmware done, untested on hardware" in the table; link to the hardware doc |
| `docs/hardware/fixed-transmitter.md` | **new**, owner guide (§5) |

## 4. Steps and acceptance

(Revised by the critic, see revisions 1, 2, 9, 15.)

1. `lifefi_config.h`, `platformio.ini` (`esp32dev_tx`, `esp32cam_tx`),
   `.gitignore`, `main.c` guard, `tx_main.c`. Start the `esp32dev_tx` build in
   the background with `-v` (doubles as the role-flag check, revision 10).
   (35 min incl. the ~6 min build)
2. While it builds: `docs/hardware/fixed-transmitter.md` + README row, written
   for "TX done, receiver lock pending"; fix TX compile errors. (25 min)
3. Receiver: `tx_match.c/.h`, probe + `LINK_FIXED_TX` + `wifi_link_set_tx_probe`,
   `tx` command, host tests (`ALL HOST TESTS PASSED`). Touch
   `src/CMakeLists.txt` mtime, build `esp32cam` then `esp32dev`. (40 min)
4. Update the guide to "receiver lock done"; build `esp32cam_tx`, then
   `esp32s3` if time remains. (15 min)

If step 3 cannot finish cleanly: revert the receiver files to their original
content by hand (no git commands), leave the guide at "lock pending".

Acceptance (all without hardware):

- `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e <env>` from
  `firmware/` succeeds, **no new warnings in our sources**, for all six envs:
  `esp32dev_tx esp32cam esp32dev` required, `esp32cam_tx esp32s3` if reached
  (critic revision 15).
  Measured tonight: `esp32dev` with an existing build dir 134 s; a fresh env
  (every new `_tx` env) 5 min 46 s. Budget ~25 min of builds; run them
  sequentially (shared toolchain), in the background, and do docs meanwhile.
- The TX image does not contain the receiver: `pio run -e esp32cam_tx -t size`
  or grep the `.map` for `estimator_push` (absent = gc worked; not fatal if
  present, just note it).
- Host tests: `ALL HOST TESTS PASSED`.
- `git diff` of the receiver shows no change to the `@CSI` line format,
  `csi_frame.*`, `stream.c`, or any estimator log line.
- No `-t upload` anywhere in the worker's commands.

## 5. Owner guide (content of `docs/hardware/fixed-transmitter.md`)

1. **Which board**: any classic ESP32 dev board (`esp32dev_tx`), an ESP32-S3
   DevKitC (`esp32s3_tx`), or a second ESP32-CAM (`esp32cam_tx`, flashed
   through the ESP32-CAM-MB shield like the receiver).
2. **Flash** (receiver unplugged so there is only one COM port, or add
   `--upload-port COMx`):
   ```powershell
   cd firmware
   $pio = "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe"
   & $pio run -e esp32cam_tx -t upload -t monitor
   ```
   Expect the `tx: Life-Fi fixed transmitter ... 100 Hz on channel 11 as 1A:4C:46:54:58:01`
   line, then a `tx: sent ...` line every 10 s with `failed 0`, and the LED
   blinking once a second. Ctrl+C.
3. **Power**: any 5 V USB phone charger (≥ 1 A) and a cable; the TX needs no
   PC. ESP32-CAM without the MB shield: 5 V to the `5V` pin, GND to `GND`.
   Weak supplies brown out the ESP32-CAM when it transmits (endless reboots
   in the log): use a better charger / shorter cable.
4. **Placement** in a 2–2.5 m room: put TX and receiver on **opposite sides**
   of the area people use, so the direct path crosses it, **2–2.5 m apart**,
   both at about 1 m height (table / shelf), PCB antennas (the end of the
   board without components) facing each other, not on or behind metal,
   not within 0.5 m of each other. **Fix the TX in place** (tape / blu-tack):
   moving it, even a little, changes every reading, same as the phone did.
   Nothing that moves (fan, curtain) right next to either board.
5. **Order**: power the TX first, then reset / plug in the receiver (it
   looks for the TX only at boot, ~2 s). Receiver log:
   `link: fixed transmitter 1A:4C:46:54:58:01 on channel 11, ~100 Hz in the probe`;
   every 15 s `wifi FIXED TX "Life-Fi TX 01" ...`; estimator lines show
   `rate= ~100Hz` steadily. In the dashboard the live rate should sit near
   100 Hz without the multi-second gaps the hotspot had.
6. **Recalibrate** with the room empty: `cal` in the receiver console (or
   the dashboard's calibration), then record new labelled sessions (plan A
   asks for 3+, each with 60 s empty at start and end).
7. **Troubleshooting**: "no Life-Fi fixed transmitter found" → TX not
   powered, or out of range; check its log. Rate low or gappy → another
   network on the same channel: `channel 13` (or 1 / 6) in the TX console,
   then reset the receiver. Want the router / hotspot back: `tx off` on the
   receiver; `tx auto` re-enables.

## 6. Risks

| Risk | Mitigation |
|---|---|
| ESP-NOW frames reported with no / bad CSI (11b rate if the rate call silently fails) | Probe requires ≥ 5 usable (len ≥ 128, HT20) frames, so a bad TX is simply not locked; TX logs which rate API succeeded; doc tells the owner to check `rate=` |
| `esp_now_set_peer_rate_config` unsupported for broadcast on classic ESP32 | Fallback to the deprecated `esp_wifi_config_espnow_rate` (§2.1) |
| `esp_wifi_set_mac` rejected (must be STA, valid unicast) | `1A:...` is unicast + locally administered; check return value, log, keep going with the factory MAC (receiver would then not lock: log says so) |
| `build_flags` not applied to the ESP-IDF `src` component | Fallback `firmware/tx/` project (§2.2) |
| Probe changes boot behaviour when no TX | Only adds ~2.1 s, then the existing code path runs unchanged; STA_START no longer auto-connects in that window, so the explicit `esp_wifi_connect()` must be tested by reading the code path carefully (cannot test on hardware) |
| Channel conflict with the sniffer survey | Not an issue: when the TX is found the AP survey is skipped; when not, the survey runs as before. A busy router on the TX channel only costs collisions: change TX channel |
| ESP32-CAM brown-out / PCB antenna weak | Doc: good charger; IPEX antenna needs the 0 Ω jumper moved (not tonight) |
| TX at 100 Hz on a shared channel bothers other Wi-Fi | ~0.1 % airtime at MCS0 with a 12-byte payload; negligible |
| Untested on hardware tonight | Docs and report say "compiles, untested on a board"; the first morning check is §5 step 5 |

## 7. Measured

- `pio run -e esp32dev` (existing build dir, reconfigure + relink): **134 s**.
- `pio run -e esp32cam` (fresh build dir, full ESP-IDF compile): **5 min 46 s**.
  Each new `_tx` env is a fresh build dir: expect ~6 min each the first time,
  so ~18 min for the three TX envs plus ~2 min per receiver env. Run builds
  sequentially in the background and write docs meanwhile.

## Worker report

**Shipped (compiles and is host-tested, not run on a board):**
- Transmitter app `firmware/src/tx_main.c` (`#if LIFEFI_ROLE_TX`). It sends ESP-NOW broadcasts from MAC `1A:4C:46:54:58:01` on channel 11 at 100 Hz, HT20 MCS0. The rate is set with `esp_now_set_peer_rate_config`, falling back to the deprecated call; the start line logs which one worked. Pacing uses `xTaskDelayUntil`. Status line every 10 s, LED on GPIO 2 / 33, commands `status | channel | rate | help` saved in NVS `lifefi_tx`.
- Envs `esp32dev_tx` and `esp32cam_tx` in `platformio.ini`, plus their `.gitignore` entries. `.pio/` was already ignored by `firmware/.gitignore`; the root `.gitignore` has no pio entry, which is fine.
- Receiver lock in `wifi_link.c`:
  - Boot probe: 400 ms on ch 11, then 120 ms on each other channel. It locks onto a prefix match with at least 5 frames, using `LINK_FIXED_TX`, and logs `link: fixed transmitter ... rssi N`.
  - The probe is gated by `LIFEFI_TX_PROBE` and the NVS `tx_probe` key. With it off, the old path is unchanged.
  - New `tx_match.c/.h` and the `tx [on|off]` command. The describe line becomes `FIXED transmitter "Life-Fi TX 01" ...` with the same trailing fields.
- `main.c` body is guarded with `#if !LIFEFI_ROLE_TX`.
- Owner guide `docs/hardware/fixed-transmitter.md`; README rows for the step, the mode and the command.

**Commands run (from `firmware/`; never upload or monitor):**
- `pio run -e esp32dev_tx -v`: compiled and linked, `-DLIFEFI_ROLE_TX=1` confirmed on the `tx_main.c` line. It then failed in PlatformIO's own verbose printer (`TypeError: '_Null' + 'str'` in SCons `print_cmd_line`). That is a `-v` bug, not our code.
- Set the mtime of `src/CMakeLists.txt`, then non-verbose builds: `esp32dev_tx` SUCCESS 292 s, `esp32cam` SUCCESS 284 s, `esp32dev` SUCCESS 254 s, `esp32cam_tx` SUCCESS 277 s. No warnings in `src/`. An earlier unused `csi_task` warning in the TX build was fixed by moving the guard.
- TX `.map`: `estimator_push`, `wifi_link_start` and `probe_fixed_tx` are in the discarded sections, so gc works. Flash use: TX 771 KB, receiver 820–832 KB.
- `powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1`: ALL HOST TESTS PASSED. That includes the new `test_tx_match` (5 checks) and the `tx` cases in `test_commands`.

**Dropped:**
- `esp32s3_tx` (critic) and the optional `esp32s3` receiver build. It was skipped for time; it shares every changed file with `esp32dev`.
- The TX `id` command (critic).
- The engine follow-up for track C/A: in `sources.py`, mark the transmitter as fixed when `src_mac` starts with `1a:4c:46:54:58`. Not edited here.

**Owner's morning steps:**
1. Stop the Life-Fi app. With only the spare ESP32 on USB, run `& $pio run -e esp32dev_tx -t upload -t monitor` (or `esp32cam_tx`). Look for the `tx: Life-Fi fixed transmitter ... as 1a:4c:46:54:58:01` line and `failed 0`.
2. Re-flash the receiver once: `& $pio run -e esp32cam -t upload`.
3. Power the TX from a USB charger and fix it in place 2–2.5 m from the receiver, across the room, both about 1 m high.
4. Reset the receiver. Expect `link: fixed transmitter ... on channel 11, ~100 Hz` and `rate= ~100Hz`. If you want the router back, type `tx off`.
5. Run `cal` with the room empty, then record new labelled sessions. Full guide: `docs/hardware/fixed-transmitter.md`.
