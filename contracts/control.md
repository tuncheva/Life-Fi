# Control protocol (server ↔ engine)

Source: plan-v2 §4.4 and §4.5. This file is the contract. Change it here first.

## Transport

- TCP, `127.0.0.1:6000`. **The engine listens.** The server connects and
  reconnects every 1 s.
- JSON lines: one JSON object per line, UTF-8, `\n` terminated. No framing
  beyond that. Lines may arrive in any interleaving of results and acks.
- The engine sends a `result` line every 0.5 s whether or not a command is
  pending. See `results.schema.json`.
- Only one server connection is expected. If a second client connects the
  engine may close the older one.

## Commands (server → engine)

Every command is `{"type": "<command>", "id": <int>, ...args}`. The engine
answers every command with exactly one ack:

```json
{"type": "ack", "id": 7, "ok": true, "error": null, "data": {}}
{"type": "ack", "id": 8, "ok": false, "error": "motion seen during calibration", "data": {}}
```

`id` is chosen by the server, unique per connection. The server times a
command out after 3 s.

| Command | Arguments | Effect | `data` in the ack |
|---|---|---|---|
| `calibrate` | `kind`: `empty` / `bed_empty` / `bed_occupied`, `duration_s` (default 120, at least 60) | Builds that profile. `empty` is refused if motion is seen during it, or right away when `duration_s` < 60 | `{"id": "cal-0007"}` on completion |
| `set_source` | `mode`: `live` / `replay`; for `replay`: `file` (a `.csirec` path), optional `speed` (default 1), `loop` (default false) | The engine accepts only frames with that `source`; on `replay` it plays `file` itself, re-stamped with the current time. Refused (`ok: false`) when the file is missing | `{}` |
| `record_start` | `session`, `path`, `meta` (object, becomes `session.json`) | Writes `.csirec` + `session.json` (live only) | `{}` |
| `record_stop` | — | Stops the recording | `{"frames": 12345, "t_start_us": …, "t_end_us": …}` |
| `reload_models` | — | Reloads the model files | `{}` |
| `reload_rules` | — | Reloads `rules.yaml`; the new `config_hash` appears in results | `{"config_hash": "…"}` |
| `get_status` | — | Engine and device status | see below |

`calibrate` acks when the calibration **finishes** (up to `duration_s`
later), so the server must not apply the 3 s timeout to it; it uses
`duration_s + 5 s` instead.

### `get_status` ack data

```json
{
  "engine": {
    "version": "0.1.0", "pipeline_version": 2, "config_hash": "9f3a1c",
    "source": "live", "uptime_s": 3600,
    "inference_ms": {"p50": 4.1, "p95": 9.8},
    "models": [{"name": "transitions", "loaded": true, "pipeline_version": 2}],
    "calibration": {"state": "ok", "id": "cal-0007", "age_s": 312},
    "recording": null,
    "active_events": [{"id": 42, "type": "fall", "t": 1767225600100, "data": {"peak": 0.93}}]
  },
  "device": {
    "node": 1, "boot_id": 2913411, "fw_version": "0.1.0",
    "rssi_dbm": -52, "channel": 6, "uptime_s": 7200,
    "rate_hz": 88.1, "loss_udp": 0.004, "loss_air": 0.03,
    "rejected": {"layout": 0, "gain_invalid": 0},
    "queue_drops": 0, "send_errors": 0, "wifi_disconnects": 1,
    "ping_rate_hz": 100, "ping_timeouts_last_s": 0,
    "last_status_us": 1767225600000000
  }
}
```

`engine.active_events` lists every currently active event with its type:
results carry only ids in `active`, so this is how a server that restarted
or reconnected recovers an ongoing condition (N8). The server polls
`get_status` every second.

`device` is `null` while no status packet has ever been received.
`device.last_status_us` is what the server's watchdog uses for "no status
packet for 10 s".

## Events

The engine emits: `fall`, `fainted_suspected`, `no_breathing`,
`presence_uncertain`, `recalibrate_needed`, `bed_exit`.

The server emits (never the engine): `sensor_offline`, `long_inactivity`.

Each event has an `id` unique per engine boot, appears in `events` with
`state: "active"` when it starts and `state: "cleared"` when it ends, and is
listed in `active` on every result while it is active.
