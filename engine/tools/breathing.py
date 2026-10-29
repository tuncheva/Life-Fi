"""Breathing rate from a .csirec recording.

    python engine/tools/breathing.py firmware/recordings/<file>.csirec

Record with the person sitting still on the line between the ESP32 and
the router, for at least 60 s with no Wi-Fi pauses longer than 1 s.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))

from csi_recorder import load_csirec  # noqa: E402
from lifefi.breathing import WINDOW_S, estimate_breathing, summarize  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    d = load_csirec(sys.argv[1])
    if len(d["ts_us"]) < 2:
        print("no frames in the recording")
        return 1
    windows = estimate_breathing(d["ts_us"], d["csi"])
    if not windows:
        print(f"no continuous stretch of {WINDOW_S:.0f} s (Wi-Fi pauses split the recording)")
        return 1
    print("   t      bpm   conf  ratio  acf    result")
    for w in windows:
        result = "VALID" if w.valid else w.reason
        print(f"{w.t_start:5.0f}s  {w.bpm:5.1f}  {w.confidence:4.2f}  {w.band_ratio:5.1f}  {w.acf_bpm:4.1f}   {result}")
    s = summarize(windows)
    if s["bpm"] is None:
        print(f"\nno valid breathing in {s['windows']} windows")
    elif not s["consistent"]:
        rates = sorted(w.bpm for w in windows if w.valid)
        print(f"\nno consistent rate: {s['valid']}/{s['windows']} valid windows range "
              f"{rates[0]:.1f}-{rates[-1]:.1f} /min (movement or drift between them)")
    else:
        print(f"\nbreathing {s['bpm']:.1f} /min (median of {s['valid']}/{s['windows']} valid windows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
