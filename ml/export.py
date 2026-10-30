"""Export CsiNet to ONNX for the engine (plan-v2 §6.8 step 5).

    .venv/Scripts/python ml/export.py ml/models/csinet.pt          # -> ml/models/csinet.onnx

The graph takes the raw window F [B, 52, 150] in dB and returns class
probabilities [B, n_classes]: the model view (mean removal, clip) and the
softmax are inside, so the engine cannot get them wrong. The class names,
window, rate and pipeline version go into the ONNX metadata, where the
engine reads them without torch (plan-v2 §4.6). Checks ONNX Runtime
against PyTorch (max difference <= 1e-4) on a seeded random window and on
real windows.
"""

import json
import pathlib
import sys

import numpy as np
import onnx
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import data  # noqa: E402
from model import CsiNet  # noqa: E402

OPSET = 18


class Deployed(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, F):
        x = (F - F.mean(dim=-1, keepdim=True)).clamp(-10, 10)
        return torch.softmax(self.net(x), dim=1)


def load(path):
    ck = torch.load(path, map_location="cpu", weights_only=True)    # tensors + plain values only, no pickled code
    net = CsiNet(len(ck["classes"]))
    net.load_state_dict(ck["state_dict"])
    return net.eval(), ck


def export(pt_path, onnx_path=None, check_windows=None):
    import onnxruntime as ort

    net, ck = load(pt_path)
    model = Deployed(net).eval()
    onnx_path = pathlib.Path(onnx_path or pathlib.Path(pt_path).with_suffix(".onnx"))
    dummy = torch.zeros(1, 52, ck["win"])
    torch.onnx.export(model, dummy, onnx_path, opset_version=OPSET, input_names=["F"], output_names=["p"],
                      dynamic_axes={"F": {0: "batch"}, "p": {0: "batch"}}, dynamo=False)
    # plan-v2 §4.6: the engine reads these (no torch needed) and refuses a mismatch
    proto = onnx.load(str(onnx_path))
    onnx.helper.set_model_props(proto, {"labels": json.dumps(ck["classes"]), "input_kind": "window",
                                        "window": str(ck["win"]), "rate_hz": str(ck["fs"]),
                                        "pipeline_version": str(ck["pipeline_version"]),
                                        "trained_on": json.dumps(ck.get("trained_on", [])),
                                        "adapted": str(bool(ck.get("adapted", False)))})
    onnx.save(proto, str(onnx_path))
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    tests = [rng.normal(30, 2, (4, 52, ck["win"])).astype(np.float32)]
    if check_windows is not None:
        tests.append(check_windows.astype(np.float32))
    worst = 0.0
    for F in tests:
        with torch.no_grad():
            ref = model(torch.from_numpy(F)).numpy()
        worst = max(worst, float(np.abs(sess.run(None, {"F": F})[0] - ref).max()))
    assert worst <= 1e-4, f"ONNX Runtime differs from PyTorch by {worst}"
    return onnx_path, worst


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    d = data.build_windows()
    real = data.centre(d["X"][::5000].astype(np.float32))
    path, worst = export(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None, real)
    print(f"wrote {path}; ONNX Runtime vs PyTorch max difference {worst:.2e} on {len(real) + 4} windows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
