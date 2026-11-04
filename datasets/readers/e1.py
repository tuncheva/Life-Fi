"""E1 Embedded_WiFi_Sensing: Datasets/Activity/<FA|GU|LD|SD|WA>/s<N>/*.txt.

Row = host epoch ms, then 128 ints: 64 LLTF pairs [imag, real] in ESP
order (j 0..31 = k 0..31, j 32..63 = k -32..-1).

Two repairs, both seen in the files (2026-10-29):

- CR LF: the logger wrote a 13 before every value 10 (0x0A became
  0x0D 0x0A). 62 % of rows have at least one, and no 10 anywhere is
  without its 13, so removing every 13 directly before a 10 is exact. The
  row was then cut to 128 values, so the last pairs (k = -1, -2, ...) are
  lost: they are copied from the nearest intact negative subcarrier. Rows
  missing more than MAX_LOST_PAIRS pairs are dropped.
- first_word_invalid: j = 0 is (83, -80) and j = 1 (our k = +1) the
  constant (4, 0); k = +1 is replaced by k = +2.
"""

import pathlib

import numpy as np

from common import Recording

RAW = pathlib.Path(__file__).resolve().parents[1] / "raw" / "E1_Embedded_WiFi_Sensing" / "Datasets" / "Activity"
BREATHING = RAW.parent / "Breathing(experimental)" / "Breathing_Rate_Monitoring_Dataset"   # <10|15|20>BPM/s<N>/*.txt
PAIRS = list(range(38, 64)) + list(range(1, 27))      # k = -26..-1, +1..+26
MAX_LOST_PAIRS = 4
MIN_ROWS = 900
MIN_SECONDS = 19.5


def files():
    return sorted(RAW.glob("*/s*/*.txt"))


def _fix_row(vals):
    fixed = [v for i, v in enumerate(vals) if not (v == 13 and i + 1 < len(vals) and vals[i + 1] == 10)]
    removed = len(vals) - len(fixed)
    lost = 64 - len(fixed) // 2
    pairs = np.zeros((64, 2), dtype=np.int16)
    pairs[: 64 - lost] = np.array(fixed[: 2 * (64 - lost)]).reshape(-1, 2)
    if lost:
        pairs[64 - lost:] = pairs[63 - lost]           # nearest intact k on the negative side
    return pairs, lost, removed


def breathing_files():
    return sorted(BREATHING.glob("*BPM/s*/*.txt"))


def read(path, root=RAW):
    path = pathlib.Path(path)
    label, subject = path.parent.parent.name, path.parent.name
    meta = {"dataset": "e1", "room": "e1", "subject": f"e1_{subject}", "clip_label": label,
            "ltf": "lltf", "bw": "ht20", "source": str(path.relative_to(root))}
    rec_id = f"e1/{label}/{subject}/{path.stem}"
    t, rows, sat = [], [], []
    repaired = dropped = 0
    with open(path) as fh:
        for line in fh:
            parts = line.strip().split(",")
            if len(parts) != 129:
                dropped += 1
                continue
            vals = [int(x) for x in parts[1:]]
            pairs, lost, removed = _fix_row(vals)
            if lost > MAX_LOST_PAIRS:
                dropped += 1
                continue
            repaired += removed > 0
            sel = pairs[PAIRS]
            im, re = sel[:, 0].astype(np.float32), sel[:, 1].astype(np.float32)
            amp = np.hypot(re, im)
            amp[26] = amp[27]                                  # first_word_invalid
            rows.append(amp)
            sat.append(((np.abs(re) >= 127) | (np.abs(im) >= 127)).sum() > 2)
            t.append(int(parts[0]) / 1000.0)
    if len(rows) + dropped < MIN_ROWS:
        return rec_id, meta, f"fewer than {MIN_ROWS} rows"
    return Recording(rec_id, np.array(t), np.array(rows), np.array(sat), meta,
                     repaired=repaired / len(rows), dropped_rows=dropped)
