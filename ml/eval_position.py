"""Honest evaluation of the "where" outputs: occupancy, spots, distance (overnight plan A, §2).

    .venv/Scripts/python ml/eval_position.py                  # all sessions -> ml/results/position_eval.json
    .venv/Scripts/python ml/eval_position.py --synthetic      # the synthetic checks only (no data/ needed)
    .venv/Scripts/python ml/eval_position.py --fit-occupancy  # the rules.yaml occupancy block (both sessions pooled)

Sessions: every data/sessions/spots-*/ with a spots.json (ml/record_spots.py;
_invalid/ is not looked at). The protocol is fixed in advance:

- leave-one-session-out only: everything fitted (thresholds, logistic,
  centroids, z-scores, distance fit) is fitted on the training session of
  that fold. Both directions are reported, never only their mean;
- windows with a 1 s hop inside each spot, 2 s trimmed at both ends (the
  walk between spots). The intervals come from the non-overlapping
  windows (`n_independent`): a 95 % Wilson interval on every class recall;
  the balanced accuracy's interval is the mean of those bounds;
- 4 s is the headline occupancy window, chosen before looking at the test
  sessions (the shortest with >= 32 packets at S1's worst rate). 6 s and
  10 s are a sensitivity check only;
- an empty-room reference, where a variant uses one: `fresh` = the first
  30 s of the test session's empty minute (then not scored), `stale` = the
  training session's. Empty is recorded last, so `fresh` is a calibration
  taken after, slightly optimistic;
- the engine itself replays each session (results every 0.5 s) without and
  with an empty calibration from those 30 s, and its published fields are
  scored per spot.
"""

import argparse
import json
import math
import pathlib
import sys
import time

import numpy as np
import yaml
from scipy.stats import spearmanr

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))
sys.path.insert(0, str(ROOT / "ml"))

from csi_recorder import iter_csirec, load_csirec  # noqa: E402
from lifefi import calibration as calibration_mod  # noqa: E402
from lifefi import engine as engine_mod  # noqa: E402
from lifefi import position, spots  # noqa: E402
from lifefi.occupancy import MIN_HZ, P_FLOOR, Occupancy  # noqa: E402
from lifefi.synth import synth  # noqa: E402
import train_spots  # noqa: E402

SESSIONS = ROOT / "data" / "sessions"
OUT = ROOT / "ml" / "results" / "position_eval.json"
LABELS = ["close", "middle", "far", "empty"]
OCC_WINDOWS = (4.0, 6.0, 10.0)
HEADLINE_W = 4.0
TRIM_S, HOP_S, CAL_S = 2.0, 1.0, 30.0
SPOT_HOP_S = 0.5
LDA_SHRINK = 0.3                 # the saved model's (data/spots_model.json)
TICK_S = 0.5


# ---- data ---------------------------------------------------------------
def find_sessions():
    return sorted(d for d in SESSIONS.glob("spots-*") if (d / "spots.json").exists())


def load_session(d):
    spec = json.loads((d / "spots.json").read_text(encoding="utf-8"))
    path = next(d.glob("*.csirec"))
    rec = load_csirec(path)
    t = rec["host_us"].astype(np.float64) / 1e6
    amp = np.abs(rec["csi"])
    spots_ = [{"name": s["name"], "d_m": s["d_m"] if s["name"] != "empty" else None,
               "t0": s["t0_us"] / 1e6, "t1": s["t1_us"] / 1e6} for s in spec["spots"]]
    return {"name": d.name, "short": d.name[-6:], "path": path, "spots": spots_, "t": t, "amp": amp,
            "x": position.gain_free_db(amp), "rssi": rec["rssi"].astype(np.float64)}


def empty_spot(s):
    return next(sp for sp in s["spots"] if sp["name"] == "empty")


def starts(sp, win, hop):
    return np.arange(sp["t0"] + TRIM_S, sp["t1"] - TRIM_S - win + 1e-9, hop)


def is_cal(sp, st, win):
    """The window lies in the first CAL_S of the empty minute (the `fresh` reference)."""
    return sp["name"] == "empty" and st + win <= sp["t0"] + CAL_S


# ---- scoring ------------------------------------------------------------
def wilson(k, n, z=1.96):
    if n <= 0:
        return None
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def score(truth, pred, names, n_ind):
    """Balanced accuracy, recall per class, Wilson intervals from the independent counts."""
    out = {"recall": {}, "n": {}, "n_independent": {}, "ci95": {}}
    lo, hi, rec = [], [], []
    for c, name in enumerate(names):
        m = truth == c
        if not m.any():
            continue
        r = float(np.mean(pred[m] == c))
        n = int(n_ind.get(name, 0))
        ci = wilson(round(r * n), n)
        rec.append(r)
        out["recall"][name] = round(r, 3)
        out["n"][name] = int(m.sum())
        out["n_independent"][name] = n
        out["ci95"][name] = ci
        if ci:
            lo.append(ci[0])
            hi.append(ci[1])
    out["bal_acc"] = round(float(np.mean(rec)), 3) if rec else None
    out["bal_acc_ci95"] = [round(float(np.mean(lo)), 3), round(float(np.mean(hi)), 3)] if lo else None
    return out


def confusion(truth, pred, k):
    m = np.zeros((k, k), int)
    for a, p in zip(truth, pred):
        m[a, p] += 1
    return m.tolist()


def directions(sessions):
    """(training session indices, test index): leave one session out."""
    return [([i for i in range(len(sessions)) if i != j], j) for j in range(len(sessions))]


def dir_name(sessions, tr, te):
    return f"{'+'.join(sessions[i]['short'] for i in tr)}->{sessions[te]['short']}"


def cat(parts):
    """Concatenate the arrays of several sessions' window dicts / tuples."""
    if isinstance(parts[0], dict):
        return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    return tuple(np.concatenate([p[i] for p in parts]) for i in range(len(parts[0])))


# ---- occupancy ----------------------------------------------------------
def occ_windows(s, win, hop):
    """log10 P per window, occupied flag, start, is-calibration-window."""
    rows = []
    for sp in s["spots"]:
        for st in starts(sp, win, hop):
            a, b = np.searchsorted(s["t"], [st, st + win])
            r = position.disturbance(s["t"][a:b], s["x"][a:b], win, int(MIN_HZ * win))
            if r is not None:
                rows.append((np.log10(max(r[0], P_FLOOR)), sp["name"] != "empty", st, is_cal(sp, st, win), sp["name"]))
    lp, occ, st, cal, name = map(np.array, zip(*rows))
    return {"lp": lp, "occ": occ, "cal": cal, "name": name}


def best_threshold(lp, occ):
    ths = np.linspace(-4.0, 1.0, 201)
    bal = [0.5 * (np.mean(lp[occ] > h) + np.mean(lp[~occ] <= h)) for h in ths]
    return float(ths[int(np.argmax(bal))])


def fit_logistic(lp, occ, ridge=0.01):
    """Class-balanced logistic p = 1/(1+exp(-(lp - offset)/scale)) by Newton steps; (offset, scale)."""
    w = np.where(occ, 0.5 / occ.sum(), 0.5 / (~occ).sum())
    X = np.column_stack([lp, np.ones_like(lp)])
    beta = np.array([1.0, 0.0])
    for _ in range(100):
        p = 1.0 / (1.0 + np.exp(-np.clip(X @ beta, -50, 50)))
        g = X.T @ (w * (p - occ)) + ridge * np.array([beta[0], 0.0])
        H = (X * (w * p * (1 - p))[:, None]).T @ X + ridge * np.diag([1.0, 0.0]) + 1e-9 * np.eye(2)
        step = np.linalg.solve(H, g)
        beta -= step
        if np.abs(step).max() < 1e-8:
            break
    return float(-beta[1] / beta[0]), float(1.0 / beta[0])


def logistic(lp, offset, scale):
    return 1.0 / (1.0 + np.exp(-np.clip((lp - offset) / scale, -50, 50)))


def occ_counts(s, win):
    """Non-overlapping windows per class (occupied / empty) that give a P."""
    w = occ_windows(s, win, win)
    return {"occupied": int(w["occ"].sum()), "empty": int((~w["occ"]).sum())}


def eval_occupancy(sessions, rules_occ):
    variants, within = {}, {}
    for win in OCC_WINDOWS:
        W = [occ_windows(s, win, HOP_S) for s in sessions]
        N = [occ_counts(s, win) for s in sessions]
        name = f"occupancy_{int(win)}s"
        variants[name] = {}
        for tr, te in directions(sessions):
            trw = cat([W[i] for i in tr])
            th = best_threshold(trw["lp"], trw["occ"])
            off, sc = fit_logistic(trw["lp"], trw["occ"])
            tw = W[te]
            truth = (~tw["occ"]).astype(int)               # 0 occupied, 1 empty
            res = score(truth, (~(tw["lp"] > th)).astype(int), ["occupied", "empty"], N[te])
            p = logistic(tw["lp"], off, sc)
            lg = score(truth, (p < 0.5).astype(int), ["occupied", "empty"], N[te])
            on, offp = rules_occ["p_on"], rules_occ["p_off"]
            decided = (p >= on) | (p <= offp)
            dec = score(truth[decided], (p[decided] <= offp).astype(int), ["occupied", "empty"], N[te]) if decided.any() else {}
            res.update({"chance": 0.5, "threshold_log10P": round(th, 3),
                        "logistic": {"offset": round(off, 3), "scale": round(sc, 3), "bal_acc_p50": lg["bal_acc"],
                                     "recall_p50": lg["recall"], "unsure_share": round(float(1 - decided.mean()), 3),
                                     "decided_bal_acc": dec.get("bal_acc"), "decided_recall": dec.get("recall")}})
            variants[name][dir_name(sessions, tr, te)] = res
        if win == HEADLINE_W:
            for k, s in enumerate(sessions):
                th = best_threshold(W[k]["lp"], W[k]["occ"])
                within[f"occupancy_4s_{s['short']}"] = round(
                    0.5 * (np.mean(W[k]["lp"][W[k]["occ"]] > th) + np.mean(W[k]["lp"][~W[k]["occ"]] <= th)), 3)
    return variants, within


def fit_occupancy(sessions):
    W = [occ_windows(s, HEADLINE_W, HOP_S) for s in sessions]
    lp = np.concatenate([w["lp"] for w in W])
    occ = np.concatenate([w["occ"] for w in W])
    return fit_logistic(lp, occ)


# ---- spots --------------------------------------------------------------
def spot_windows(s):
    X, y, cal = [], [], []
    for sp in s["spots"]:
        for st in starts(sp, spots.WIN_S, SPOT_HOP_S):
            a, b = np.searchsorted(s["t"], [st, st + spots.WIN_S])
            if b - a >= spots.MIN_PACKETS:
                X.append(spots.features(s["amp"][a:b], s["rssi"][a:b].mean()))
                y.append(LABELS.index(sp["name"]))
                cal.append(is_cal(sp, st, spots.WIN_S))
    return np.array(X), np.array(y), np.array(cal)


def spot_counts(s, fresh=False):
    out = {}
    for sp in s["spots"]:
        n = 0
        for st in starts(sp, spots.WIN_S, spots.WIN_S):
            a, b = np.searchsorted(s["t"], [st, st + spots.WIN_S])
            n += b - a >= spots.MIN_PACKETS and not (fresh and is_cal(sp, st, spots.WIN_S))
        out[sp["name"]] = int(n)
    return out


def where3(scores, y):
    """close / middle / far on occupied windows: the best of the three spot scores (chance 1/3)."""
    m = y < 3
    return y[m], np.argmax(scores[m][:, :3], axis=1)


def eval_spots(sessions):
    D = [spot_windows(s) for s in sessions]
    out = {"spot_lda_current": {}, "spot_e2_fresh": {}, "spot_e2_stale": {}}
    ix = np.arange(52, 104)                      # log-std per subcarrier
    for tr, te in directions(sessions):
        Xtr, ytr, ctr = cat([D[i] for i in tr])
        Xte, yte, cte = D[te]
        dn = dir_name(sessions, tr, te)
        ni = spot_counts(sessions[te])
        mu, sd, Wm, b = train_spots.fit(Xtr, ytr, 4, LDA_SHRINK)
        S = ((Xte - mu) / sd) @ Wm.T + b
        pred = np.argmax(S, axis=1)
        res = score(yte, pred, LABELS, ni)
        t3, p3 = where3(S, yte)
        w3 = score(t3, p3, LABELS[:3], ni)
        out["spot_lda_current"][dn] = {"spot_bal_acc": res["bal_acc"], "spot_bal_acc_ci95": res["bal_acc_ci95"],
                                       "chance": 0.25, "recall": res["recall"], "n_independent": res["n_independent"],
                                       "ci95": res["ci95"], "spot_confusion": confusion(yte, pred, 4),
                                       "where3_bal_acc": w3["bal_acc"], "where3_bal_acc_ci95": w3["bal_acc_ci95"],
                                       "where3_recall": w3["recall"], "where3_chance": 0.333}
        # E2 (harness only): log-std minus an empty-room profile, nearest centroid
        ref_tr = Xtr[ctr][:, ix].mean(axis=0)
        ref_te = Xte[cte][:, ix].mean(axis=0)
        for mode, ref in (("fresh", ref_te), ("stale", ref_tr)):
            A = Xtr[~ctr][:, ix] - ref_tr
            ya = ytr[~ctr]
            B = Xte[~cte][:, ix] - ref
            yb = yte[~cte]
            m_, s_ = A.mean(axis=0), A.std(axis=0) + 1e-6
            C = np.array([((A - m_) / s_)[ya == c].mean(axis=0) for c in range(4)])
            dist = (((((B - m_) / s_)[:, None, :]) - C[None]) ** 2).sum(-1)
            pred = np.argmin(dist, axis=1)
            nf = spot_counts(sessions[te], fresh=True)
            res = score(yb, pred, LABELS, nf)
            t3, p3 = where3(-dist, yb)
            w3 = score(t3, p3, LABELS[:3], nf)
            out[f"spot_e2_{mode}"][dn] = {"spot_bal_acc": res["bal_acc"], "spot_bal_acc_ci95": res["bal_acc_ci95"],
                                         "chance": 0.25, "recall": res["recall"], "n_independent": res["n_independent"],
                                         "spot_confusion": confusion(yb, pred, 4), "where3_bal_acc": w3["bal_acc"],
                                         "where3_bal_acc_ci95": w3["bal_acc_ci95"], "where3_recall": w3["recall"],
                                         "where3_chance": 0.333}
    return out


# ---- distance -----------------------------------------------------------
def dist_windows(s):
    """10 s windows (position.WIN_S, MIN_FRAMES): P, true d (None for empty), is-calibration-window."""
    rows = []
    for sp in s["spots"]:
        for st in starts(sp, position.WIN_S, HOP_S):
            a, b = np.searchsorted(s["t"], [st, st + position.WIN_S])
            r = position.disturbance(s["t"][a:b], s["x"][a:b])
            if r is not None:
                rows.append((r[0], sp["d_m"], is_cal(sp, st, position.WIN_S)))
    return rows


def dist_metrics(d_true, d_est):
    d_true, d_est = np.asarray(d_true), np.asarray(d_est)
    zt = [position.zone_of(d) for d in d_true]
    ze = [position.zone_of(d) for d in d_est]
    rho = spearmanr(d_true, d_est).statistic if len(set(d_true)) > 1 else float("nan")
    return {"distance_mae_m": round(float(np.mean(np.abs(d_est - d_true))), 2),
            "zone_acc": round(float(np.mean([a == b for a, b in zip(zt, ze)])), 3),
            "distance_spearman": None if np.isnan(rho) else round(float(rho), 3),
            "d_median_by_true": {str(d): round(float(np.median(d_est[d_true == d])), 2) for d in sorted(set(d_true))},
            "n": int(len(d_true))}


def eval_distance(sessions):
    out = {"distance_current_nocal": {}, "distance_current_fresh": {}, "distance_refit_e7": {}}
    R = [dist_windows(s) for s in sessions]
    pos = position.Position()
    for k, s in enumerate(sessions):
        occ = [(P, d) for P, d, c in R[k] if d is not None]
        P = np.array([p for p, _ in occ])
        d = np.array([d for _, d in occ])
        floor = float(np.median([p for p, dd, c in R[k] if c])) if any(c for _, _, c in R[k]) else 0.0
        for tag, fl in (("nocal", 0.0), ("fresh", floor)):
            Rdb = 10 * np.log10(np.maximum(P - fl, 1e-4))
            est = np.array([pos.to_distance(r) for r in Rdb])
            m = dist_metrics(d, est)
            m["spearman_d_vs_logP"] = round(float(spearmanr(d, np.log10(np.maximum(P, P_FLOOR))).statistic), 3)
            m["A"], m["n_exp"] = pos.A, pos.n
            out[f"distance_current_{tag}"][s["short"]] = m
    for tr, te in directions(sessions):
        occ = [(P, d) for i in tr for P, d, c in R[i] if d is not None]
        Rdb = 10 * np.log10(np.maximum([p for p, _ in occ], 1e-4))
        slope, A = np.polyfit(np.log10([d for _, d in occ]), Rdb, 1)
        n = -slope / 10.0
        occ_te = [(P, d) for P, d, c in R[te] if d is not None]
        Rt = 10 * np.log10(np.maximum([p for p, _ in occ_te], 1e-4))
        if abs(n) > 1e-3:
            est = np.clip(10 ** ((A - Rt) / (10 * n)), position.D_MIN, position.D_MAX)
            m = dist_metrics(np.array([d for _, d in occ_te]), est)
        else:
            m = {}
        m.update({"A": round(float(A), 2), "n_exp": round(float(n), 2),
                  "note": "n must be > 0 (closer = more disturbance); a negative n is the wrong sign"})
        out["distance_refit_e7"][dir_name(sessions, tr, te)] = m
    return out


# ---- the engine on the recordings ---------------------------------------
def replay(s, cal=None, cal_at=None):
    """Results every TICK_S from the engine in replay mode; with cal_at, a calibration job of CAL_S
    started there (MIN_S lowered for it). Returns (rows, tick_ms, calibration)."""
    eng = engine_mod.Engine(mode="replay")
    if cal is not None:
        eng.calibration = eng.calibrations["replay"] = cal
        eng.cal_pending = True
    got = {}
    rows, ms, occ_ms = [], [], []
    if eng.occupancy is not None:                    # the new per-tick work, timed on its own
        inner = eng.occupancy.update

        def timed(*a, **k):
            t0 = time.perf_counter()
            r = inner(*a, **k)
            occ_ms.append((time.perf_counter() - t0) * 1e3)
            return r
        eng.occupancy.update = timed
    nxt = None
    for host_us, pkt in iter_csirec(s["path"]):
        eng.feed(pkt, host_us, source="replay")
        now = host_us / 1e6
        if cal_at is not None and now < cal_at - 15.0:
            continue                                 # only the calibration is wanted from this pass
        if nxt is None:
            nxt = now + TICK_S
        while now >= nxt:
            if cal_at is not None and "job" not in got and nxt >= cal_at:
                got["job"] = True
                eng.start_calibration(nxt, "empty", CAL_S, lambda ok, data, err: got.update(ok=ok, err=err))
            t0 = time.perf_counter()
            r = eng.tick(nxt)
            ms.append((time.perf_counter() - t0) * 1e3)
            if cal_at is not None:
                if "ok" in got:
                    return None, None, eng.calibrations["replay"] if got["ok"] else got["err"], None
            else:
                rows.append((nxt, r))
            nxt += TICK_S
    return rows, ms, None, occ_ms


def score_replay(s, rows, fresh):
    occ_w = None
    out = {}
    for sp in s["spots"]:
        a = sp["t0"] + TRIM_S
        if fresh and sp["name"] == "empty":
            a = sp["t0"] + CAL_S                     # the calibration's own 30 s are not scored
        sel = [r for t, r in rows if a <= t <= sp["t1"] and not r["health"]["warmup"]]
        occ_w = occ_w or 4.0

        def count(f):
            c = {}
            for r in sel:
                k = f(r)
                c[k] = c.get(k, 0) + 1
            return c

        sel_o = [r for t, r in rows if a + occ_w <= t <= sp["t1"] and not r["health"]["warmup"]]
        oc = {}
        for r in sel_o:
            k = (r.get("occupancy") or {}).get("state", "null")
            oc[k] = oc.get(k, 0) + 1
        dec = sum(v for k, v in oc.items() if k != "null")
        good = oc.get("empty", 0) + oc.get("unsure", 0) if sp["name"] == "empty" else oc.get("occupied", 0) + oc.get("unsure", 0)
        sel_p = [r for t, r in rows if a + position.WIN_S <= t <= sp["t1"]]
        ds = [r["position"]["d_m"] for r in sel_p if r["position"] and r["position"]["d_m"] is not None]
        true_zone = position.zone_of(sp["d_m"])
        zs = [r["position"]["zone"] for r in sel_p if r["position"] and r["position"]["zone"] is not None]
        out[sp["name"]] = {
            "ticks": len(sel),
            "presence": count(lambda r: r["presence"]["state"]),
            "occupancy": oc,
            "occupancy_coverage": round(dec / len(sel_o), 3) if sel_o else None,
            "occupancy_ok_share": round(good / dec, 3) if dec else None,
            "occupancy_unsure_share": round(oc.get("unsure", 0) / dec, 3) if dec else None,
            "position_quality": count(lambda r: (r["position"] or {}).get("quality", "null" if r["position"] is None else "absent")),
            "zone": count(lambda r: (r["position"] or {}).get("zone") or "none"),
            "zone_acc_when_estimated": round(float(np.mean([z == true_zone for z in zs])), 3) if zs and true_zone else None,
            "d_median": round(float(np.median(ds)), 2) if ds else None,
        }
    return out


def eval_engine(sessions):
    out = {}
    real_min = calibration_mod.MIN_S
    for s in sessions:
        e = empty_spot(s)
        # harness only: the protocol's 30 s reference (F lags the packets, and S1 has gaps)
        calibration_mod.MIN_S = CAL_S - 10.0
        try:
            _, _, cal, _ = replay(s, cal_at=e["t0"])
        finally:
            calibration_mod.MIN_S = real_min
        res = {}
        for tag, c in (("nocal", None), ("fresh", cal)):
            if tag == "fresh" and (c is None or isinstance(c, str)):
                res[tag] = {"error": f"calibration refused by the engine: {c}"}
                continue
            rows, ms, _, occ_ms = replay(s, cal=c)
            sp = score_replay(s, rows, tag != "nocal")
            dec = {k: sum(v for st, v in m["occupancy"].items() if st != "null") for k, m in sp.items()}
            unsure = sum(m["occupancy"].get("unsure", 0) for m in sp.values())
            ok = {k: m["occupancy_ok_share"] is not None and m["occupancy_ok_share"] >= 0.8 for k, m in sp.items()}
            res[tag] = {"spots": sp, "tick_ms_mean": round(float(np.mean(ms)), 2), "tick_ms_max": round(float(np.max(ms)), 2),
                        "occupancy_ms_mean": round(float(np.mean(occ_ms)), 3) if occ_ms else None,
                        "occupancy_ms_max": round(float(np.max(occ_ms)), 3) if occ_ms else None,
                        "ticks": len(rows),
                        "criterion_7_2": {"ok_share_ge_0.8": ok, "unsure_share_all": round(unsure / max(sum(dec.values()), 1), 3),
                                          "pass": all(ok.values()) and unsure <= 0.5 * sum(dec.values())},
                        "quality_never_medium": all("medium" not in m["position_quality"] for m in sp.values())}
        out[s["short"]] = res
    return out


# ---- synthetic checks (lifefi.synth; no data/ needed) -------------------
def drive(occ, ts_us, csi, presence_of=lambda now: None, t_step=TICK_S):
    """(now, result) of an Occupancy fed with synthetic packets, one update per tick."""
    t = ts_us / 1e6
    amp = np.abs(csi)
    out = []
    for now in np.arange(t[0] + t_step, t[-1], t_step):
        k = int(np.searchsorted(t, now, side="right"))
        a = int(np.searchsorted(t, now - occ.window_s - 1.0))
        out.append((now, occ.update(now, t[a:k], amp[a:k], presence_of(now))))
    return out


def synthetic_checks(cfg):
    """The four checks of plan A §2.8, with the AGC on and off. Thresholds are the real-data ones."""
    res = {}
    w = float(cfg["window_s"])
    lag = w + cfg["hold_ticks"] * TICK_S
    for agc in (True, False):
        tag = f"agc_{'on' if agc else 'off'}"
        # (i) an empty room: never occupied after warm-up
        rows = drive(Occupancy(cfg), *synth(60, seed=21, agc=agc))
        st = [r["state"] for now, r in rows if r is not None and now >= w + 1]
        n_occ = st.count("occupied")
        res[f"empty_{tag}"] = {"pass": n_occ == 0, "detail": f"occupied on {n_occ}/{len(st)} ticks",
                               "p_median": float(np.median([r["p"] for _, r in rows if r]))}
        # (ii) someone moving 20..40 s: occupied during the motion
        rows = drive(Occupancy(cfg), *synth(60, seed=22, agc=agc, moving=[(20.0, 40.0)]))
        st = [r["state"] if r else None for now, r in rows if 20.0 + lag <= now <= 40.0]
        share = st.count("occupied") / max(len(st), 1)
        res[f"moving_{tag}"] = {"pass": share >= 0.9, "detail": f"occupied on {share:.0%} of the motion ticks"}
        # (iii) a still person breathing, presence `present`: never empty
        ts, csi = synth(60, seed=23, agc=agc, bpm=15)
        rows = drive(Occupancy(cfg), ts, csi, lambda now: "present")
        n_empty = sum(1 for _, r in rows if r and r["state"] == "empty")
        free = drive(Occupancy(cfg), ts, csi)            # the same signal without the presence guard
        st = [r["state"] for now, r in free if r is not None and now >= w + 1]
        res[f"still_breathing_{tag}"] = {"pass": n_empty == 0, "detail": f"empty on {n_empty} ticks with presence present; "
                                         f"without the guard: {st.count('empty')} empty, {st.count('unsure')} unsure, "
                                         f"{st.count('occupied')} occupied of {len(st)}",
                                         "p_median": float(np.median([r["p"] for _, r in free if r]))}
        # (iv) the static multipath steps by up to ±4 dB at 30 s: a short blip at most
        rows = drive(Occupancy(cfg), *synth(60, seed=24, agc=agc, step_db=(30.0, 4.0)))
        occ_t = [now for now, r in rows if r and r["state"] == "occupied" and now >= 30.0]
        span = (max(occ_t) - 30.0) if occ_t else 0.0
        late = [r["state"] for now, r in rows if r and now >= 30.0 + lag + 1.0]
        ok = span <= lag + 1e-9 and "occupied" not in late
        res[f"static_step_{tag}"] = {"pass": ok, "detail": f"occupied until {span:.1f} s after the step (bound {lag:.1f} s)"}
    return res


# ---- main ---------------------------------------------------------------
def rules_occupancy():
    r = yaml.safe_load(engine_mod.RULES.read_text(encoding="utf-8"))
    return r.get("occupancy")


def print_table(res):
    print("\nLeave-one-session-out (train->test). Interval: 95 % Wilson on the non-overlapping windows.")
    for name, dirs in res["variants"].items():
        for dn, m in dirs.items():
            if name.startswith("occupancy"):
                lg = m["logistic"]
                print(f"  {name:22s} {dn}  bal {m['bal_acc']:.2f} {m['bal_acc_ci95']} (chance 0.50)  "
                      f"recall {m['recall']}  n_ind {m['n_independent']}  | logistic p>=.5 {lg['bal_acc_p50']}, "
                      f"unsure {lg['unsure_share']}, decided {lg['decided_bal_acc']}")
            elif name.startswith("spot"):
                print(f"  {name:22s} {dn}  4-class {m['spot_bal_acc']:.2f} {m['spot_bal_acc_ci95']} (chance 0.25)  "
                      f"where3 {m['where3_bal_acc']:.2f} {m['where3_bal_acc_ci95']} (chance 0.33)  recall {m['recall']}")
            else:
                print(f"  {name:22s} {dn}  MAE {m.get('distance_mae_m')} m  zone {m.get('zone_acc')}  "
                      f"spearman(true d, est d) {m.get('distance_spearman')}  A {m.get('A')} n {m.get('n_exp')}")
    for sess, r in res.get("engine_replay", {}).items():
        for tag, v in r.items():
            if "spots" not in v:
                print(f"  engine {sess} {tag}: {v}")
                continue
            print(f"  engine {sess} {tag}: tick {v['tick_ms_mean']} ms mean, {v['tick_ms_max']} ms max; occupancy "
                  f"{v['occupancy_ms_mean']} ms mean, {v['occupancy_ms_max']} ms max; 7.2 {v['criterion_7_2']}")
            for sp, m in v["spots"].items():
                print(f"    {sp:7s} occupancy {m['occupancy']} ok {m['occupancy_ok_share']} unsure {m['occupancy_unsure_share']} "
                      f"| presence {m['presence']} | quality {m['position_quality']} | zone {m['zone']} d {m['d_median']}")
    for k, v in res.get("synthetic", {}).items():
        print(f"  synthetic {k:24s} {'pass' if v['pass'] else 'FAIL'}  {v['detail']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", action="store_true", help="the synthetic checks only")
    ap.add_argument("--fit-occupancy", action="store_true", help="print the rules.yaml occupancy block")
    ap.add_argument("--no-engine", action="store_true", help="skip the engine replay (faster)")
    args = ap.parse_args()
    t_start = time.time()
    cfg = rules_occupancy()
    dirs = [] if args.synthetic else find_sessions()
    if not dirs:
        if not args.synthetic:
            print(f"no labelled spot sessions in {SESSIONS}: synthetic checks only")
        if cfg is None:
            print("rules.yaml has no occupancy block yet: nothing to check")
            return 0
        res = {"synthetic": synthetic_checks(cfg)}
        print_table({"variants": {}, **res})
        return 0
    sessions = [load_session(d) for d in dirs]
    print("sessions: " + ", ".join(f"{s['name']} ({len(s['t'])} packets, {len(s['t']) / (s['t'][-1] - s['t'][0]):.1f} Hz)"
                                   for s in sessions))
    if args.fit_occupancy:
        off, sc = fit_occupancy(sessions)
        print(f"\noccupancy:                  # lifefi.occupancy; ml/eval_position.py --fit-occupancy "
              f"({' + '.join(s['short'] for s in sessions)}, {HEADLINE_W:.0f} s, pooled)")
        print(f"  window_s: {HEADLINE_W}\n  offset: {off:.2f}\n  scale: {sc:.2f}\n  p_on: 0.8\n  p_off: 0.2\n  hold_ticks: 3")
        return 0
    occ_cfg = cfg or {"p_on": 0.8, "p_off": 0.2}
    variants, within = eval_occupancy(sessions, occ_cfg)
    variants.update(eval_spots(sessions))
    variants.update(eval_distance(sessions))
    res = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "sessions": [s["name"] for s in sessions],
           "protocol": "loso", "window_s_headline": HEADLINE_W,
           "notes": ["bal_acc_ci95 = mean of the per-class 95 % Wilson bounds on n_independent (non-overlapping windows)",
                     "occupancy bal_acc uses the threshold fitted on the training session; logistic.* is the shipped "
                     "form (p >= 0.5, and the p_on/p_off band)",
                     "fresh = first 30 s of the test session's empty minute as reference (recorded last: a "
                     "calibration-after); those windows are not scored",
                     "only two sessions, both with the phone hotspot as a moving transmitter"],
           "variants": variants, "within_session": within}
    if not args.no_engine:
        res["engine_replay"] = eval_engine(sessions)
    if cfg is not None:
        res["synthetic"] = synthetic_checks(cfg)
    res["runtime_s"] = round(time.time() - t_start, 1)
    print_table(res)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT} in {res['runtime_s']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
