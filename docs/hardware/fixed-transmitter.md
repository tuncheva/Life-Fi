# Fixed transmitter: a second ESP32 as the CSI source

> **Status (2026-11-03):** transmitter firmware and the receiver's
> transmitter search are written, compile (`esp32dev_tx`, `esp32cam_tx`,
> `esp32dev`, `esp32cam`) and pass the host tests, but have **not run on a
> board yet**. Flash **both** boards: the transmitter, and the receiver again
> (its search for the transmitter is new).

So far the CSI came from a phone hotspot. When the phone moves, every reading
moves with it, and even lying still the empty-room profile drifted 7.4 dB in
10 minutes. A second ESP32 that stays in one place and sends a steady
100 frames per second fixes that: no router and no phone are needed.

How it works: the transmitter sends ESP-NOW broadcasts (tiny 12-byte frames)
on channel 11 at 802.11n MCS0, 20 MHz, from the fixed MAC address
`1A:4C:46:54:58:01`. The rate matters: ESP-NOW's default 1 Mbps 802.11b
frames carry no CSI. The receiver looks for that MAC on every channel for
about 2 s when it boots and, if it finds it, takes its CSI only from the
transmitter. Same approach as Espressif's esp-csi `csi_send` / `csi_recv`.

## 1. Which board

| Board | Build target | LED |
|---|---|---|
| Any classic ESP32 dev board (CH340 / CP2102) | `esp32dev_tx` | GPIO 2 blinks (most boards; some have no user LED) |
| A second ESP32-CAM, flashed through the ESP32-CAM-MB shield | `esp32cam_tx` | small red LED (GPIO 33) blinks. The bright flash LED stays off |

An ESP32-CAM also runs `esp32dev_tx` (same chip); it just won't blink.

## 2. Flash the transmitter

Stop the Life-Fi app first if it is running: it holds the receiver's COM port.
Unplug the receiver so only one COM port is there, or add `--upload-port COMx`
(the transmitter's port from Device Manager).

```powershell
cd firmware
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe"
& $pio run -e esp32dev_tx -t upload -t monitor     # or -e esp32cam_tx
```

ESP32-CAM-MB: if the upload says `Failed to connect`, hold **IO0** (BOOT)
while it starts connecting (or hold IO0, tap RST, release IO0), then tap
**RST** after flashing to run the firmware.

In the monitor (921600 baud) expect:

```
I (612) tx: Life-Fi fixed transmitter v0.1.0: ESP-NOW 100 Hz on channel 11 as 1a:4c:46:54:58:01, HT20 MCS0 (via esp_now_set_peer_rate_config)
I (10620) tx: sent 1000 (+1000), failed 0, 100 Hz (set 100), ch 11, heap 215000
```

- The MAC must start with `1a:4c:46:54:58`. If an error says
  `esp_wifi_set_mac` failed, the receiver will not recognise it.
- `Wi-Fi / ESP-NOW start failed, NOT sending` (LED blinks fast, 5 Hz): send
  the log to the team.
- The LED blinks once a second while sending.

Commands (type and press Enter; saved in the board's flash, applied at once):

| Command | Does |
|---|---|
| `status` | Print the counters line now |
| `channel N` | Send on channel N (1-13). Reset the receiver afterwards so it finds it again |
| `rate N` | Frames per second, 10-500 (default 100) |
| `help` | List commands |

Ctrl+C closes the monitor; the transmitter keeps sending.

## 3. Power

Any 5 V USB phone charger (1 A or more) and a cable: the transmitter needs no
PC. ESP32-CAM without the MB shield: 5 V to the `5V` pin, GND to `GND`. A weak
supply makes the ESP32-CAM reboot whenever it transmits (`Brownout detector
was triggered`, endless restarts in the log): use a better charger or a
shorter cable.

## 4. Placement (2-2.5 m room)

- Transmitter and receiver on **opposite sides** of the area people use, so
  the straight line between them crosses it; **2-2.5 m apart**, not closer
  than 0.5 m.
- Both at about 1 m height (table, shelf), the antenna ends of the boards
  (the end with the wavy PCB trace, no components) facing each other; not on
  or behind metal.
- **Fix the transmitter in place** (tape, blu-tack). Moving it, even a little,
  changes every reading, just as the phone did. Nothing that moves (fan,
  curtain) right next to either board.
- Signal strength at the receiver should be about -30 to -45 dBm (the `rssi`
  in the receiver's `link:` line). Stronger than -25 dBm: move them further
  apart.

## 5. Start order and what the receiver shows

Flash the receiver once with this firmware version (same command as before,
e.g. `& $pio run -e esp32cam -t upload`; only one board on USB, or
`--upload-port COMx`). Its saved Wi-Fi and `learn` levels stay in flash.

Power the transmitter first, then reset or plug in the receiver: it looks for
the transmitter only at boot (about 2 s). The receiver log shows:

```
I (1450) link: fixed transmitter 1a:4c:46:54:58:01 on channel 11, 98 Hz in the probe, rssi -41
I (16000) main: wifi FIXED transmitter "Life-Fi TX 01" 1a:4c:46:54:58:01 ch 11 | ping timeouts 0 | disconnects 0 | csi 1490, ...
I (31000) lifefi: t=   31s rate= 99Hz rssi= -41 ...
```

The fixed transmitter wins over saved Wi-Fi credentials. In the dashboard
the live rate should sit near 100 Hz without the multi-second gaps the
hotspot had. The `.csirec` / USB stream format is unchanged; recordings just
show `1A:4C:46:54:58:01` as the source.

Not found: `link: no Life-Fi fixed transmitter found (1.8 s probe)`, then the
receiver carries on exactly as before (router / hotspot if credentials are
saved, else sniffer).

## 6. After the first good run

Recalibrate with the room empty (`cal` in the receiver console, or the
dashboard's calibration), then record new labelled sessions: at least 3, each
with 60 s of empty room at the start and end. Recordings made with the phone
hotspot do not mix with these.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Want the router / hotspot back | Type `tx off` in the receiver console (saved, the board restarts and behaves exactly as before). `tx on` turns the search back on, `tx` shows the setting. No reflash needed |
| `no Life-Fi fixed transmitter found` | Transmitter not powered, still booting (power it first), or too far; check its log for `sent ... failed 0` |
| Rate low or gappy | Another network on the same channel: `channel 1`, `6` or `13` in the transmitter console, then reset the receiver |
| Receiver keeps logging `waiting for the transmitter` | The transmitter stopped or was unplugged after the receiver locked: power it, then reset the receiver |
| ESP32-CAM transmitter reboots in a loop | Power supply (see 3) |

To go back to the previous receiver firmware completely, rebuild it from
commit `892526c` (before this change); `tx off` is normally enough.

Untested on hardware: written and compiled on 2026-11-03 without a board
connected. The first real check is section 5.
