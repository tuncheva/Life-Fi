# HTTP + WebSocket API (server → dashboard)

Source: plan-v2 §4.7, §7, §8. This file is the contract. Change it here first.

Base path `/api/v1`. JSON bodies. Times are ms since epoch (UTC) unless the
field name ends in `_us`.

## Authentication

Reads are open on the LAN. **Writes need the PIN**, sent as
`X-Lifefi-Pin: <pin>`. A wrong or missing PIN answers `401` with
`{"error": "pin"}`.

Writes: every `POST` and `PUT` below.

## Errors

`{"error": "<code>", "message": "<human text>"}`. Codes: `pin`, `engine_offline`,
`bad_request`, `not_found`, `conflict`.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/status` | — | `Status` (below) |
| GET | `/history?from=&to=&fields=` | — | `{"rows": [HistoryRow]}`; `fields` is a comma list of `presence,motion,breathing,posture,count` |
| GET | `/alerts?state=` | — | `{"alerts": [Alert]}`; `state` is a comma list of `pending,open,acked,resolved,dropped`; default `open,acked` |
| POST | `/alerts/{id}/ack` | `{"by": "Maria's phone"}` (optional, ≤ 40 chars) | `Alert` with `acked_by` |
| GET | `/profile` | — | `{"active": "home", "profiles": {…}}` (the `profiles` block of `profiles.yml`) |
| PUT | `/profile` | `{"active": "clinic"}` | same as GET |
| POST | `/calibrate` | `{"kind": "empty", "duration_s": 120}` | `{"started": true}`; `409` while one is running. Progress and outcome arrive as `status` WS messages: `calibration_job` (below) plus the engine's `calibration.state` in every result |
| GET | `/recordings` | — | `{"recordings": [{"session","file","bytes","labels"}], "recording": Recording \| null, "vocabulary": {"segments": [...], "marks": [...]}}` |
| GET | `/recordings/labels?session=` | — | `{"session", "labels": [lines of labels.jsonl], "open_segment"}`; `session` defaults to the one recording |
| GET | `/source` | — | `Source` |
| PUT | `/source` | `Source` without `state` | `Source` |
| POST | `/recordings/start` | `{"session": "s03", "meta": {…}}` (meta goes into `session.json`) | `{"session": "s03", "started_us"}`; `409` if recording or not live |
| POST | `/recordings/stop` | `{}` | `{"session": "s03", "frames": 12345, "labels": 17}`; ends an open segment first |
| POST | `/recordings/segment` | `{"action":"start","label","count","subject","spot"}` or `{"action":"end"}` | `{"ended": segment \| null, "open_segment"}`; starting a segment ends the open one (segments never overlap) |
| POST | `/recordings/mark` | `{"event","subject"}` | the written mark line |

`Recording` (also in `Status.recording` while a session runs, else `null`; the
server clears it if the engine reports no recording, e.g. after an engine
restart):
`{"session": "s03", "started_us": …, "open_segment": {"t_start_us","label","count","subject","spot"} | null, "labels": 17}`.

Segment labels: `empty`, `standing`, `sitting`, `lying`, `walking`, `normal_activity`, `in_bed`, `bed_empty`, `breath_hold`, `paced_breathing_<bpm>`.
Mark events: `sit_down`, `stand_up`, `lie_down`, `get_up`, `fall`, `bed_exit`, `breath_hold_start`, `breath_hold_end`, `hard_negative_<what>`.
| GET | `/settings` | — | `Settings` |
| PUT | `/settings` | partial `Settings` (+ `pin` to change it, 4–8 digits) | `Settings` |
| POST | `/settings/test-notification` | `{}` | `{"sent": true}`, or `502` `{"error":"notify"}` when ntfy refused or no topic is set |
| WS | `/ws/live` | — | messages below |

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
`engine restarted`, `server restart`, or for server rules `movement seen`,
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
pending ─timer expires (or delay_s = 0)─▶ open ─▶ WebSocket + ntfy
open ─ack─▶ acked ;  open/acked ─cleared─▶ resolved
open, not acked for escalate_after_s ─▶ re-notify
```

### `HistoryRow`

One row per 5 s. Never contains `csi` or `wave`.

```json
{"t": 1767225600000, "presence": "present", "motion": 0.03, "breathing_bpm": 14.2, "breathing_valid": true, "posture": "lying", "count": 1}
```

`breathing_*` are `null` when the active profile has `breathing.store: false`.

### `Settings`

```json
{
  "pin_set": true,
  "notify": {"ntfy_url": "https://ntfy.sh", "topic": "…", "escalate_after_s": 120},
  "zone": "Europe/Sofia",
  "dashboard_url": "http://192.168.1.10:8080",
  "retention_days": 30,
  "room_name": "Room 1",
  "contact_phone": "+359 88 123 4567"
}
```

The PIN itself is never returned. Changing it: `PUT /settings` with
`{"pin": "new"}` and the current PIN in the header.

## WebSocket `/ws/live`

Server → client only. Text frames, one JSON object each. On connect the
server first sends one `status` and, if it has one, one `result`.

| `type` | Payload | When |
|---|---|---|
| `result` | the `Result` object itself (fields of `results.schema.json`, `type` is already `"result"`) | every result from the engine, 2 Hz |
| `alert` | `{"type": "alert", "alert": Alert}` | every alert state transition |
| `status` | `{"type": "status", "status": Status without result}` | engine connect/disconnect, source change, profile change, calibration change, device status every 1 s |

The client reconnects with exponential backoff capped at 5 s, and shows
"connection lost" while disconnected. Slow clients are dropped by the server
when their send queue exceeds 64 KB or 1000 messages.
