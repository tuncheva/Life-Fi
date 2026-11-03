# Running Life-Fi (ops runbook)

One Windows PC runs everything: the ESP32 on USB, the Python engine, and the
Next.js dashboard with its backend. Phones on the same LAN open the dashboard
and get ntfy notifications. It is a local appliance, not a cloud service.

Commands marked *(not verified tonight)* were not run on 2026-11-03 (no board,
no admin rights needed for them); everything else was.

## Install

1. Node.js **22.13 or newer** (`node:sqlite` without a flag) and Python **3.12**.
2. USB serial driver for the board (CH340 or CP210x, depending on the board) *(not verified tonight)*.
3. In the repo folder:

```powershell
python -m venv .venv
.venv\Scripts\pip install -r engine\requirements.txt
npm ci
npm run build
```

`npm run build` is needed once, and again after every update.

## Run

```powershell
npm run start                         # the board over USB, port found by itself
npm run start -- --serial COM3        # arguments after -- go to engine/run.py
npm run start -- --replay firmware\recordings\second.csirec --loop   # a recording instead of the board
```

`npm run start` (`scripts/start.mjs`) first checks the setup and stops with one
line saying what is wrong and how to fix it: Node version, the build exists,
Python and its packages, the dashboard port and engine port 6000 are free, the
data folder is writable. Then it starts the engine and the dashboard, prefixes
their output with `[engine]` / `[app]`, and copies it to the log file.

A crashed engine or dashboard is restarted after 1, 2, 4, 8, 16, then every
30 s (back to 1 s once it has run for a minute). An engine that refuses its
arguments (exit 2) is not restarted: everything stops with exit code 2.
With the board unplugged the engine does **not** crash; it keeps retrying the
port every 2 s and the dashboard shows "sensor offline".

Stop: **Ctrl+C** in its window (both children stop; after 10 s anything left is
killed). A hard kill of the window (Task Manager on `node.exe`) can leave the
engine running: the next start then says port 6000 is in use (see Troubleshooting).

`npm run dev` is the developer mode (hot reload, `next dev` on port 3000); do not use it for the real room.

### Settings by environment

| Variable | Default | Meaning |
|---|---|---|
| `LIFEFI_HOST` | `127.0.0.1` | Where the dashboard listens. `0.0.0.0` = the whole LAN (phones, ntfy ack links) |
| `LIFEFI_PORT` | `3000` | Dashboard port |
| `LIFEFI_DATA_DIR` | `data` | History database, settings, calibration, logs, recordings (relative to the repo) |
| `LIFEFI_DB` | `<data>/lifefi.sqlite` | SQLite file; `:memory:` keeps nothing |
| `LIFEFI_PIN` | `1234` | First PIN only (4–8 digits); after that the PIN in settings wins |
| `LIFEFI_ENGINE_HOST` / `LIFEFI_ENGINE_PORT` | `127.0.0.1` / `6000` | Where the backend finds the engine |
| `LIFEFI_PROFILES` | `contracts/profiles.yml` | Alert profiles |
| `LIFEFI_LOG` | `info` | `debug`, `info`, `warn`, `error` |

A bad value (e.g. `LIFEFI_ENGINE_PORT=abc`) does not crash the server: the log
prints `life-fi: invalid configuration` with the list, and every API call
answers `500 {"error":"config"}` with the same list until it is fixed and the
app restarted. The engine reads `--calibration` (default `data/calibration.json`);
with a non-default `LIFEFI_DATA_DIR`, pass a matching `--calibration` too.

PowerShell example: `$env:LIFEFI_HOST = "0.0.0.0"; npm run start`.

## Autostart on Windows *(not verified tonight)*

Task Scheduler → Create Task: trigger **At log on**; action **Start a program**
`npm.cmd`, arguments `run start`, start in the repo folder (add
`$env:LIFEFI_HOST` etc. as system environment variables instead); Settings →
**If the task fails, restart every 1 minute**. The supervisor already restarts
the engine and the dashboard; the task only covers the supervisor itself.

## First run

1. Start with `LIFEFI_HOST=0.0.0.0` so phones can reach it (the default only allows this PC).
2. Open `http://<pc-ip>:3000` (find the IP with `ipconfig`). In Settings set
   `dashboard_url` to that address, so notification links work.
3. **Change the PIN** (default `1234`).
4. **Calibrate the empty room** (2 min, nobody inside).
5. Set the ntfy topic and send a test notification.

`GET /api/v1/setup` lists what is left (`engine`, `board`, `pin`,
`calibration`, and optional `notify`, `lan`); the dashboard's setup page uses it.

## Health

`GET /api/v1/health` answers **200** when the server can do its job
(`ok`: engine connected and storage fine) and **503** otherwise, with the same
JSON body (`?soft=1` always answers 200). `ready` adds "people are being
sensed": a result less than 5 s old and no `sensor_offline`. Checks:
`engine`, `board` (source, seconds since the last result, CSI rate, the
engine's read error), `calibration` (never fails health; it is a setup step),
`storage` (data folder writable, database size, free disk > 500 MB).

```powershell
curl.exe -s http://127.0.0.1:3000/api/v1/health
```

## Update

```powershell
# Ctrl+C the running app first
git pull
npm ci
.venv\Scripts\pip install -r engine\requirements.txt
npm run build
npm run start
```

The data folder is never touched by an update.

## Back up and restore

Stop the app first (or copy only after Ctrl+C), then copy the data folder. What is in it:

| File | What |
|---|---|
| `lifefi.sqlite`, `lifefi.sqlite-wal` | history and alerts |
| `settings.json` | settings, **including the PIN in plain text** |
| `calibration.json` | the empty-room calibration |
| `position.json`, `spots_model.json` | distance fit and spot model |
| `sessions/` | recordings and labels (training data) |
| `logs/` | the logs |

Restore = stop, copy the folder back, start.

## Data growth

History and alerts older than `retention_days` (Settings, default 30) are
deleted every hour. Recordings in `data/sessions/` are **never** deleted
automatically: they are training data; move them off the PC by hand. Logs
older than 14 days are deleted at each start. Watch `storage.free_bytes` in
`/api/v1/health`.

## Logs

`<data>/logs/lifefi-YYYY-MM-DD.log` (one file per day), the same lines the
window shows, each with the time. `LIFEFI_LOG=debug` for more.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `start: the dashboard is not built` | `npm run build` |
| `start: Python packages missing` | `.venv\Scripts\pip install -r engine\requirements.txt` |
| `start: engine port 6000 is in use` | an engine from an earlier run is still alive: `Get-NetTCPConnection -LocalPort 6000 \| % OwningProcess` then `Stop-Process -Id <pid>` |
| `start: port 3000 on … is in use` | another server (often `npm run dev`); stop it or set `LIFEFI_PORT` |
| board not found (`no USB serial port found` in health/setup) | Device Manager → Ports: is the board there? Try another cable (charge-only cables have no data). Close the Arduino / PlatformIO serial monitor. Or pass `--serial COM3` *(not verified tonight: board not connected)* |
| `sensor_offline` alert | the engine has been disconnected, or no result came, for 10 s (30 s grace after start), CSI rate under 50 Hz for 60 s, or the board stopped sending status. Check the board and its power |
| `[start] engine exited (code …), restarting in …` repeating | read the `[engine]` lines just above it in the log |
| `life-fi: invalid configuration` | fix the listed `LIFEFI_*` variables and restart |
| writes answer `429 rate_limited` | 5 wrong PINs in a minute lock writes (60 s, doubling to 1 h). Wait, or restart the app |

## Security notes

- The dashboard is for the LAN only: plain HTTP, no accounts. **Never port-forward it** to the internet.
- **Reads are open** to anyone who can reach it (live presence is personal data): that is why the default bind is `127.0.0.1`; opening it with `LIFEFI_HOST=0.0.0.0` is a choice.
- The PIN guards every change (settings, calibration, recordings, acknowledging alerts). Phone notifications carry a one-time ack token, never the PIN.
- The engine's control port 6000 is loopback-only and has no authentication.
- `settings.json` holds the PIN in plain text: protect the data folder like the PC itself.
