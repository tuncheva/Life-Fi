"""False `no_breathing` alerts on E1's paced-breathing files.

    .venv/Scripts/python ml/check_apnea.py

E1 has 66 files of people breathing to a metronome (10 / 15 / 20 /min,
3 min each, ESP32 LLTF at ~50 Hz) and no breath-holds, so every alert
here is a false one. The rule runs exactly as in the engine
(lifefi.apnea.run_offline: breathing every 5 s, the rule every 0.5 s,
person present and still throughout). It can only fire while armed: a
valid breathing window, at most 60 s old, lies inside the current
stillness (lifefi.apnea.NoBreathing.armed). `armed_hours` is that time,
not the length of the files it happened in.

No public breath-hold data exists (datasets/README.md), so detection
latency comes from the synthetic tests only (engine/tests/test_apnea.py).
Writes ml/results/apnea_e1.json.
"""

import json
import pathlib
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))
sys.path.insert(0, str(HERE.parent / "datasets" / "readers"))

import e1  # noqa: E402
from lifefi import apnea  # noqa: E402


def one(path):
    rec = e1.read(path, root=e1.BREATHING)
    if not isinstance(rec, e1.Recording):
        return None
    ts_us = (rec.t_s * 1e6).astype(np.int64)
    changes, nb, armed_s = apnea.run_offline(ts_us, rec.amp)
    return {"file": rec.rec_id, "target": rec.meta["clip_label"], "seconds": round(float(np.ptp(rec.t_s)), 1),
            "armed_s": round(armed_s, 1), "alerts": [t for t, c in changes if c == "active"]}


def main():
    with ProcessPoolExecutor(8) as pool:
        rows = [r for r in pool.map(one, e1.breathing_files()) if r is not None]
    hours = sum(r["seconds"] for r in rows) / 3600
    armed = [r for r in rows if r["armed_s"] > 0]
    armed_h = sum(r["armed_s"] for r in rows) / 3600
    n = sum(len(r["alerts"]) for r in rows)
    out = {"files": len(rows), "hours": round(hours, 2), "armed_files": len(armed), "armed_hours": round(armed_h, 2),
           "false_alerts": n, "false_alerts_per_armed_hour": round(n / armed_h, 2) if armed_h else None,
           "files_with_alert": [r["file"] for r in rows if r["alerts"]],
           "per_target": {t: {"files": sum(r["target"] == t for r in rows),
                              "armed": sum(r["target"] == t and r["armed_s"] > 0 for r in rows),
                              "alerts": sum(len(r["alerts"]) for r in rows if r["target"] == t)}
                          for t in sorted({r["target"] for r in rows})}}
    print(json.dumps(out, indent=2))
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "apnea_e1.json").write_text(json.dumps({**out, "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
