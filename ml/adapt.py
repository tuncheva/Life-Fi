"""Adapt CsiNet to a new room (the venue): model-training-plan §6, plan-v2 §6.11.

Not part of the demo (decision 2026-10-30, model-training-plan §0): no own
recordings, posture is hidden, and the venue setup is the 2-min empty
calibration only. Kept for the day own recordings exist.

    .venv/Scripts/python ml/adapt.py --model ml/models/csinet.pt \
        --free venue/free.csirec \
        [--guided venue/guided.csirec --guided-labels venue/guided_labels.jsonl] \
        [--check venue/check.csirec --check-labels venue/check_labels.jsonl] \
        --out ml/models/csinet_venue.pt

1. AdaBN (labels not needed): re-estimate every BatchNorm mean / variance
   on the windows of --free (and --guided). Weights stay the same, so it
   cannot overfit; it tells the model what "normal" looks like here.
2. Optional head fine-tune: retrain only the last linear layer on the
   labelled --guided windows (5 minutes cannot retrain 58 k weights).
3. Optional keep / reject: score old and new on the separate --check run.
   The new model is kept unless its macro-F1 is more than 0.05 worse.
   Without --check the adapted model is kept (and the script says so).
   The check run holds ~9 events, so the script also prints a 90 % block
   bootstrap interval of the difference; when it is wider than the 0.05
   margin, the decision is a coin flip and it says so.
The kept model is written to --out and exported to ONNX next to it.
"""

import argparse
import copy
import pathlib
import sys

import numpy as np
import torch
import torch.nn.functional as Fn
from sklearn.metrics import f1_score

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import data  # noqa: E402
import export  # noqa: E402
import own  # noqa: E402

MAX_WORSE = 0.05
BLOCK_S = 5.0                 # bootstrap resamples 5 s stretches of the check run, not single windows
BOOT = 500


def view(X):
    x = torch.from_numpy(data.centre(X.astype(np.float32)))
    return (x - x.mean(dim=-1, keepdim=True)).clamp(-10, 10)


def adabn(net, X):
    net = copy.deepcopy(net)
    for m in net.modules():
        if isinstance(m, torch.nn.BatchNorm1d):
            m.reset_running_stats()
            m.momentum = None                     # cumulative average over all batches
    net.train()
    with torch.no_grad():
        x = view(X)
        for i in range(0, len(x), 256):
            net(x[i:i + 256])
    return net.eval()


def finetune_head(net, X, y, epochs=30):
    net = copy.deepcopy(net)
    keep = y != data.IGNORE
    x, yt = view(X[keep]), torch.from_numpy(y[keep]).long()
    for p in net.parameters():
        p.requires_grad = False
    head = net.head[-1]
    for p in head.parameters():
        p.requires_grad = True
    opt = torch.optim.AdamW(head.parameters(), lr=1e-3, weight_decay=1e-2)
    net.eval()                                    # BatchNorm statistics stay those of AdaBN
    for _ in range(epochs):
        for i in torch.randperm(len(x)).split(64):
            loss = Fn.cross_entropy(net(x[i]), yt[i], label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
    return net.eval()


def predict(net, X):
    with torch.no_grad():
        return net(view(X)).argmax(dim=1).numpy()


def _f1(y, pred):
    return float(f1_score(y, pred, labels=sorted(set(y)), average="macro", zero_division=0))


def compare(old, new, X, y, t):
    """macro-F1 old, new, and a 90 % block-bootstrap interval of new - old."""
    keep = y != data.IGNORE
    y, t, p_old, p_new = y[keep], t[keep], predict(old, X[keep]), predict(new, X[keep])
    block = ((t - t.min()) // BLOCK_S).astype(int)
    ids = np.unique(block)
    rng = np.random.default_rng(0)
    diffs = []
    for _ in range(BOOT):
        w = np.concatenate([np.where(block == b)[0] for b in rng.choice(ids, len(ids))])
        diffs.append(_f1(y[w], p_new[w]) - _f1(y[w], p_old[w]))
    return _f1(y, p_old), _f1(y, p_new), np.percentile(diffs, [5, 95])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=str(HERE / "models" / "csinet.pt"))
    ap.add_argument("--free", required=True, nargs="+", help="unlabelled free-movement recording(s)")
    ap.add_argument("--guided")
    ap.add_argument("--guided-labels")
    ap.add_argument("--check")
    ap.add_argument("--check-labels")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    old, ck = export.load(args.model)
    Xfree = [own.windows(p)[0] for p in args.free]
    Xg = yg = None
    if args.guided:
        Xg, yg, _, rep = own.windows(args.guided, args.guided_labels)
        print(f"guided: {len(yg)} windows, {rep['snapped']}/{rep['marks']} marks snapped")
        Xfree.append(Xg)
    Xfree = np.concatenate(Xfree)
    print(f"AdaBN on {len(Xfree)} windows ({len(Xfree) * data.HOP / data.FS / 60:.1f} min)")
    new = adabn(old, Xfree)
    if Xg is not None and (yg != data.IGNORE).sum() >= 20:
        new = finetune_head(new, Xg, yg)
        print("head fine-tuned on the guided run")
    keep_new = True
    if args.check:
        Xc, yc, tc, rep = own.windows(args.check, args.check_labels, unlabelled="none")
        if rep["snapped"] == 0:
            raise SystemExit(f"check run: none of its {rep['marks']} marks snapped to a movement; "
                             "it can only score `none`, so it cannot judge the models")
        f_old, f_new, (lo, hi) = compare(old, new, Xc, yc, tc)
        keep_new = f_new >= f_old - MAX_WORSE
        print(f"check run ({len(yc)} windows, {rep['snapped']}/{rep['marks']} marks snapped): "
              f"macro-F1 old {f_old:.3f}, adapted {f_new:.3f}, difference 90 % interval [{lo:+.2f}, {hi:+.2f}] "
              f"-> keep {'ADAPTED' if keep_new else 'OLD'}")
        if hi - lo > 2 * MAX_WORSE:
            print(f"  the interval is wider than +-{MAX_WORSE}: too few events to tell the models apart; "
                  "treat this as a sanity check, not a measurement")
    else:
        print("no --check run: keeping the adapted model unchecked")
    net = new if keep_new else old
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({**ck, "state_dict": net.state_dict(), "adapted": keep_new}, out)
    onnx_path, worst = export.export(out, check_windows=data.centre(Xfree[:16].astype(np.float32)))
    print(f"wrote {out} and {onnx_path} (ONNX vs PyTorch {worst:.1e})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
