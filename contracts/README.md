# Contracts

The interfaces between the components (plan-v2 §4). Change a contract here
first, then the code on both sides.

| File | Between | What |
|---|---|---|
| `results.schema.json` | engine → server → dashboard | One result every 0.5 s. UI types are generated from it |
| `control.md` | server ↔ engine | TCP 127.0.0.1:6000, JSON lines: commands, acks, `get_status` |
| `api.md` | server → dashboard | REST `/api/v1/*` and WebSocket `/ws/live` |
| `profiles.yml` | server | Which events become alerts, delays, what each page shows |
| `fixtures/*.json` | tests | Hand-written results, one per state. Must validate against the schema (`npm run check:contracts`) |

Not yet here (owned by the firmware / engine side): `csi_frame.h`, the
status packet, `.csirec`, `session.json`, `labels.jsonl`, `model_io.md`.
