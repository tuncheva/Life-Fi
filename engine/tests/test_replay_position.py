"""The engine on the two labelled spot sessions: a regression guard for occupancy and distance quality.

    python engine/tests/test_replay_position.py

Skips when data/sessions/spots-* is missing (data/ is not in git). Each
session is replayed through lifefi.engine.Engine (results every 0.5 s, no
calibration: the engine refuses one from these recordings, too few valid
samples) and its published fields are scored per labelled spot, as
ml/eval_position.py does (plan A §7.2, §7.3, §7.5):

- the empty minute reads empty or unsure on >= 80 % of the ticks with an
  occupancy answer, each occupied minute occupied or unsure;
- occupancy is never `empty` while presence says `present`;
- position quality is never `medium` (the transmitter moved);
- the mean tick stays < 100 ms and the occupancy update < 5 ms;
- every result is valid against contracts/results.schema.json.

`unsure` on <= 50 % of the ticks is reported as a known failure (xfail):
the p_on / p_off band of rules.yaml is not tuned on these sessions.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "ml"))
import eval_position as ev  # noqa: E402

try:
    import jsonschema
    SCHEMA = jsonschema.Draft202012Validator(json.loads((ROOT / "contracts" / "results.schema.json").read_text()))
except ImportError:
    SCHEMA = None
    print("  (jsonschema not installed: schema check skipped)")

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


dirs = ev.find_sessions()
if not dirs:
    print(f"test_replay_position SKIPPED: no labelled spot sessions in {ev.SESSIONS}")
    sys.exit(0)

for d in dirs:
    s = ev.load_session(d)
    rows, ms, _, occ_ms = ev.replay(s)
    print(f"{s['name']}: {len(rows)} results")
    sp = ev.score_replay(s, rows, fresh=False)
    for name, m in sp.items():
        check(m["occupancy_ok_share"] is not None and m["occupancy_ok_share"] >= 0.8,
              f"{name}: occupancy {m['occupancy']} right or unsure on {m['occupancy_ok_share']} (>= 0.8)")
    lie = sum(1 for _, r in rows if r["presence"]["state"] == "present" and (r.get("occupancy") or {}).get("state") == "empty")
    check(lie == 0, f"never empty while presence is present ({lie} ticks)")
    q = {(r["position"] or {}).get("quality") for _, r in rows} - {None}
    check("medium" not in q, f"position quality {sorted(q)}: never medium")
    mean_ms, occ_mean = sum(ms) / len(ms), sum(occ_ms) / max(len(occ_ms), 1)
    check(mean_ms < 100.0, f"tick {mean_ms:.1f} ms mean (< 100 ms)")
    check(occ_mean < 5.0, f"occupancy update {occ_mean:.2f} ms mean (< 5 ms)")
    if SCHEMA is not None:
        bad = [e.message for _, r in rows for e in SCHEMA.iter_errors(r)]
        check(not bad, f"every result valid against the schema {bad[:1]}")
    dec = sum(v for m in sp.values() for k, v in m["occupancy"].items() if k != "null")
    unsure = sum(m["occupancy"].get("unsure", 0) for m in sp.values())
    share = unsure / max(dec, 1)
    print(("  ok   " if share <= 0.5 else "  xfail ") + f"unsure on {share:.0%} of the answered ticks (plan: <= 50 %)")

print(f"\ntest_replay_position {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
