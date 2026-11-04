"""lifefi.spots: a spot model trained with ml/train_spots.py names the spot it was taught.

    python engine/tests/test_spots.py

Two "spots" are two synthetic static channels (different seeds); the model
is fitted on the first part of each, saved, loaded the way the engine
loads it, and must name later windows of each correctly.
"""

import json
import pathlib
import sys
import tempfile

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "ml"))
from lifefi import spots  # noqa: E402
from lifefi.synth import synth  # noqa: E402
import train_spots  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


SPOTS = {"desk": (3, -48.0, 0.4), "door": (4, -62.0, 3.0)}     # seed, RSSI, distance
data = {}
for name, (seed, rssi, _) in SPOTS.items():
    ts, csi = synth(40, bpm=15, seed=seed, agc=False)
    data[name] = (ts / 1e6, np.abs(csi), np.full(len(ts), rssi))

X, y = [], []
for i, (name, (t, amp, rssi)) in enumerate(data.items()):
    for _, f in train_spots.windows(t, amp, rssi, t[0], t[0] + 25.0):
        X.append(f)
        y.append(i)
mu, sd, W, b = train_spots.fit(np.array(X), np.array(y), len(SPOTS), 0.1)

with tempfile.TemporaryDirectory() as tmp:
    path = pathlib.Path(tmp) / "spots_model.json"
    path.write_text(json.dumps({"labels": list(SPOTS), "distances": {n: v[2] for n, v in SPOTS.items()},
                                "mu": mu.tolist(), "sd": sd.tolist(), "W": W.tolist(), "b": b.tolist()}))
    model = spots.SpotModel.load(path)
check(model is not None and model.labels == ["desk", "door"], "the saved model loads")
check(spots.SpotModel.load(ROOT / "no_such_model.json") is None, "no model file: no spot model")

for name, (t, amp, rssi) in data.items():
    model.hist.clear()
    out = None
    for now in np.arange(t[0] + 28.0, t[-1], 0.5):          # windows the model never saw
        k = int(np.searchsorted(t, now, side="right"))
        out = model.update(now, t[:k], amp[:k], float(rssi[0]))
    check(out is not None and out["name"] == name and out["d_m"] == SPOTS[name][2],
          f"{name}: named {out and out['name']} (p {out and out['p']}) at {out and out['d_m']} m")
check(model.update(0.0, np.zeros(0), np.zeros((0, 52)), -50.0) is None, "no packets: no answer")

# self-assessment: only a cross-session score makes a model reliable, never holdout_accuracy
check(out["model_accuracy"] is None and out["reliable"] is False, "no loso_bal_acc: model_accuracy None, not reliable")
base = {"labels": list(SPOTS), "distances": {n: v[2] for n, v in SPOTS.items()},
        "mu": mu.tolist(), "sd": sd.tolist(), "W": W.tolist(), "b": b.tolist()}
check(not spots.SpotModel({**base, "holdout_accuracy": 0.93}).reliable(), "holdout_accuracy 0.93 alone: not reliable")
check(not spots.SpotModel({**base, "loso_bal_acc": 0.6}, margin=0.15).reliable(), "LOSO 0.60 with 2 spots (chance 0.5 + 0.15): not reliable")
check(spots.SpotModel({**base, "loso_bal_acc": 0.7}, margin=0.15).reliable(), "LOSO 0.70 with 2 spots: reliable")
current = spots.SpotModel.load(ROOT / "data" / "spots_model.json")
if current is not None:
    check(not current.reliable(), f"the saved data/spots_model.json is not reliable (model_accuracy {current.model_accuracy})")

# train_spots: loso_bal_acc only from >= 2 sessions, with the harness's 2 s trim
Xa, ya = np.array(X), np.array(y)
check(train_spots.loso_bal_acc(Xa, ya, np.zeros(len(ya), int), np.ones(len(ya), bool), 2, 0.1) is None,
      "one session: no loso_bal_acc")
two = train_spots.loso_bal_acc(Xa, ya, np.arange(len(ya)) % 2, np.ones(len(ya), bool), 2, 0.1)
check(two is not None and len(two[1]) == 2 and 0.0 <= two[0] <= 1.0, f"two sessions: loso_bal_acc {two and round(two[0], 3)}")

# the engine reloads the spot model on reload_models (what /teach does after installing one)
from lifefi.engine import Engine  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    path = pathlib.Path(tmp) / "spots_model.json"
    path.write_text(json.dumps(base), encoding="utf-8")
    eng = Engine(calibration_path=pathlib.Path(tmp) / "calibration.json")
    check(eng.spot_model is not None and eng.spot_model.labels == list(SPOTS), "engine loads model A at start")
    path.write_text(json.dumps({**base, "labels": ["sofa", "bed"], "distances": {"sofa": 1.0, "bed": 2.0},
                                "loso_bal_acc": 0.8}), encoding="utf-8")
    acks = []
    eng.handle({"type": "reload_models", "id": 1}, acks.append, 0.0)
    margin = float(eng.rules["spots"]["reliable_margin"])
    check(eng.spot_model.labels == ["sofa", "bed"] and eng.spot_model.margin == margin,
          f"reload_models picks up model B with the rules margin ({margin})")
    check(acks and acks[0]["ok"] and acks[0]["data"]["spots"] == {"labels": ["sofa", "bed"], "loso_bal_acc": 0.8},
          f"the reload ack names the spot model: {acks and acks[0]['data'].get('spots')}")
    path.write_text("{not json", encoding="utf-8")
    eng.handle({"type": "reload_models", "id": 2}, acks.append, 0.0)
    check(eng.spot_model is not None and eng.spot_model.labels == ["sofa", "bed"], "bad JSON: the old model is kept")
    path.unlink()
    eng.handle({"type": "reload_models", "id": 3}, acks.append, 0.0)
    check(eng.spot_model is None and acks[-1]["data"]["spots"] is None, "file gone: no spot model, ack spots null")

print(f"\ntest_spots {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
