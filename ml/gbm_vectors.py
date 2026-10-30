"""Test vectors for any port of the GBM's features (model-audit B.7).

    .venv/Scripts/python ml/gbm_vectors.py          # -> ml/models/gbm_vectors.json

gbm.onnx takes 53 features, not F: an engine that computes them itself
must reproduce ml/features.py. This writes N windows from the processed
public data (one per class where possible) with, for each, the raw window
F [52][150] (dB), the 53 features and the class probabilities of
gbm.txt. A port is right when it gives the same features (|diff| <= 1e-3
relative) and probabilities (<= 1e-4) on every vector.
"""

import json
import pathlib
import sys

import lightgbm as lgb
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import data  # noqa: E402
from features import window_features  # noqa: E402

N_PER_CLASS = 2


def main():
    model = lgb.Booster(model_file=str(HERE / "models" / "gbm.txt"))
    meta = json.loads((HERE / "models" / "gbm.json").read_text())
    d = data.build_windows()
    rng = np.random.default_rng(0)
    pick = []
    for c in range(len(data.CLASSES)):
        idx = np.where(d["y"] == c)[0]
        pick += list(rng.choice(idx, min(N_PER_CLASS, len(idx)), replace=False))
    F = data.centre(d["X"][pick].astype(np.float32))
    feats, names = window_features(data.model_view(F), F)
    assert names == meta["features"], "features.py no longer matches gbm.json: retrain with --final"
    P = model.predict(feats)
    vectors = [{"label": data.CLASSES[d["y"][i]], "F": np.round(f, 4).tolist(), "features": x.tolist(),
                "p": p.tolist()} for i, f, x, p in zip(pick, F, feats, P)]
    out = HERE / "models" / "gbm_vectors.json"
    out.write_text(json.dumps({"classes": meta["classes"], "features": names, "fs": data.FS, "win": data.WIN,
                               "pipeline_version": meta["pipeline_version"], "vectors": vectors}))
    print(f"wrote {len(vectors)} vectors to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
