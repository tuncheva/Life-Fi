"""The engine reproduces the GBM's test vectors (model-audit B.7).

    python engine/tests/test_features_vectors.py

ml/gbm_vectors.py wrote 12 windows with their raw F, the 53 features and
gbm.txt's probabilities. The engine computes the features with the same
lifefi.features and runs gbm.onnx through lifefi.models, so both must
match. Needs ml/models/ (gitignored: rebuilt by ml/train_gbm.py --final
and ml/gbm_vectors.py) and onnxruntime; skips without them (CI).
"""

import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
from lifefi import features, models  # noqa: E402

VECTORS = ROOT / "ml" / "models" / "gbm_vectors.json"
failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


try:
    import onnxruntime  # noqa: F401
except ImportError:
    onnxruntime = None
if not VECTORS.exists() or onnxruntime is None:
    print(f"test_features_vectors SKIPPED: {'no ' + str(VECTORS) if not VECTORS.exists() else 'no onnxruntime'}")
    sys.exit(0)

v = json.loads(VECTORS.read_text())
m, status = models.load(ROOT / "ml" / "models", "gbm")
check(m is not None, f"gbm.onnx loads through lifefi.models ({status})")
check(m.labels == v["classes"], f"labels match ({m.labels})")
worst_f = worst_p = worst_full = 0.0
for vec in v["vectors"]:
    F = np.array(vec["F"], np.float32)[None]                 # [1, 52, 150]
    f, names = features.window_features(features.model_view(F), F)
    ref = np.array(vec["features"], np.float64)
    worst_f = max(worst_f, float(np.max(np.abs(f[0] - ref) / np.maximum(np.abs(ref), 1e-3))))
    p = m.sess.run(["probabilities"], {"features": ref[None].astype(np.float32)})[0][0]
    worst_p = max(worst_p, float(np.abs(p - np.array(vec["p"])).max()))
    worst_full = max(worst_full, float(np.abs(m.predict(F[0].T) - np.array(vec["p"])).max()))
check(names == v["features"], "same 53 feature names")
check(worst_f <= 1e-3, f"features within 1e-3 relative ({worst_f:.1e}; the stored F is rounded to 1e-4 dB)")
check(worst_p <= 1e-4, f"ONNX probabilities from the stored features within 1e-4 of gbm.txt ({worst_p:.1e})")
check(worst_full <= 1e-3, f"whole engine path F -> probabilities within 1e-3 ({worst_full:.1e})")

print(f"\ntest_features_vectors {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
