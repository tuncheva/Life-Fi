# HTTP + Server-Sent Events API (backend → dashboard)

Served by the Next.js app in `ui/` (route handlers under `ui/src/app/api/v1`,
the backend in `ui/src/server`), same origin as the dashboard.

Source: plan-v2 §4.7, §7, §8. This file is the contract. Change it here first.

Base path `/api/v1`. JSON bodies. Times are ms since epoch (UTC) unless the
field name ends in `_us`.

## Authentication

Reads are open on the LAN. **Writes need the PIN**, sent as
`X-Lifefi-Pin: <pin>`. A wrong or missing PIN answers `401` with
`{"error": "pin"}`.

Writes: every `POST` and `PUT` below.

Wrong PINs are limited (one bucket for the whole server): 5 wrong PINs within
60 s lock every write for 60 s (`429` `rate_limited`, `Retry-After: <s>`);
each further lockout doubles it, up to 1 h. A right PIN outside a lockout
resets it; so does an hour without wrong PINs, or restarting the server. The
phone's one-time ack token is not limited. Every accepted PIN also sets the
`lifefi_trust` cookie (HttpOnly, an HMAC of the PIN under a per-install key in
`data/trust.key`; a PIN change revokes it); a request with that cookie and the
right PIN is not locked out, so a browser that has used the PIN before can still
acknowledge an alert while someone else hammers wrong PINs.

## Errors

`{"error": "<code>", "message": "<human text>"}`. Codes: `pin`, `engine_offline`,
`bad_request`, `not_found`, `conflict`, `rate_limited` (429), `internal` (500,
an unexpected server error; details only in the server log), `config` (500, the
server's `LIFEFI_*` environment is invalid; `message` lists every problem).

A body that is present but not JSON is `400 bad_request`; a write body over
64 KB is `413 bad_request`. Bounds: `calibrate.duration_s` 10–1800,
`source.speed` 0.1–20, `position/fit` `d_m` 0.3–8 and `seconds` 5–120,
`settings.retention_days` 1–3650. A replay `file` must be a `.csirec` under
`firmware/recordings/` or `<data>/sessions/` (relative paths are from the repo
root; the server sends the engine the absolute path).

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/status` | — | `Status` (below) |
| GET | `/health?soft=` | — | `Health` (below); `200` when `ok`, else `503` with the same body. `?soft=1` always answers `200` (for pages that poll it) |
| GET | `/setup` | — | `Setup` (below), always `200` |
| GET | `/position` | — | `{"fit": PositionFit \| null, "spots": SpotsSummary \| null}` (below) |
| GET | `/history?from=&to=&fields=` | — | `{"rows": [HistoryRow]}`; `fields` is a comma list of `presence,motion,breathing,posture,count` |
| GET | `/recent?minutes=N` | — | `Recent` (below): the last N minutes (1..15, default 15) of results, one sample per result; `400` for any other `minutes` |
| GET | `/alerts?state=` | — | `{"alerts": [Alert]}`; `state` is a comma list of `pending,open,acked,resolved,dropped`; default `open,acked` |
| POST | `/alerts/{id}/ack` | `{"by": "Maria's phone"}` (optional, ≤ 40 chars) | `Alert` with `acked_by` |
| GET | `/profile` | — | `{"active": "home", "profiles": {…}}` (the `profiles` block of `profiles.yml`) |
| PUT | `/profile` | `{"active": "clinic"}` | same as GET |
| POST | `/calibrate` | `{"kind": "empty", "duration_s": 120}` | `{"started": true}`; `409` while one is running. Progress and outcome arrive as `status` live messages: `calibration_job` (below) plus the engine's `calibration.state` in every result |
| GET | `/recordings` | — | `{"recordings": [{"session","file","bytes","labels"}], "recording": Recording \| null, "vocabulary": {"segments": [...], "marks": [...]}}` |
| GET | `/recordings/labels?session=` | — | `{"session", "labels": [lines of labels.jsonl], "open_segment"}`; `session` defaults to the one recording |
| GET | `/source` | — | `Source` |
| PUT | `/source` | `Source` without `state` | `Source` |
| POST | `/recordings/start` | `{"session": "s03", "meta": {…}}` (meta goes into `session.json`) | `{"session": "s03", "started_us"}`; `409` if recording or not live |
| POST | `/recordings/stop` | `{}` | `{"session": "s03", "frames": 12345, "labels": 17}`; ends an open segment first |
| POST | `/recordings/segment` | `{"action":"start","label","count","subject","spot"}` or `{"action":"end"}` | `{"ended": segment \| null, "open_segment"}`; starting a segment ends the open one (segments never overlap) |
| POST | `/recordings/mark` | `{"event","subject"}` | the written mark line |
| POST | `/position/fit` | `{"d_m": 2, "seconds": 25}` | engine `position_fit` ack data `{"A","n","R_db","windows"}`; `409` when too little movement was seen |
| GET | `/spots` | — | `SpotsOverview` (below) |
| GET | `/spots/teach` | — | `RunState \| null` (cheap; the /teach page polls it while a run is active) |
| POST | `/spots/teach` | `{"distances": {"close": 0.5, "middle": 1.5, "far": 3}, "rounds": 1 \| 2, "transmitter": "fixed" \| "phone"}` | `RunState`; `400` on bad input; `409` when not ready (engine not connected, source not live, no readings at ≥ 20/s, a recording, run, training or calibration is active) |
| POST | `/spots/teach/stop` | `{}` | `RunState` (`aborted`, reason "stopped by user"); `409` when no run is active |
| POST | `/spots/train` | `{"sessions": ["spots-20261103-070000", …]}` (≥ 2 usable session ids, same spot names) | `202 {"training": TrainingState}`; the outcome appears in `GET /spots` `training`; `409` while a run or training is active |
| POST | `/spots/restore` | `{}` | swaps `spots_model.json` and `spots_model.prev.json`, then `reload_models` → `{"model", "previous", "engine_reloaded"}`; `409` without a backup or while training |

`Recording` (also in `Status.recording` while a session runs, else `null`; the
server clears it if the engine reports no recording, e.g. after an engine
restart):
`{"session": "s03", "started_us": …, "open_segment": {"t_start_us","label","count","subject","spot"} | null, "labels": 17}`.

Segment labels: `empty`, `standing`, `sitting`, `lying`, `walking`, `normal_activity`, `in_bed`, `bed_empty`, `breath_hold`, `paced_breathing_<bpm>`.
Mark events: `sit_down`, `stand_up`, `lie_down`, `get_up`, `fall`, `bed_exit`, `breath_hold_start`, `breath_hold_end`, `hard_negative_<what>`.
| GET | `/settings` | — | `Settings` |
| PUT | `/settings` | partial `Settings` (+ `pin` to change it, 4–8 digits) | `Settings` |
| POST | `/settings/test-notification` | `{}` | `{"sent": true}`, or `502` `{"error":"notify"}` when ntfy refused or no topic is set |
| GET | `/live` | — | Server-Sent Events, messages below |

### `Status`

```json
{
  "server": {"version": "0.1.0", "uptime_s": 120, "profile": "home", "time_zone": "Europe/Sofia", "room_name": "Room 1", "contact_phone": "", "sensor_offline": null},
  "presence": {"state": "present", "since": 1767225600000, "at_least": false},
  "engine": {"connected": true, "last_result_ms": 1767225600123, "status": { …get_status ack data.engine… }},
  "device": { …get_status ack data.device… } ,
  "source": {"mode": "live", "file": null, "speed": 1, "loop": false, "state": "running", "error": null},
  "recording": null,
  "calibration_job": {"kind": "empty", "duration_s": 120, "started_at": 1767225600000, "state": "running" | "ok" | "failed", "id": null, "error": null, "finished_at": null},
  "result": { …latest Result or null… },
  "alerts_open": 0
}
```

### `Health`

```json
{
  "ok": true,
  "ready": false,
  "version": "0.1.0",
  "uptime_s": 812,
  "checks": {
    "engine":      {"ok": true},
    "board":       {"ok": false, "source": "live", "result_age_s": null, "rate_hz": null, "error": "no USB serial port found", "transmitter": null},
    "calibration": {"ok": false, "state": "none", "id": null, "age_s": null},
    "storage":     {"ok": true, "db_bytes": 1048576, "free_bytes": 52428800000},
    "vitals":      null
  }
}
```

Every field is always present; unknown is `null`. `board.source` is
`live | replay`; `result_age_s` is seconds since the last result (server clock,
1 decimal); `rate_hz` is the last result's rate when it is < 10 s old;
`board.ok` = engine connected, a result < 5 s old and the watchdog not offline.
`calibration.state` is `none | running | ok | stale | null` (from the latest
result, else the engine status); `ok` = `state == "ok"`. `storage.db_bytes` is
the SQLite file plus its WAL; `storage.ok` = the data dir is writable and
`free_bytes` is unknown or > 500 MB.
Top level: `ok` = `engine.ok && storage.ok` (the server can do its job);
`ready` = `ok && board.ok` (people are being sensed). Calibration never fails
`ok` or `ready`: it is a setup step, not an outage.

Informational, **never affects `ok`, `ready` or `Setup`**:
`board.transmitter` is `fixed` when the engine's frames come from the Life-Fi
fixed transmitter (source MAC `1a:4c:46:54:58:xx`, engine status
`device.transmitter`), `other` for a hotspot or router, `null` before the first
frame or with an older engine. `vitals` is `null` unless the latest result is
< 10 s old; then
`{"breathing": {"valid": bool, "reason": string|null}, "heart": {"valid": bool, "reason": string|null} | null}`,
copied from the result (`breathing.reason`, `heart.reason` as in
`results.schema.json`); `heart` is `null` when the result has none.

### `Setup`

```json
{
  "complete": false,
  "steps": [
    {"id": "engine",      "done": true,  "optional": false, "detail": null},
    {"id": "board",       "done": false, "optional": false, "detail": "no USB serial port found"},
    {"id": "pin",         "done": false, "optional": false, "detail": "the PIN is still the default"},
    {"id": "calibration", "done": false, "optional": false, "detail": "no empty-room calibration yet"},
    {"id": "notify",      "done": false, "optional": true,  "detail": "no ntfy topic set"},
    {"id": "lan",         "done": false, "optional": true,  "detail": "only this PC can open the dashboard (set LIFEFI_HOST=0.0.0.0)"}
  ]
}
```

Always these six ids in this order. `detail` is a short English reason when
not done, else `null`; clients key on `id`, never on `detail`. `board` is done
when `Health.checks.board.ok` and the source is live (a replay is never
"done": `"replaying a recording, not the board"`). `pin` is done when the PIN
is not the default `1234`. `calibration` is done when its state is `ok`.
`notify` is done when an ntfy topic is set. `lan` is done when the dashboard
listens on more than loopback (`LIFEFI_HOST`). `complete` = every non-optional
step done.

### `PositionFit` and `SpotsSummary` (`GET /position`)

```json
{
  "fit":   {"A": 16.13, "n": 2.0, "d_m": 2.0, "at": 1793463150102},
  "spots": {"labels": ["close", "middle", "far", "empty"],
            "distances": {"close": 0.4, "middle": 1.2, "far": 2.2, "empty": null},
            "loso_bal_acc": 0.21, "session": "spots-…", "trained_at": 1793463150000}
}
```

Read from the engine's `position.json` (the saved `position/fit`) and
`spots_model.json` in the data dir on every request; a missing or broken file
is `null`. Never the model weights, nor its same-session `holdout_accuracy`; `loso_bal_acc` is the leave-one-session-out balanced accuracy (`null` for a model trained on one session). Times are ms since epoch. The engine writes
these files next to its `--calibration` path (default `data/`): a non-default
`LIFEFI_DATA_DIR` needs a matching `--calibration`.

### Spots (`/spots`, the /teach page)

`GET /spots` → `{"margin", "model", "previous", "candidate", "sessions", "readiness", "teach", "training", "spot_names", "timing"}`:
`model` / `previous` / `candidate` are `ModelSummary | null` for `spots_model.json`, `.prev.json`
and `.candidate.json` in the data dir: `{"labels", "distances", "loso_bal_acc", "loso_by_session",
"holdout_accuracy", "session", "trained_at", "chance" (1/k), "bar" (chance + rules.yaml
spots.reliable_margin), "reliable", "sessions"}`. `sessions` lists every
`<data>/sessions/spots-YYYYMMDD-HHMMSS/`: `{"id", "started_ms", "transmitter": "fixed" | "phone" |
"unknown", "protocol", "labels", "distances", "duration_s", "frames", "rate_hz", "ok", "problem"}`
(`problem` e.g. "stopped early (no spots.json): stopped by user", "no .csirec"). `readiness` is
`[{"id", "ok", "label"}]`, the checks `POST /spots/teach` applies. `training` is
`{"state": "running" | "done" | "failed", "sessions", "started_ms", "ended_ms", "result", "error"}`,
`result` = `{"metrics" (train_spots.py's METRICS line), "promoted", "reason", "engine_reloaded",
"candidate", "model"}`.

`RunState` = `{"session", "state": "running" | "done" | "aborted", "reason", "server_now_ms",
"transmitter", "rounds", "steps": [Step], "index", "started_ms", "ends_ms", "frames"}`,
`Step` = `{"id", "kind": "lead" | "empty" | "walk" | "hold" | "end", "name", "d_m", "t0_ms",
"t1_ms", "say"}`. The server times the run on its clock (the engine's `host_us` clock), so a
sleeping phone cannot shift the labels; the page counts down from `server_now_ms`. A complete
run writes `spots.json` in `ml/record_spots.py`'s shape (`{session, spots: [{name, d_m, t0_us,
t1_us}]}`, plus `frames`, `t_start_us`, `t_end_us`, `protocol: "teach-v1"`, `transmitter`); an
aborted one writes `teach.json` with the reason and never `spots.json`. A run aborts on: stop,
engine gone > 5 s, source not live, the recording stopped elsewhere, no result for 10 s or
under 10 readings/s for 10 s. A server restart mid-run loses the run (the session then lists as
stopped early). While any recording runs, `PUT /source` answers `409`.

Training runs `ml/train_spots.py --out <data>/spots_model.candidate.json --json <dirs>` (killed
after 180 s). The candidate is installed (current → `.prev.json`, each file written to `.tmp`
then renamed) only when its `loso_bal_acc − 1/k` is at least the current model's (or the current
one has no `loso_bal_acc`); a candidate without `loso_bal_acc` never is. The engine reads
`spots_model.json` next to its `--calibration` path: a non-default `LIFEFI_DATA_DIR` needs a
matching `--calibration`.

### `Source`

```json
{"mode": "live" | "replay", "file": "data/s03.csirec" | null, "speed": 1, "loop": false, "state": "running" | "stopped" | "error", "error": null}
```

The server keeps `Source` in step with the engine's `get_status`
`source_info` (control.md): `stopped` when a replay finished or there is no
source, `error` with the reason when the board cannot be read (for example
"no USB serial port found"). `PUT /source` takes `Source` without `state`
and `error`.

### `Alert`

```json
{
  "id": "a-0001",
  "event_id": 42,
  "type": "fall",
  "level": "high" | "medium" | "low",
  "state": "pending" | "open" | "acked" | "resolved" | "dropped",
  "profile": "home",
  "config_hash": "9f3a1c",
  "created_at": 1767225600100,
  "opened_at": 1767225600100,
  "acked_at": null,
  "resolved_at": null,
  "notified_at": null,
  "escalated_at": null,
  "acked_by": null,
  "notify": "sent" | "not_configured" | "failed" | null,
  "notify_error": null,
  "data": {"peak": 0.93, "closed_by": "cleared by the engine"}
}
```

`notify` is the outcome of the last phone notification attempt (`notified_at`
is when it was attempted). `data.closed_by` is written on every resolve or
drop: `cleared by the engine`, `no longer reported by the engine`,
`engine restarted`, `source changed` (the engine switched between live and
replay: the condition is not over, so the dashboard shows no "all clear"),
`server restart`, or for server rules `movement seen`,
`room is empty`, `outside the after-hours window`, `sensor stopped reporting`.

Server-emitted events: `sensor_offline` (watchdog: engine disconnected for
10 s, no result for 10 s, CSI rate below 50 Hz for 60 s, or no device status
for 10 s), `long_inactivity` (Home:
no motion for `inactivity.still_present_max_min`, or none by `no_motion_by`)
and `after_hours_occupancy` (School: present inside `occupancy.after_hours`).

State machine (plan-v2 §7.2):

```
event active ─▶ pending (delay_s from the profile)
pending ─cleared before the timer─▶ dropped
pending ─timer expires (or delay_s = 0)─▶ open ─▶ live stream + ntfy
open ─ack─▶ acked ;  open/acked ─cleared─▶ resolved
open, not acked for escalate_after_s ─▶ re-notify
```

### `HistoryRow`

One row per 5 s. Never contains `csi` or `wave`.

```json
{"t": 1767225600000, "presence": "present", "motion": 0.03, "breathing_bpm": 14.2, "breathing_valid": true, "posture": "lying", "count": 1}
```

`breathing_*` are `null` when the active profile has `breathing.store: false`.

`HistoryRow` also carries `heart_bpm` (number, null unless the heart estimate was `valid`) and
`heart_valid` (bool; null when the engine sent no `heart` or the profile does not store vitals).
`GET /history?fields=` accepts `heart` (→ `heart_bpm`, `heart_valid`); `heart_*` follow
`breathing.store` like `breathing_*`. The history DB carries `PRAGMA user_version = 1` (columns
added in place on first start; older builds keep working).

### Vitals history (`GET /history/vitals?hours=1|6|24&to=<ms>`)

Breathing, heart and movement over the last hours (Insights → "Last hours"). `hours` default 24,
anything else → 400 `bad_request` "hours must be 1, 6 or 24"; `to` default now, must be finite
and ≤ now + 60 s, else 400. Range `[to − hours h, to)`; buckets epoch-aligned: 1 h → 60 s,
6 h → 5 min, 24 h → 10 min. Reply `{from, to, bucket_s, stored, summary, buckets}`; `summary` =
`{n, present_n, still_n, breath_n, breath_med, breath_q1, breath_q3, heart_on_n, heart_n,
heart_med, heart_q1, heart_q3}` over the whole range; each bucket (non-empty ones only) =
`{t, n, present_n, still_n, motion_med, breath_n, breath_med, heart_on_n, heart_n, heart_med}`.
A row is a reading when presence is `present`, the valid flag is 1, the rate is in range
(breath 4–60, heart 35–200) and `count ≠ 2`; medians/quartiles are null with fewer than 3
readings (the chart shows a gap); `still` = present and motion < 0.1; `motion_med` over present
rows; `heart_on_n` = present rows with a heart flag; rates rounded to 0.1, motion to 0.01.
`stored` = the active profile's `breathing.store`. Heart rate is experimental (one Wi-Fi link),
not a medical measurement.

### `Recent` (`GET /recent?minutes=N`)

In-memory samples of the last N minutes (1..15, default 15) of results since the current
boot and source, one per result (2 Hz): `{boot_id, source, now, samples: TrendSample[]}`
with the `TrendSample` fields from `ui/src/lib/model.ts` (t, presence, occP, breath,
breathConf, heart, heartOn, motion, d, sd, lowQuality, spotD, spotOn, rateHz, lossUdp,
lossAir, rssi, warmup). `breath`/`heart` are null unless the engine marked them valid, they
are within 4..60 / 35..200 per minute and fewer than 2 people are counted. `boot_id` and
`source` are null before the first result. Kept in server memory only, lost on restart,
never written to disk; cleared when boot_id or source changes. No PIN (read-only).
400 `{error: "bad_request", message}` for any other `minutes` (0, 16, 2.5, abc, empty).

### `Settings`

```json
{
  "pin_set": true,
  "notify": {"ntfy_url": "https://ntfy.sh", "topic": "…", "escalate_after_s": 120},
  "zone": "Europe/Sofia",
  "dashboard_url": "http://192.168.1.10:8080",
  "retention_days": 30,
  "room_name": "Room 1",
  "contact_phone": "+359 88 123 4567",
  "room": {"width_m": 4.0, "depth_m": 3.5, "sensor": {"x_m": 0.2, "y_m": 0.0}, "transmitter": {"x_m": 3.8, "y_m": 3.5} | null} | null
}
```

`room` is the room drawn to scale, `null` until set. Metres; the origin is a
corner, `x` along the width, `y` along the depth. `width_m`/`depth_m` 1–30, the
sensor and transmitter inside the room; `PUT {"room": null}` clears it. It is
for drawing only: the engine does not use it, and one link gives a distance
from the sensor, never a direction.

The PIN itself is never returned. Changing it: `PUT /settings` with
`{"pin": "new"}` and the current PIN in the header.

## Live stream `/api/v1/live` (Server-Sent Events)

Server → client only (`text/event-stream`). Each event's `data:` is one JSON
object; a `: ping` comment every 15 s keeps the stream open. On connect the
server first sends one `status` and, if it has one, one `result`.

| `type` | Payload | When |
|---|---|---|
| `result` | the `Result` object itself (fields of `results.schema.json`, `type` is already `"result"`) | every result from the engine, 2 Hz |
| `alert` | `{"type": "alert", "alert": Alert}` | every alert state transition |
| `status` | `{"type": "status", "status": Status without result}` | engine connect/disconnect, source change, profile change, calibration change, device status every 1 s |

The client (`EventSource`) reconnects with exponential backoff capped at 5 s,
and shows "connection lost" while disconnected. Slow clients are dropped by
the server when their queue exceeds 64 KB.
