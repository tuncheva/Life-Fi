"""Shared reader output, QC and the processed store (dataset-preparation §4).

A reader only parses, maps subcarriers to k = -26..-1, +1..+26, fixes
timestamps and attaches labels. It never filters, normalises or
resamples: that is lifefi.dsp, the same code as for our own recordings.

Processed store, one per dataset (datasets/processed/<id>.npz):
    F       float16 [sum T, 52]  dB, 50 Hz, all segments concatenated
    valid   bool    [sum T]
    offsets int64   [n_segments + 1]   segment i is F[offsets[i]:offsets[i+1]]
    pipeline_version
plus datasets/manifest/<id>.csv: one row per source recording (QC numbers,
keep / drop reason) and datasets/manifest/<id>_segments.csv: one row per
kept segment with its recording's labels and meta.
"""

import csv
import pathlib
import sys
from dataclasses import dataclass, field

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from lifefi import dsp  # noqa: E402

PROCESSED = ROOT / "datasets" / "processed"
MANIFEST = ROOT / "datasets" / "manifest"
READER_VERSION = 1


@dataclass
class Recording:
    rec_id: str
    t_s: np.ndarray                  # [N] seconds, monotonic is not assumed
    amp: np.ndarray                  # [N, 52] linear amplitude
    sat: np.ndarray                  # [N] bool
    meta: dict = field(default_factory=dict)   # dataset, subject, room, clip_label, ...
    repaired: float = 0.0            # share of rows a reader had to repair
    dropped_rows: int = 0            # rows a reader could not use


def qc(rec, min_seconds, min_rate_hz=40.0):
    """QC numbers and (keep, reason) per dataset-preparation §4.4."""
    t, amp = rec.t_s, rec.amp
    n = len(t)
    if n < 10:
        return {"rows": n}, False, "too few rows"
    dt = np.diff(t)
    med_amp = np.median(amp, axis=0)
    L = dsp.to_db(amp)
    step = np.median(np.abs(np.diff(L, axis=0)), axis=1)
    out = {
        "rows": n,
        "seconds": round(float(t.max() - t.min()), 2),
        "rate_hz": round(float((n - 1) / max(t.max() - t.min(), 1e-9)), 1),
        "gaps_50ms": int((dt > 0.05).sum()),
        "gaps_1s": int((dt > 1.0).sum()),
        "backward": int((dt < 0).sum()),
        "sat_share": round(float(rec.sat.mean()), 4),
        "dead_sc": int(((med_amp < 1) | (amp.std(axis=0) < 1e-6)).sum()),
        "dup_share": round(float((np.abs(np.diff(amp, axis=0)).sum(axis=1) == 0).mean()), 4),
        "step_share": round(float((step > 3.0).mean()), 4),
        "repaired": round(rec.repaired, 4),
        "dropped_rows": rec.dropped_rows,
    }
    if out["seconds"] < min_seconds:
        return out, False, f"shorter than {min_seconds} s"
    if out["rate_hz"] < min_rate_hz:
        return out, False, f"rate below {min_rate_hz} Hz"
    if out["dead_sc"] > 2:
        return out, False, "more than 2 dead subcarriers"
    if out["dup_share"] > 0.01:
        return out, False, "more than 1 % duplicate rows"
    return out, True, ""


def build(dataset_id, paths, read, min_seconds, workers=8):
    """Read every path with read(path) -> Recording | (rec_id, meta, reason),
    run QC + lifefi.dsp, and write the processed store and manifests."""
    from concurrent.futures import ProcessPoolExecutor
    from functools import partial

    PROCESSED.mkdir(parents=True, exist_ok=True)
    MANIFEST.mkdir(parents=True, exist_ok=True)
    rows, seg_rows, Fs, Vs = [], [], [], []
    offsets = [0]
    with ProcessPoolExecutor(workers) as pool:
        for rec_id, meta, numbers, keep, reason, segs in pool.map(partial(_one, read=read, min_seconds=min_seconds),
                                                                   paths, chunksize=8):
            if keep and not segs:
                keep, reason = False, "no continuous segment >= 3 s"
            rows.append({"rec_id": rec_id, **meta, **numbers, "keep": int(keep), "reason": reason,
                         "segments": len(segs) if keep else 0})
            if not keep:
                continue
            for i, s in enumerate(segs):
                seg_rows.append({"seg": len(offsets) - 1, "rec_id": rec_id, "part": i,
                                 "t0": round(float(s.t[0]), 3), "samples": len(s.t),
                                 "sat_share": numbers["sat_share"], **meta})
                Fs.append(s.F.astype(np.float16))
                Vs.append(s.valid)
                offsets.append(offsets[-1] + len(s.t))
    np.savez(PROCESSED / f"{dataset_id}.npz", F=np.concatenate(Fs), valid=np.concatenate(Vs),
             offsets=np.array(offsets, dtype=np.int64), pipeline_version=dsp.PIPELINE_VERSION,
             reader_version=READER_VERSION)
    _write_csv(MANIFEST / f"{dataset_id}.csv", rows)
    _write_csv(MANIFEST / f"{dataset_id}_segments.csv", seg_rows)
    return rows


def _one(path, read, min_seconds):
    rec = read(path)
    if not isinstance(rec, Recording):           # the reader refused the file itself
        rec_id, meta, reason = rec
        return rec_id, meta, {}, False, reason, []
    numbers, keep, reason = qc(rec, min_seconds)
    segs = dsp.to_features(rec.t_s - rec.t_s.min(), rec.amp) if keep else []
    return rec.rec_id, rec.meta, numbers, keep, reason, segs


def _write_csv(path, rows):
    cols = []
    for r in rows:
        cols += [c for c in r if c not in cols]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def load(dataset_id):
    """(F float32 list per segment, valid list, segment manifest rows)."""
    z = np.load(PROCESSED / f"{dataset_id}.npz")
    off, F_all, V_all = z["offsets"], z["F"].astype(np.float32), z["valid"]   # each z[...] reads the file again
    F = [F_all[a:b] for a, b in zip(off[:-1], off[1:])]
    V = [V_all[a:b] for a, b in zip(off[:-1], off[1:])]
    with open(MANIFEST / f"{dataset_id}_segments.csv", newline="", encoding="utf-8") as fh:
        meta = list(csv.DictReader(fh))
    assert len(meta) == len(F)
    return F, V, meta
