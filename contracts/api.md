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
| POST | `/alerts/{id}/ack` | `{}` | `Alert` |
| GET | `/profile` | — | `{"active": "home", "profiles": {…}}` (the `profiles` block of `profiles.yml`) |
| PUT | `/profile` | `{"active": "clinic"}` | same as GET |
| POST | `/calibrate` | `{"kind": "empty", "duration_s": 120}` | `{"started": true}`; completion arrives as a `status` WS message with `calibration.state` |
| GET | `/source` | — | `Source` |
| PUT | `/source` | `Source` without `state` | `Source` |
| POST | `/recordings/start` | `{"session": "s03", "meta": {…}}` | `{"session": "s03"}` |
| POST | `/recordings/stop` | `{}` | `{"session": "s03", "frames": 12345}` |
| POST | `/recordings/segment` | `{"label","count","subject","spot","action":"start"\|"end"}` | `{}` |
| POST | `/recordings/mark` | `{"event","subject"}` | `{}` |
| GET | `/settings` | — | `Settings` |
| PUT | `/settings` | partial `Settings` | `Settings` |
| WS | `/ws/live` | — | messages below |

### `Status`

```json
{
  "server": {"version": "0.1.0", "uptime_s": 120, "profile": "home", "time_zone": "Europe/Sofia"},
  "engine": {"connected": true, "last_result_ms": 1767225600123, "status": { …get_status ack data.engine… }},
  "device": { …get_status ack data.device… } ,
  "source": {"mode": "live", "file": null, "speed": 1, "loop": false, "state": "running"},
  "result": { …latest Result or null… },
  "alerts_open": 0
}
```

### `Source`

```json
{"mode": "live" | "replay", "file": "data/s03.csirec" | null, "speed": 1, "loop": false, "state": "running" | "stopped"}
```

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
  "data": {"peak": 0.93}
}
```

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
  "retention_days": 30
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
