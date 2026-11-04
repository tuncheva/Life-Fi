"""The movement model in the engine: ONNX, no torch (plan-v2 §4.6).

Reads ml/models/gbm.onnx (input: the 53 lifefi.features of a window) or
ml/models/csinet.onnx (input: the window F itself). Both carry their
labels, input kind, window and pipeline version in the ONNX metadata
(ml/train_gbm.py, ml/export.py); a model whose pipeline version, window
or feature names do not match this engine is refused, never run.
onnxruntime is imported only here, so the rules run without it.
"""

import json
import pathlib
import time

import numpy as np

from . import dsp
from . import features as feat

FILES = {"gbm": "gbm.onnx", "cnn": "csinet.onnx"}


class ModelError(Exception):
    pass


class MovementModel:
    def __init__(self, path):
        import onnxruntime as ort

        self.path = pathlib.Path(path)
        self.sess = ort.InferenceSession(str(self.path), providers=["CPUExecutionProvider"])
        meta = self.sess.get_modelmeta().custom_metadata_map
        if "labels" not in meta:
            raise ModelError(f"{self.path.name} has no metadata; re-export it (ml/export.py, ml/train_gbm.py --final)")
        self.labels = json.loads(meta["labels"])
        self.kind = meta["input_kind"]
        self.window = int(meta["window"])
        self.pipeline_version = int(meta["pipeline_version"])
        if self.pipeline_version != dsp.PIPELINE_VERSION:
            raise ModelError(f"{self.path.name}: pipeline version {self.pipeline_version}, engine {dsp.PIPELINE_VERSION}")
        if int(float(meta.get("rate_hz", dsp.FS))) != int(dsp.FS):
            raise ModelError(f"{self.path.name}: trained at {meta['rate_hz']} Hz, F is {dsp.FS:.0f} Hz")
        if self.kind == "features":
            probe = np.zeros((1, 52, self.window), np.float32)
            _, names = feat.window_features(feat.model_view(probe), probe)
            if json.loads(meta["feature_names"]) != names:
                raise ModelError(f"{self.path.name}: its features do not match lifefi.features; retrain")
        self.input = self.sess.get_inputs()[0].name
        self.out = "probabilities" if self.kind == "features" else self.sess.get_outputs()[0].name
        self.name = self.path.stem
        self.ms = []

    def predict(self, F):
        """F [window, 52] dB (one window, time first, as lifefi.live keeps it) -> probabilities [n]."""
        t0 = time.perf_counter()
        x = np.ascontiguousarray(np.asarray(F, np.float32).T[None])          # [1, 52, window]
        if self.kind == "features":
            f, _ = feat.window_features(feat.model_view(x), x)
            p = self.sess.run([self.out], {self.input: f.astype(np.float32)})[0][0]
        else:
            p = self.sess.run([self.out], {self.input: x})[0][0]
        self.ms.append((time.perf_counter() - t0) * 1000)
        del self.ms[:-200]
        return np.asarray(p, np.float64)

    def timing(self):
        if not self.ms:
            return {"p50": 0.0, "p95": 0.0}
        return {"p50": round(float(np.percentile(self.ms, 50)), 2), "p95": round(float(np.percentile(self.ms, 95)), 2)}


def load(models_dir, which="gbm"):
    """(model or None, status dict for get_status). which: gbm | cnn | none."""
    if which == "none":
        return None, {"name": "transitions", "loaded": False, "reason": "disabled in rules.yaml"}
    path = pathlib.Path(models_dir) / FILES[which]
    if not path.exists():
        return None, {"name": "transitions", "loaded": False, "reason": f"{path} missing"}
    try:
        m = MovementModel(path)
    except ImportError:
        return None, {"name": "transitions", "loaded": False, "reason": "onnxruntime not installed"}
    except ModelError as err:
        return None, {"name": "transitions", "loaded": False, "reason": str(err)}
    return m, {"name": "transitions", "loaded": True, "file": path.name, "pipeline_version": m.pipeline_version,
               "labels": m.labels}
