"""Windows, labels and splits for the transition model (plan-v2 §6.8).

A window is 3 s of F (150 samples at 50 Hz), every 0.5 s, inside one
continuous segment with >= 90 % valid samples. Stored 160 samples long so
training can crop it at a random offset (time-shift augmentation); the
centre 150 are the window.

Labels come from the clip label (public data has one event per clip and
no onset time):
- walking clips: every window is `walking`;
- event clips: the event time is the peak of the change envelope (how
  fast the slow, 0.5 s-smoothed profile changes). A window gets the class
  if it holds >= 70 % of [peak - 1.25 s, peak + 1.25 s], is ignored
  (-100) if it holds less but some, and is `none` otherwise. Clips whose
  peak is not clearly above the rest (peak / median < PEAK_RATIO) are
  ignored entirely: the event cannot be located;
- `none` clips (E8 turn, jump, squat, arm wave): every window is `none`.

Deviations from plan-v2 §6.8, both found on the data (2026-10-29):
- `fall` is its own class (plan-v2 folds it into `none`), so the model
  does not learn that a fall-like burst means "nothing happened", which
  would hurt `lie_down`. The fall alarm stays the rule.
- The event time is the peak of the *slow* change, not of |dF|: in E1 the
  sample-to-sample noise (0.3-1 dB; int8 amplitudes around 20) hides the
  movement, and only ~5 % of E1 event clips had a clear |dF| peak against
  62-86 % with the change envelope. That peak is mid-movement, so the
  span is centred on it instead of plan-v2's [onset - 0.5, onset + 2].
  Label taps on our own recordings must be snapped to the same peak.
"""

import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "datasets" / "readers"))

import common  # noqa: E402
from lifefi.features import model_view  # noqa: E402,F401  (plan-v2 §5.6; shared with the engine)

FS = 50
WIN = 150
STORE = 160                      # WIN + 2 * MAX_SHIFT
MAX_SHIFT = (STORE - WIN) // 2
HOP = 25
MIN_VALID = 0.9
SPAN = (-1.25, 1.25)             # event span around the change peak, s
MIN_COVER = 0.7
PEAK_RATIO = 3.0
IGNORE = -100
MAX_SAT = 0.01                   # clips with more saturated frames stay out (dataset-preparation §4.4)

# `rise` is stand_up and get_up in one class (model-training-plan §2.3 fallback,
# decided 2026-10-30): no public set has stand_up, and the team records none.
# The posture state machine tells them apart by the posture before the move.
CLASSES = ["none", "walking", "sit_down", "lie_down", "rise", "fall"]
C = {name: i for i, name in enumerate(CLASSES)}

# clip label -> (kind, class); kind: "segment" (all windows), "event", "none", or None (skip clip)
CLIP_MAP = {
    "e1": {"WA": ("segment", "walking"), "SD": ("event", "sit_down"), "LD": ("event", "lie_down"),
           "GU": ("event", "rise"), "FA": ("event", "fall")},
    "e8": {"walk": ("segment", "walking"), "fall": ("event", "fall"), "turn": ("none", "none"),
           "jump": ("none", "none"), "squat": ("none", "none"), "arm_wave": ("none", "none"),
           "run": (None, None)},    # burst-then-quiet like fall (model-training-plan §2.1): unusable label
}


def change_envelope(F):
    """How fast the 0.5 s-smoothed profile changes: mean over subcarriers of
    |lp(t + 0.25 s) - lp(t - 0.25 s)|, smoothed over 0.5 s. Zero within
    0.5 s of the edges, where the moving average is not defined."""
    k = np.ones(FS // 2) / (FS // 2)
    lp = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, F)
    h = FS // 4
    d = np.zeros(len(F))
    d[h:-h] = np.abs(lp[2 * h:] - lp[:-2 * h]).mean(axis=1)
    d[:FS // 2] = d[-(FS // 2):] = 0
    return np.convolve(d, k, mode="same")


def clip_windows(F, valid, kind, cls):
    """(starts of stored windows, labels, onset sample or -1) for one segment."""
    n = len(F)
    starts = np.arange(0, n - STORE + 1, HOP)
    if len(starts) == 0:
        return starts, np.zeros(0, int), -1
    ok = np.array([valid[s + MAX_SHIFT: s + MAX_SHIFT + WIN].mean() >= MIN_VALID for s in starts])
    starts = starts[ok]
    if kind == "segment":
        return starts, np.full(len(starts), C[cls]), -1
    if kind == "none":
        return starts, np.full(len(starts), C["none"]), -1
    m = change_envelope(F)
    onset = int(m.argmax())
    if m[onset] < PEAK_RATIO * np.median(m):
        return starts, np.full(len(starts), IGNORE), -1
    a, b = onset + SPAN[0] * FS, onset + SPAN[1] * FS
    w0 = starts + MAX_SHIFT
    cover = (np.minimum(w0 + WIN, b) - np.maximum(w0, a)).clip(0) / (b - a)
    labels = np.where(cover >= MIN_COVER, C[cls], np.where(cover > 0, IGNORE, C["none"]))
    return starts, labels, onset


def build_windows(dataset_ids=("e1", "e8")):
    """X float16 [W, 52, STORE] (raw dB, not yet mean-removed), y [W], and per-window meta arrays."""
    X, y, clip, room, subject, ds = [], [], [], [], [], []
    clips = []                                    # per clip: dataset, rec_id, label, onset ok
    for dataset_id in dataset_ids:
        Fs, Vs, meta = common.load(dataset_id)
        for F, V, m in zip(Fs, Vs, meta):
            kind, cls = CLIP_MAP[dataset_id].get(m["clip_label"], (None, None))
            if kind is None or float(m["sat_share"]) > MAX_SAT:
                continue
            starts, labels, onset = clip_windows(F, V, kind, cls)
            if len(starts) == 0:
                continue
            ci = len(clips)
            clips.append({"dataset": dataset_id, "rec_id": m["rec_id"], "class": cls, "kind": kind,
                          "located": onset >= 0 or kind != "event", "room": m["room"], "subject": m["subject"]})
            for s, lab in zip(starts, labels):
                X.append(F[s:s + STORE].T.astype(np.float16))
                y.append(lab)
                clip.append(ci)
                room.append(m["room"])
                subject.append(m["subject"])
                ds.append(dataset_id)
    return {"X": np.stack(X), "y": np.array(y), "clip": np.array(clip), "room": np.array(room),
            "subject": np.array(subject), "dataset": np.array(ds), "clips": clips}


def centre(X):
    return X[..., MAX_SHIFT:MAX_SHIFT + WIN]


def folds(d, splits):
    """Yield (name, train mask, test mask). Locked subjects are never in either."""
    locked = np.isin(d["subject"], splits["locked_subjects"])
    usable = ~locked
    for r in splits["room_folds"]:
        test = usable & (d["room"] == r)
        yield f"room {r}", usable & ~test, test
    for i, group in enumerate(splits["e1_subject_folds"]):
        test = usable & np.isin(d["subject"], group)
        yield f"e1 subjects {i + 1}", usable & ~test, test


def load_splits():
    import yaml
    with open(ROOT / "datasets" / "manifest" / "splits.yml") as fh:
        return yaml.safe_load(fh)
