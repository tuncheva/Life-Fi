"""Train CsiNet on every fold, or on all usable data for export.

    .venv/Scripts/python ml/train_cnn.py            # folds -> ml/results/cnn.json
    .venv/Scripts/python ml/train_cnn.py --final    # all non-locked data -> ml/models/csinet.pt

Same folds and scores as train_gbm.py. Training: AdamW (lr 1e-3, wd 1e-2),
cosine schedule, class-weighted cross-entropy with label smoothing 0.05,
fixed epoch count (no early stopping on the test fold).
"""

import argparse
import json
import math
import pathlib
import sys
import time

import numpy as np
import torch
import torch.nn.functional as Fn

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import data  # noqa: E402
import evaluate  # noqa: E402
from model import CsiNet, n_params  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
EPOCHS = 15
BATCH = 256
DEV = "cuda" if torch.cuda.is_available() else "cpu"


def view(x):
    """Model view on a torch batch [B, 52, T]."""
    return (x - x.mean(dim=-1, keepdim=True)).clamp(-10, 10)


def crop_centre(X):
    return X[..., data.MAX_SHIFT:data.MAX_SHIFT + data.WIN]


def augment(X):
    """X [B, 52, STORE] raw dB float32 -> [B, 52, WIN] model view, randomised (plan-v2 §6.8 + room changes)."""
    B, S, T = X.shape
    g = torch.rand
    # time warp +-10 %, then a random crop (time shift +-MAX_SHIFT)
    if g(1).item() < 0.3:
        f = 0.9 + 0.2 * g(1).item()
        X = Fn.interpolate(X, size=max(data.WIN, int(round(T * f))), mode="linear", align_corners=False)
    off = torch.randint(0, X.shape[-1] - data.WIN + 1, (1,)).item()
    x = X[..., off:off + data.WIN]
    # injected gain step (all subcarriers), before mean removal
    step = (g(B, 1, 1, device=X.device) < 0.2) * (6 * g(B, 1, 1, device=X.device) - 3)
    t0 = torch.randint(10, data.WIN - 10, (B, 1, 1), device=X.device)
    x = x + step * (torch.arange(data.WIN, device=X.device)[None, None] >= t0)
    x = view(x)
    # packet-loss holds of 2-8 samples
    if g(1).item() < 0.3:
        a = torch.randint(1, data.WIN - 8, (1,)).item()
        n = torch.randint(2, 9, (1,)).item()
        x[..., a:a + n] = x[..., a - 1:a]
    # movement strength and a smooth per-subcarrier response (another room / distance)
    x = x * (0.7 + 0.6 * g(B, 1, 1, device=X.device))
    ctrl = 1 + 0.4 * (2 * g(B, 1, 5, device=X.device) - 1)
    tilt = Fn.interpolate(ctrl, size=S, mode="linear", align_corners=True).transpose(1, 2)   # [B, 52, 1]
    x = x * tilt
    # random subcarrier mixing: a different multipath combination
    mix = g(B, device=X.device) < 0.5
    if mix.any():
        W = torch.eye(S, device=X.device) + 0.1 * torch.randn(int(mix.sum()), S, S, device=X.device)
        x[mix] = torch.bmm(W, x[mix])
    # subcarrier dropout and noise
    x = x * (g(B, S, 1, device=X.device) > 0.2)
    x = x + 0.3 * g(B, 1, 1, device=X.device) * torch.randn_like(x)
    return x.clamp(-10, 10)


def class_weights(y):
    counts = torch.bincount(y[y >= 0], minlength=len(data.CLASSES)).float()
    w = torch.where(counts > 0, counts.sum() / counts.clamp(min=1) / (counts > 0).sum(), torch.zeros_like(counts))
    return w


def train(Xg, yg, idx, epochs=EPOCHS, seed=0):
    torch.manual_seed(seed)
    model = CsiNet(len(data.CLASSES)).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-2)
    steps = epochs * math.ceil(len(idx) / BATCH)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=steps, pct_start=0.1,
                                                anneal_strategy="cos")
    w = class_weights(yg[idx])
    idx = torch.as_tensor(idx, device=DEV)
    model.train()
    for _ in range(epochs):
        perm = idx[torch.randperm(len(idx), device=DEV)]
        for i in range(0, len(perm), BATCH):
            b = perm[i:i + BATCH]
            x = augment(Xg[b].float())
            loss = Fn.cross_entropy(model(x), yg[b], weight=w, ignore_index=data.IGNORE, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
    return model


@torch.no_grad()
def predict(model, Xg, idx):
    model.eval()
    out = []
    idx = torch.as_tensor(idx, device=DEV)
    for i in range(0, len(idx), 2048):
        x = view(crop_centre(Xg[idx[i:i + 2048]].float()))
        out.append(torch.softmax(model(x), dim=1).cpu().numpy())
    return np.concatenate(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--final", action="store_true", help="train on all non-locked data and save the model")
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    args = ap.parse_args()
    t0 = time.time()
    d = data.build_windows()
    Xg = torch.from_numpy(d["X"]).to(DEV)                     # float16 on the GPU
    yg = torch.from_numpy(d["y"]).long().to(DEV)
    splits = data.load_splits()
    print(f"{len(d['y'])} windows on {DEV}, CsiNet {n_params(CsiNet(len(data.CLASSES)))} parameters "
          f"({time.time() - t0:.0f} s)")
    if args.final:
        locked = np.isin(d["subject"], splits["locked_subjects"])
        idx = np.where(~locked & (d["y"] != data.IGNORE))[0]
        model = train(Xg, yg, idx, args.epochs)
        (HERE / "models").mkdir(exist_ok=True)
        torch.save({"state_dict": model.state_dict(), "classes": data.CLASSES, "win": data.WIN,
                    "fs": data.FS, "pipeline_version": data.common.dsp.PIPELINE_VERSION,
                    "trained_on": ["e1", "e8"], "locked_subjects": splits["locked_subjects"]},
                   HERE / "models" / "csinet.pt")
        P = predict(model, Xg, np.where(locked)[0])
        r = evaluate.score(P, d["y"][locked], d["clip"][locked], d["clips"])
        print("LOCKED E1 subjects (scored once):", r)
        (HERE / "results").mkdir(exist_ok=True)
        (HERE / "results" / "cnn_locked.json").write_text(json.dumps(r, indent=2))
        return 0
    results = {}
    for name, train_m, test_m in data.folds(d, splits):
        t1 = time.time()
        model = train(Xg, yg, np.where(train_m & (d["y"] != data.IGNORE))[0], args.epochs)
        P = predict(model, Xg, np.where(test_m)[0])
        r = results[name] = evaluate.score(P, d["y"][test_m], d["clip"][test_m], d["clips"])
        print(f"{evaluate.line(name, r)}  ({time.time() - t1:.0f} s)")
    summ = evaluate.summary(results)
    print("summary:", summ)
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "cnn.json").write_text(json.dumps({"folds": results, "summary": summ}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
