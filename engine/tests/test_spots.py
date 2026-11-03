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

print(f"\ntest_spots {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
