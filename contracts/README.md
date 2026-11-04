# Contracts

The interfaces between the components (plan-v2 §4). Change a contract here
first, then the code on both sides.

| File | Between | What |
|---|---|---|
| `results.schema.json` | engine → server → dashboard | One result every 0.5 s. UI types are generated from it |
| `control.md` | server ↔ engine | TCP 127.0.0.1:6000, JSON lines: commands, acks, `get_status` |
| `api.md` | backend → dashboard | REST `/api/v1/*` and Server-Sent Events `/api/v1/live` |
| `profiles.yml` | server | Which events become alerts, delays, what each page shows |
| `fixtures/*.json` | tests | Hand-written results, one per state. Must validate against the schema (`npm run check:contracts`) |

Not yet here (owned by the firmware / engine side): `csi_frame.h`, the
status packet, `.csirec`, `session.json`, `labels.jsonl`, `model_io.md`.

## Vital signs in a result

`breathing.reason` and `heart.reason` say why there is no rate right now,
for the UI wording; they are `null` exactly while a rate is shown
(`bpm` non-null ⇔ `valid` ⇔ `reason` null). First match wins:

| Reason | When |
|---|---|
| `warming_up` | under 30 s of signal since the start, a gap or a source change; no breathing window in the last 10 s |
| `no_person` | presence is not `present` (`empty` or `uncertain`) |
| `motion` | the person moved recently: breathing needs `rules.yaml breathing.low_motion_s` (20 s) without motion, heart `heart.min_still_s` (30 s, the whole window) |
| `noise` | still, but the window has no clear peak above the noise floor (or, for heart, the peak sits on a breathing harmonic) |
| `unstable` | still, but the estimators disagree, too few windows are valid, or they disagree with each other |

`heart` is **EXPERIMENTAL and not a medical measurement**: one ESP32 link
is near its limit for the 0.1-0.5 mm chest motion of a pulse, and nothing
was checked against a pulse sensor. The engine sends it as an object in
every result while `rules.yaml heart.publish` is true (from the first
tick: `bpm` null, reason `warming_up`), and `null` when it is false. A
rate is the median of the valid 30 s windows of the last 60 s, and only
while breathing is valid (`heart.require_breathing`: the breathing rate is
needed to remove its harmonics). Older engines leave both fields out; the
dashboard must handle `heart` missing or `null`.
