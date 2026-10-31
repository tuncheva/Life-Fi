"""Fall-rule thresholds (lifefi.fall) from the downloaded data only.

    .venv/Scripts/python ml/tune_fall.py [--t-still X]

Decision 2026-10-30: no own mat falls will be recorded, so every public
fall set the licences allow is pooled (model-training-plan §10):

| Set | Falls | Negatives | Role |
|---|---|---|---|
| E8 (CC BY 4.0) | fall | walk, squat, jump, turn, arm_wave | tuning (stage 1 only: its subjects move again right after falling) |
| E15 (MIT) | fall_forward (5 real) | walking, sitting_down | tuning, stage 2 check (~13 s clips) |
| E1 (MIT) | FA, reported apart: gentler than its own sit-downs | SD, LD, GU, WA | tuning negatives |
| E9 (CC BY-NC-ND) | Fall (277, ESP32-S3) | Nonfall (217) | **held out**, scored once, never tunes |

E8 activity 1 ("run") stays out: it looks exactly like activity 2 ("fall")
(model-training-plan §2.1). E2 is not used (licence not stated).

Found 2026-10-30: the impact size in units of the quiet level depends on
the dataset, not only on the movement. The median fall peak is 187x in
E8, 31x in E15, 7x in E1 and 3x in E9 (each set's noise floor differs
~15x), and within E9 (ESP32-S3) the peak barely separates falls from the
rest (AUC 0.58). So a threshold picked on the pool (`pooled`, dominated
by E8) finds almost no E9 / E15 fall, and no public set shows people
lying still after a fall. Nothing here can tune the rule for our board.

What is chosen instead (`chosen`, also in engine/config/rules.yaml):
- `t_fall` = P(ANCHOR_Q) of the impact peak of E1's non-fall movements
  (sit down, lie down, get up, walk): E1 is the set closest to our chain
  (ESP32, HT20, 50 Hz), so at most ~5 % of ordinary movements on such
  hardware would start a fall candidate. How many real falls it catches
  is unknown;
- `ratio` = plan-v2's 4;
- `t_still` from E4 (ml/check_presence.py: P95 of M / baseline while a
  person sits or lies still, x T_STILL_MARGIN), so a person lying still
  after a fall passes stage 2.

`pooled` keeps the search that showed the problem: `t_fall` x `ratio`
for the highest pooled recall on E8 + E15 falls with at most MAX_FALSE of
the pooled negatives flagged, with leave-one-dataset-out.

The baseline is each clip's quiet level (lifefi.fall.baseline_quiet, P10
of M); live it is the empty calibration's P10 (lifefi.calibration), the
same statistic (E4: a still person's P10 is 0.7-1.7x the empty one).
Development numbers on other people's data, never Life-Fi accuracy.
Writes ml/results/fall_rule.json.
"""

import argparse
import itertools
import json
import pathlib
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "engine"))

import data  # noqa: E402
from lifefi import fall, motion  # noqa: E402

GRID = {"t_fall": [15, 20, 30, 40, 60, 80, 100, 130, 160, 200], "ratio": [1.5, 2, 4, 8]}
MAX_FALSE, MAX_FALSE_RELAXED = 0.05, 0.10
T_STILL_MARGIN = 1.2
ANCHOR_Q = 95
ANCHOR_NEG = ("SD", "LD", "GU", "WA")
TUNE = ("e8", "e15")
ROLES = {   # dataset -> clip label -> "fall" / "neg" / "fall_apart" (scored, never tunes)
    "e8": {"fall": "fall", "walk": "neg", "squat": "neg", "jump": "neg", "turn": "neg", "arm_wave": "neg"},
    "e15": {"fall": "fall", "walk": "neg", "sit_down": "neg"},
    "e1": {"SD": "neg", "LD": "neg", "GU": "neg", "WA": "neg", "FA": "fall_apart"},
    "e9": {"fall": "fall", "nonfall": "neg"},
}


def clips():
    out = []
    for ds, roles in ROLES.items():
        Fs, _, meta = data.common.load(ds)
        for F, m in zip(Fs, meta):
            role = roles.get(m["clip_label"])
            if role is None or len(F) < 2 * motion.FS:
                continue
            out.append({"F": F, "ds": ds, "role": role, "label": m["clip_label"], "room": m["room"]})
    return out


def _peak(F):
    """Largest M / quiet level after the first 1 s (filter warm-up)."""
    M = motion.motion(F)
    return float((M[int(motion.FS):] / fall.baseline_quiet(M)).max())


def _hits(args):
    F, combos, t_still = args
    M = motion.motion(F)
    base = fall.baseline_quiet(M)
    s1, s2 = [], []
    for c in combos:
        cands = fall.detect(F, base, t_still=t_still, M=M, **c)
        s1.append(bool(cands))
        s2.append(any(k.fall for k in cands))
    return s1, s2


def t_still_from_e4():
    path = HERE / "results" / "presence_e4.json"
    if not path.exists():
        return None
    v = json.loads(path.read_text()).get("motion", {}).get("t_still_p95_still_over_baseline")
    return None if v is None else round(v * T_STILL_MARGIN, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t-still", type=float, default=None, help="default: from ml/results/presence_e4.json")
    args = ap.parse_args()
    t_still = args.t_still or t_still_from_e4()
    if t_still is None:
        raise SystemExit("run ml/check_presence.py first (t_still comes from E4), or pass --t-still")
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    cl = clips()
    with ProcessPoolExecutor(8) as pool:
        peaks = np.array(list(pool.map(_peak, [c["F"] for c in cl], chunksize=16)))
        anchor_mask = np.array([c["ds"] == "e1" and c["label"] in ANCHOR_NEG for c in cl])
        anchor = {"t_fall": round(float(np.percentile(peaks[anchor_mask], ANCHOR_Q))), "ratio": fall.RATIO}
        combos.append(anchor)
        res = list(pool.map(_hits, [(c["F"], combos, t_still) for c in cl], chunksize=16))
    S1 = np.array([r[0] for r in res]).T            # [combos, clips]
    S2 = np.array([r[1] for r in res]).T
    ds = np.array([c["ds"] for c in cl])
    role = np.array([c["role"] for c in cl])
    label = np.array([c["label"] for c in cl])
    room = np.array([c["room"] for c in cl])

    def rate(H, i, mask):
        return round(float(H[i, mask].mean()), 3) if mask.any() else None

    def pick(fall_mask, neg_mask, H=S1):
        for limit in (MAX_FALSE, MAX_FALSE_RELAXED):
            ok = [i for i in range(len(combos)) if H[i, neg_mask].mean() <= limit]
            if ok:
                return max(ok, key=lambda i: (H[i, fall_mask].mean(), -H[i, neg_mask].mean())), limit
        return min(range(len(combos)), key=lambda i: H[i, neg_mask].mean()), None

    tune_fall = np.isin(ds, TUNE) & (role == "fall")
    tune_neg = np.isin(ds, TUNE + ("e1",)) & (role == "neg")
    best, limit = pick(tune_fall, tune_neg)
    print(f"t_still {t_still} (E4); pooled search picks {combos[best]} at <= {limit} negatives flagged")
    print(f"chosen (E1 anchor, P{ANCHOR_Q} of {', '.join(ANCHOR_NEG)} peaks): {anchor}")

    def report(i):
        r = {}
        for d in ROLES:
            m = ds == d
            r[d] = {"stage1_fall": rate(S1, i, m & (role == "fall")), "stage1_neg": rate(S1, i, m & (role == "neg")),
                    "full_fall": rate(S2, i, m & (role == "fall")), "full_neg": rate(S2, i, m & (role == "neg")),
                    "falls": int((m & (role == "fall")).sum()), "negatives": int((m & (role == "neg")).sum())}
            if (m & (role == "fall_apart")).any():
                r[d]["fall_apart_stage1"] = rate(S1, i, m & (role == "fall_apart"))
                r[d]["fall_apart_full"] = rate(S2, i, m & (role == "fall_apart"))
            r[d]["per_label_stage1"] = {lab: rate(S1, i, m & (label == lab)) for lab in sorted(set(label[m]))}
        return r

    loo = {}
    for test in TUNE:
        tr_f = np.isin(ds, [d for d in TUNE if d != test]) & (role == "fall")
        tr_n = np.isin(ds, [d for d in TUNE if d != test] + ["e1"]) & (role == "neg")
        i, lim = pick(tr_f, tr_n)
        te = ds == test
        loo[test] = {"thresholds": combos[i], "limit": lim, "picked_on": [d for d in TUNE if d != test] + ["e1"],
                     "stage1_fall": rate(S1, i, te & (role == "fall")), "stage1_neg": rate(S1, i, te & (role == "neg"))}
    rooms = {}
    for r in sorted(set(room[ds == "e8"])):
        tr_f, tr_n = tune_fall & (room != r), tune_neg & (room != r)
        i, lim = pick(tr_f, tr_n)
        te = room == r
        rooms[r] = {"thresholds": combos[i], "stage1_fall": rate(S1, i, te & (role == "fall")),
                    "stage1_neg": rate(S1, i, te & (role == "neg"))}
    per_label_peak = {f"{d} {lab}": {q: round(float(np.percentile(peaks[(ds == d) & (label == lab)], q)), 1)
                                     for q in (25, 50, 75, 95)}
                      for d in ROLES for lab in sorted(set(label[ds == d]))}
    out = {"t_still": t_still, "still_s": fall.STILL_S,
           "chosen": {**anchor, "t_still": t_still, "how": f"P{ANCHOR_Q} of E1 non-fall impact peaks"},
           "chosen_report": report(len(combos) - 1), "peak_over_quiet_level": per_label_peak,
           "pooled": {"thresholds": combos[best], "limit": limit, "report": report(best),
                      "leave_one_dataset_out": loo, "e8_leave_one_room_out": rooms},
           "grid": {json.dumps(c): {"tune_fall": rate(S1, i, tune_fall), "tune_neg": rate(S1, i, tune_neg)}
                    for i, c in enumerate(combos[:-1])}}
    for name, rep in (("pooled", out["pooled"]["report"]), ("chosen", out["chosen_report"])):
        print(name)
        for d, r in rep.items():
            print(f"  {d:4s} stage 1: falls {r['stage1_fall']}  negatives {r['stage1_neg']}   "
                  f"full rule: falls {r['full_fall']}  negatives {r['full_neg']}   ({r['falls']} falls, {r['negatives']} neg)"
                  + (f"   FA apart: {r.get('fall_apart_stage1')}" if "fall_apart_stage1" in r else ""))
    print("leave-one-dataset-out:", loo)
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "fall_rule.json").write_text(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
