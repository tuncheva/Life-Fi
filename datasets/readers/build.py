"""Convert public datasets into the processed store (datasets/processed/<id>.npz).

    python datasets/readers/build.py e1 e8          # movement model
    python datasets/readers/build.py e15 e9         # fall rule (e9: evaluation only, needs h5py)

Prints a QC summary per dataset; every dropped recording is listed with
its reason in datasets/manifest/<id>.csv.
"""

import collections
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import common  # noqa: E402
import e1  # noqa: E402
import e8  # noqa: E402
import e9  # noqa: E402
import e15  # noqa: E402

READERS = {"e1": e1, "e8": e8, "e9": e9, "e15": e15}


def main():
    ids = sys.argv[1:] or list(READERS)
    for dataset_id in ids:
        mod = READERS[dataset_id]
        paths = mod.files()
        print(f"{dataset_id}: {len(paths)} files")
        rows = common.build(dataset_id, paths, mod.read, mod.MIN_SECONDS)
        kept = [r for r in rows if r["keep"]]
        reasons = collections.Counter(r["reason"] for r in rows if not r["keep"])
        print(f"  kept {len(kept)} / {len(rows)}; dropped: {dict(reasons) or 'none'}")
        if kept:
            def med(key):
                vals = sorted(float(r[key]) for r in kept)
                return vals[len(vals) // 2]
            print(f"  median rate {med('rate_hz')} Hz, length {med('seconds')} s, repaired rows {med('repaired')}, "
                  f"saturated frames {med('sat_share')}, files with >1 % saturation "
                  f"{sum(float(r['sat_share']) > 0.01 for r in kept)}")
            per_label = collections.Counter(r["clip_label"] for r in kept)
            print(f"  clips per label: {dict(sorted(per_label.items()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
