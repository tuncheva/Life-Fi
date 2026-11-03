"""Trains the spot model (engine/lifefi/spots.py) on recordings made with ml/record_spots.py.

    .venv/Scripts/python ml/train_spots.py data/sessions/spots-*/          # -> data/spots_model.json

Windows of WIN_S every HOP_S inside each labelled spot (never across the
walk between spots). With two or more sessions the score is leave-one-
session-out: train on the other visits, test on a visit the model never
saw (the honest number). With one session: the last 30 % of every spot,
with a WIN_S gap so no window shares packets with training. Shrinkage (the
covariance pulled towards its diagonal) is chosen on that score, then the
final model is fitted on everything.

With two or more sessions the model file also gets `loso_bal_acc`: the
mean over test sessions of the balanced accuracy, scored as
ml/eval_position.py does (windows 2 s away from each spot's ends). The
engine shows a spot as `reliable` only when it beats chance by
rules.yaml spots.reliable_margin. One session writes none, so the model
reads as unreliable: a within-session score says nothing about another
visit. (The shrinkage is picked on the same score, so it is a little
optimistic.)
"""

import json
import pathlib
import sys
import time

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))

from csi_recorder import load_csirec  # noqa: E402
from lifefi.spots import WIN_S, MIN_PACKETS, features  # noqa: E402

HOP_S = 0.25
HOLDOUT = 0.3
TRIM_S = 2.0                     # the walk between spots: not scored (as ml/eval_position.py)
OUT = ROOT / "data" / "spots_model.json"


def windows(t, amp, rssi, t0, t1):
    out = []
    for s in np.arange(t0, t1 - WIN_S + 1e-9, HOP_S):
        a, b = np.searchsorted(t, [s, s + WIN_S])
        if b - a >= MIN_PACKETS:
            out.append((s, features(amp[a:b], rssi[a:b].mean())))
    return out


def load(dirs):
    X, y, part, sess, inner, labels, dist, sessions = [], [], [], [], [], [], {}, []
    for d in dirs:
        d = pathlib.Path(d)
        spec = json.loads((d / "spots.json").read_text(encoding="utf-8"))
        rec = load_csirec(next(d.glob("*.csirec")))
        t = rec["host_us"].astype(np.float64) / 1e6
        amp = np.abs(rec["csi"])
        rssi = rec["rssi"].astype(np.float64)
        sessions.append(spec["session"])
        for s in spec["spots"]:
            if s["name"] not in labels:
                labels.append(s["name"])
            dist[s["name"]] = s["d_m"] if s["name"] != "empty" else None
            t0, t1 = s["t0_us"] / 1e6, s["t1_us"] / 1e6
            cut = t1 - HOLDOUT * (t1 - t0)
            for ws, f in windows(t, amp, rssi, t0, t1):
                X.append(f)
                y.append(labels.index(s["name"]))
                # 0 train, 1 hold-out, -1 straddles the cut (dropped from the score)
                part.append(0 if ws + WIN_S <= cut - WIN_S else 1 if ws >= cut else -1)
                sess.append(len(sessions) - 1)
                inner.append(t0 + TRIM_S <= ws and ws + WIN_S <= t1 - TRIM_S)
    return np.array(X), np.array(y), np.array(part), np.array(sess), np.array(inner), labels, dist, sessions


def fit(X, y, k, shrink):
    """Linear discriminant on standardised features: (mu, sd, W [k, f], b [k])."""
    mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-6
    Z = (X - mu) / sd
    means = np.array([Z[y == c].mean(axis=0) for c in range(k)])
    R = Z - means[y]
    S = R.T @ R / max(len(Z) - k, 1)
    S = (1 - shrink) * S + shrink * np.diag(np.diag(S))
    Sinv = np.linalg.pinv(S)
    W = means @ Sinv
    b = -0.5 * np.einsum("kf,kf->k", W, means) + np.log(np.bincount(y, minlength=k) / len(y))
    return mu, sd, W, b


def predict(model, X):
    mu, sd, W, b = model
    return np.argmax(((X - mu) / sd) @ W.T + b, axis=1)


def balanced(truth, pred, k):
    return float(np.mean([np.mean(pred[truth == c] == c) for c in range(k) if np.any(truth == c)]))


def loso_bal_acc(X, y, sess, inner, k, shrink):
    """Balanced accuracy per left-out session (inner windows only) and their mean, or None under 2 sessions."""
    if len(np.unique(sess)) < 2:
        return None
    per = []
    for s in np.unique(sess):
        te = (sess == s) & inner
        per.append(balanced(y[te], predict(fit(X[sess != s], y[sess != s], k, shrink), X[te]), k))
    return float(np.mean(per)), per


def main():
    dirs = sys.argv[1:] or sorted(str(p) for p in (ROOT / "data" / "sessions").glob("spots-*"))
    X, y, part, sess, inner, labels, dist, sessions = load(dirs)
    k = len(labels)
    print(f"{len(X)} windows from {', '.join(sessions)}: " + ", ".join(f"{l} {np.sum(y == i)}" for i, l in enumerate(labels)))
    # (train, test) masks: leave one session out, or the time split inside the one session
    splits = ([(sess != s, sess == s) for s in range(len(sessions))] if len(sessions) > 1
              else [(part == 0, part == 1)])
    how = "leave-one-session-out" if len(sessions) > 1 else f"last {int(HOLDOUT * 100)} % of each spot"

    best = None
    for shrink in (0.05, 0.1, 0.2, 0.3, 0.5):
        truth, pred = [], []
        for tr, te in splits:
            truth.append(y[te])
            pred.append(predict(fit(X[tr], y[tr], k, shrink), X[te]))
        truth, pred = np.concatenate(truth), np.concatenate(pred)
        # balanced: every spot counts the same, however many windows it got
        acc = float(np.mean([np.mean(pred[truth == c] == c) for c in range(k) if np.any(truth == c)]))
        print(f"  shrink {shrink}: balanced accuracy {acc:.3f}")
        if best is None or acc > best[1]:
            best = (shrink, acc, truth, pred)
    shrink, acc, truth, pred = best
    conf = np.zeros((k, k), int)
    for a, p in zip(truth, pred):
        conf[a, p] += 1
    print(f"{how}, shrink {shrink}: balanced accuracy {acc:.3f}")
    print("  true \\ predicted  " + "  ".join(f"{l:>7}" for l in labels))
    for i, l in enumerate(labels):
        print(f"  {l:>16}  " + "  ".join(f"{c:>7}" for c in conf[i]))

    loso = loso_bal_acc(X, y, sess, inner, k, shrink)
    if loso is not None:
        print(f"loso_bal_acc {loso[0]:.3f} (per left-out session {', '.join(f'{v:.3f}' for v in loso[1])}; chance {1 / k:.2f})")
    else:
        print("one session: no loso_bal_acc, the engine will show this model as not reliable")

    mu, sd, W, b = fit(X, y, k, shrink)
    extra = {} if loso is None else {"loso_bal_acc": round(loso[0], 3), "loso_by_session": [round(v, 3) for v in loso[1]]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "labels": labels, "distances": dist, "mu": mu.tolist(), "sd": sd.tolist(), "W": W.tolist(), "b": b.tolist(),
        "shrink": shrink, "holdout_accuracy": round(acc, 3), "session": ",".join(sessions),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "win_s": WIN_S, **extra,
    }), encoding="utf-8")
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
