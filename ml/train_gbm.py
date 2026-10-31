"""Gradient-boosting baseline for the transition model (plan-v2 §6.8 step 1).

    .venv/Scripts/python ml/train_gbm.py            # folds -> ml/results/gbm.json
    .venv/Scripts/python ml/train_gbm.py --final    # all non-locked data -> ml/models/gbm.{txt,onnx,json}

Runs every fold of datasets/manifest/splits.yml (leave-one-E8-room-out,
leave-E1-subjects-out; locked subjects never touched). --final scores the
locked subjects once.
"""

import hashlib
import json
import pathlib
import sys
import time

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import data  # noqa: E402
import evaluate  # noqa: E402
from lifefi.features import window_features  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
RESULTS = HERE / "results"
CACHE = data.ROOT / "datasets" / "processed" / "gbm_features.npz"
FEATURES_PY = data.ROOT / "engine" / "lifefi" / "features.py"
PARAMS = {"objective": "multiclass", "num_class": len(data.CLASSES), "learning_rate": 0.05,
          "num_leaves": 31, "min_data_in_leaf": 40, "feature_fraction": 0.8, "bagging_fraction": 0.8,
          "bagging_freq": 1, "lambda_l2": 1.0, "verbose": -1}
ROUNDS = 400


def _cache_key(d):
    """Changes when the windows, the feature code or the signal pipeline change."""
    h = hashlib.sha256()
    for f in (FEATURES_PY, HERE / "data.py", data.ROOT / "engine" / "lifefi" / "dsp.py"):
        h.update(f.read_bytes())
    h.update(np.ascontiguousarray(d["X"][::997]).tobytes())
    h.update(str((len(d["y"]), data.common.dsp.PIPELINE_VERSION)).encode())
    return h.hexdigest()


def features(d):
    key = _cache_key(d)
    if CACHE.exists():
        z = np.load(CACHE, allow_pickle=False)
        if "key" in z and str(z["key"]) == key:
            return z["X"], list(z["names"])
    Xs = []
    for i in range(0, len(d["X"]), 2048):
        raw = data.centre(d["X"][i:i + 2048].astype(np.float32))
        f, names = window_features(data.model_view(raw), raw)
        Xs.append(f)
    X = np.concatenate(Xs)
    np.savez(CACHE, X=X, names=np.array(names), key=key)
    return X, names


def class_weights(y):
    counts = np.bincount(y, minlength=len(data.CLASSES)).astype(float)
    w = np.where(counts > 0, counts.sum() / np.maximum(counts, 1) / (counts > 0).sum(), 0.0)
    return w[y]


def final(d, X, names, splits):
    """Train on all non-locked windows, score the locked subjects once, save .txt + .onnx."""
    import onnx
    import onnxmltools
    import onnxruntime as ort
    from onnxmltools.convert.common.data_types import FloatTensorType

    locked = np.isin(d["subject"], splits["locked_subjects"])
    tr = ~locked & (d["y"] != data.IGNORE)
    model = lgb.train(PARAMS, lgb.Dataset(X[tr], d["y"][tr], weight=class_weights(d["y"][tr])), ROUNDS)
    r = evaluate.score(model.predict(X[locked]), d["y"][locked], d["clip"][locked], d["clips"])
    print("LOCKED E1 subjects (scored once):", r)
    out = HERE / "models"
    out.mkdir(exist_ok=True)
    model.save_model(str(out / "gbm.txt"))
    onx = onnxmltools.convert_lightgbm(model, initial_types=[("features", FloatTensorType([None, X.shape[1]]))],
                                       zipmap=False, target_opset=15)
    # plan-v2 §4.6: the engine checks these before it runs the model
    onnx.helper.set_model_props(onx, {"labels": json.dumps(data.CLASSES), "input_kind": "features",
                                      "feature_names": json.dumps(names), "window": str(data.WIN),
                                      "rate_hz": str(data.FS),
                                      "pipeline_version": str(data.common.dsp.PIPELINE_VERSION),
                                      "trained_on": json.dumps(["e1", "e8"])})
    (out / "gbm.onnx").write_bytes(onx.SerializeToString())
    sess = ort.InferenceSession(str(out / "gbm.onnx"), providers=["CPUExecutionProvider"])
    probe = X[::997].astype(np.float32)
    worst = float(np.abs(sess.run(None, {"features": probe})[1] - model.predict(probe)).max())
    assert worst <= 1e-4, worst
    (out / "gbm.json").write_text(json.dumps({"classes": data.CLASSES, "features": names, "win": data.WIN,
                                              "fs": data.FS, "pipeline_version": data.common.dsp.PIPELINE_VERSION,
                                              "trained_on": ["e1", "e8"]}, indent=2))
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "gbm_locked.json").write_text(json.dumps(r, indent=2))
    print(f"wrote {out / 'gbm.txt'} and gbm.onnx (ONNX Runtime vs LightGBM {worst:.1e})")


def main():
    t0 = time.time()
    d = data.build_windows()
    X, names = features(d)
    print(f"{len(X)} windows, {X.shape[1]} features ({time.time() - t0:.0f} s)")
    splits = data.load_splits()
    if "--final" in sys.argv:
        final(d, X, names, splits)
        return 0
    results, importance = {}, np.zeros(len(names))
    for name, train, test in data.folds(d, splits):
        tr = train & (d["y"] != data.IGNORE)
        ds = lgb.Dataset(X[tr], d["y"][tr], weight=class_weights(d["y"][tr]))
        model = lgb.train(PARAMS, ds, ROUNDS)
        importance += model.feature_importance("gain")
        P = model.predict(X[test])
        results[name] = evaluate.score(P, d["y"][test], d["clip"][test], d["clips"])
        print(evaluate.line(name, results[name]))
    summ = evaluate.summary(results)
    print("summary:", summ)
    top = sorted(zip(importance, names), reverse=True)[:12]
    print("top features:", ", ".join(n for _, n in top))
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "gbm.json").write_text(json.dumps({"folds": results, "summary": summ,
                                                  "top_features": [n for _, n in top]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
