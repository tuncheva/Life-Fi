"""Scores for one test fold, shared by the GBM and the CNN.

- window macro-F1 over the classes that occur in the fold's test windows,
  and `transition_f1`: the same over sit_down / stand_up / lie_down /
  get_up only (None when the fold has none, e.g. the E8 rooms). Choose
  the transition model on `transition_f1`, never on `macro_f1`, which in
  the E8 rooms is only none / walking / fall (model-audit A.1);
- clip-level: an event clip (located) is `event_found` when its most
  confident event-class window has p > EVENT_P and is the right class.
  `event_top1` is the old, threshold-free version: with one event class
  in the fold it is close to automatic. `event_constant` is what always
  answering the fold's most common event class would score: a number
  below it means the model is worse than not looking;
- a walking / none clip has a false event when any window gives an event
  class p > EVENT_P.

Public-data scores are development numbers only (dataset-preparation §4.6),
never Life-Fi accuracy.
"""

import collections

import numpy as np
from sklearn.metrics import f1_score

from data import CLASSES, IGNORE

EVENT = [CLASSES.index(c) for c in ("sit_down", "stand_up", "lie_down", "get_up", "fall")]
TRANSITION = [CLASSES.index(c) for c in ("sit_down", "stand_up", "lie_down", "get_up")]
EVENT_P = 0.5


def _share(a, b):
    return round(a / b, 3) if b else None


def score(P, y, clip, clips):
    """P [W, n_classes] probabilities, y [W], clip [W] clip index into clips."""
    keep = y != IGNORE
    pred = P.argmax(axis=1)
    present = sorted(set(y[keep]))
    f1 = f1_score(y[keep], pred[keep], labels=present, average=None, zero_division=0)
    per_class = {CLASSES[c]: round(float(f), 3) for c, f in zip(present, f1)}
    trans = [float(f) for c, f in zip(present, f1) if c in TRANSITION]
    out = {"windows": int(keep.sum()),
           "macro_f1": float(np.mean(f1)) if len(f1) else 0.0,
           "transition_f1": float(np.mean(trans)) if trans else None,
           "per_class_f1": per_class}
    found = top1 = false = quiet = 0
    truth, found_by = collections.Counter(), collections.Counter()
    for ci in np.unique(clip):
        c = clips[ci]
        w = clip == ci
        pe = P[w][:, EVENT]
        if c["kind"] == "event":
            if not c["located"]:
                continue
            i, j = np.unravel_index(pe.argmax(), pe.shape)
            right = EVENT[j] == CLASSES.index(c["class"])
            truth[c["class"]] += 1
            top1 += right
            if right and pe[i, j] > EVENT_P:
                found += 1
                found_by[c["class"]] += 1
        else:
            quiet += 1
            false += (pe.max(axis=1) > EVENT_P).any()
    total = sum(truth.values())
    out["event_clips"] = total
    out["event_found"] = _share(found, total)
    out["event_top1"] = _share(top1, total)
    out["event_constant"] = _share(max(truth.values()), total) if total else None
    out["event_found_per_class"] = {k: _share(found_by[k], n) for k, n in sorted(truth.items())}
    out["quiet_clips"] = quiet
    out["false_event_share"] = _share(false, quiet)
    return out


KEYS = ("macro_f1", "transition_f1", "event_found", "event_top1", "event_constant", "false_event_share")


def summary(results):
    """Mean over folds of the main numbers, by fold family."""
    fam = {}
    for name, r in results.items():
        fam.setdefault(name.rsplit(" ", 1)[0], []).append(r)
    out = {}
    for f, rs in fam.items():
        out[f] = {k: round(float(np.mean([r[k] for r in rs if r[k] is not None])), 3)
                  for k in KEYS if any(r[k] is not None for r in rs)}
    return out


def line(name, r):
    """One printable line per fold."""
    tf = "-" if r["transition_f1"] is None else f"{r['transition_f1']:.3f}"
    return (f"{name:16s} transition-F1 {tf}  macro-F1 {r['macro_f1']:.3f}  found {r['event_found']} "
            f"(top-1 {r['event_top1']}, constant guess {r['event_constant']})  false {r['false_event_share']}  "
            f"{r['per_class_f1']}")
