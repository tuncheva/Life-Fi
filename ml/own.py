"""Our own recordings: .csirec (+ labels.jsonl) -> F -> windows (plan-v2 §4.3).

Times: labels are host wall-clock µs. Packets carry the ESP clock
(`ts_us`) and the host receive time; the ESP clock is the steady one, so
it is mapped onto host time with the lower envelope of host - ts (Wi-Fi
delivery only ever adds delay), per boot.

Marks are snapped to the change-envelope peak within +-SNAP_S, the same
event time the public data uses (ml.data). A mark with no clear peak
nearby is reported and its windows are ignored.

Window labels:
- marks sit_down, lie_down, fall -> that class; stand_up and get_up ->
  `rise` (one model class, ml.data);
  hard_negative_sit -> sit_down, hard_negative_liedown -> lie_down (they
  *are* those transitions; they are negatives for the fall rule only);
  hard_negative_drop and other hard negatives -> none;
- segment walking -> walking; empty, standing, sitting, lying,
  normal_activity, in_bed, bed_empty -> none; anything else ignored;
- unlabelled time -> ignored, except inside the labelled sessions' blocks.

Label files: the plan-v2 lines the labelling page writes
({"kind": "mark", "t_press_us", "event"} / {"kind": "segment", ...}), or
the key-press script's point marks {"t": host ms, "label": event}
(model-training-plan §5). Anything else stops with the line number: a
silently skipped label turns a training run into an all-ignored one.
"""

import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "firmware" / "tools"))

import data  # noqa: E402
from csi_recorder import load_csirec  # noqa: E402

dsp = data.common.dsp
SNAP_S = 1.5
MARK_CLASS = {"sit_down": "sit_down", "stand_up": "rise", "lie_down": "lie_down", "get_up": "rise",
              "fall": "fall", "hard_negative_sit": "sit_down", "hard_negative_liedown": "lie_down"}
SEGMENT_CLASS = {"walking": "walking", "empty": "none", "standing": "none", "sitting": "none", "lying": "none",
                 "normal_activity": "none", "in_bed": "none", "bed_empty": "none"}


def host_time_s(rec):
    """ESP time mapped onto host time, in s (one boot per recording assumed)."""
    ts = rec["ts_us"].astype(np.int64)
    host = rec["host_us"].astype(np.int64)
    off = np.percentile(host - ts, 2)
    return (ts + off) / 1e6


def load_segments(path):
    rec = load_csirec(path)
    if len(rec["ts_us"]) < 10:
        return []
    t = host_time_s(rec)
    t0 = t.min()
    segs = dsp.to_features(t - t0, np.abs(rec["csi"]))
    for s in segs:
        s.t = s.t + t0                                    # back to host seconds
    return segs


def _key_press_mark(L, where):
    """{"t": host ms, "label": event} -> a plan-v2 mark."""
    t, event = L["t"], L["label"]
    if not 1e12 <= t < 1e13:                              # host epoch ms is ~1.7e12
        raise ValueError(f"{where}: t = {t} is not host epoch milliseconds")
    if event in SEGMENT_CLASS:
        raise ValueError(f"{where}: '{event}' is a span, not a moment; a point mark cannot label it")
    return {"kind": "mark", "t_press_us": int(t * 1000), "event": event}


def read_labels(path):
    labels = []
    with open(path, encoding="utf-8") as fh:              # a missing file is an error, not "no labels"
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            L = json.loads(line)
            where = f"{path}:{n}"
            if L.get("kind") == "mark" and "t_press_us" in L and "event" in L:
                labels.append(L)
            elif L.get("kind") == "segment" and {"t_start_us", "t_end_us", "label"} <= L.keys():
                labels.append(L)
            elif "kind" not in L and {"t", "label"} <= L.keys():
                labels.append(_key_press_mark(L, where))
            else:
                raise ValueError(f"{where}: unknown label line {line.strip()[:120]}")
    return labels


def windows(csirec, labels_path=None, unlabelled="ignore"):
    """X float16 [W, 52, STORE], y [W], window start times (host s), report dict.

    unlabelled="ignore" for training sessions, "none" for a check run where
    every unlabelled moment is a real negative."""
    labels = read_labels(labels_path) if labels_path else []
    X, y, tw = [], [], []
    report = {"marks": 0, "snapped": 0, "unsnapped": [], "segment_samples": 0}
    default = data.IGNORE if unlabelled == "ignore" else data.C["none"]
    segs = load_segments(csirec)
    for s in segs:
        n = len(s.t)
        starts = np.arange(0, n - data.STORE + 1, data.HOP)
        if not len(starts):
            continue
        lab = np.full(n, default)                         # per-sample label, then per window
        for L in labels:
            if L.get("kind") == "segment" and L.get("label") in SEGMENT_CLASS:
                a, b = L["t_start_us"] / 1e6, L["t_end_us"] / 1e6
                inside = (s.t >= a) & (s.t < b)
                lab[inside] = data.C[SEGMENT_CLASS[L["label"]]]
                report["segment_samples"] += int(inside.sum())
        env = data.change_envelope(s.F)
        events = []
        for L in labels:
            if L.get("kind") != "mark":
                continue
            tp = L["t_press_us"] / 1e6
            if not (s.t[0] <= tp <= s.t[-1]):
                continue
            report["marks"] += 1
            near = np.where(np.abs(s.t - tp) <= SNAP_S)[0]
            k = near[env[near].argmax()]
            if env[k] < data.PEAK_RATIO * np.median(env):
                report["unsnapped"].append({"event": L["event"], "t_press_us": L["t_press_us"]})
                events.append((k, data.IGNORE))
                continue
            report["snapped"] += 1
            events.append((k, data.C[MARK_CLASS[L["event"]]] if L["event"] in MARK_CLASS else data.C["none"]))
        w0 = starts + data.MAX_SHIFT
        ok = np.array([s.valid[a:a + data.WIN].mean() >= data.MIN_VALID for a in w0])
        wl = np.array([np.bincount(lab[a:a + data.WIN] + 200).argmax() - 200 for a in w0])   # majority label
        for k, cls in events:
            a, b = k + data.SPAN[0] * data.FS, k + data.SPAN[1] * data.FS
            cover = (np.minimum(w0 + data.WIN, b) - np.maximum(w0, a)).clip(0) / (b - a)
            wl = np.where(cover >= data.MIN_COVER, cls, np.where(cover > 0, data.IGNORE, wl))
        for a, l, good in zip(starts, wl, ok):
            if good:
                X.append(s.F[a:a + data.STORE].T.astype(np.float16))
                y.append(l)
                tw.append(s.t[a + data.MAX_SHIFT])
    if labels and report["marks"] == 0 and report["segment_samples"] == 0 and segs:
        t0, t1 = min(s.t[0] for s in segs), max(s.t[-1] for s in segs)
        times = [L.get("t_press_us", L.get("t_start_us")) / 1e6 for L in labels]
        raise ValueError(f"{labels_path}: none of its {len(labels)} labels ({min(times):.0f}-{max(times):.0f} s) "
                         f"falls inside {csirec} ({t0:.0f}-{t1:.0f} s, host clock); wrong file or wrong clock?")
    if not X:
        return np.zeros((0, 52, data.STORE), np.float16), np.zeros(0, int), np.zeros(0), report
    return np.stack(X), np.array(y), np.array(tw), report
