"""Heart rate from a .csirec recording. EXPERIMENTAL.

    python engine/tools/heart.py firmware/recordings/<file>.csirec

Same recording as for breathing (still, on the link, no pauses), ideally
with the chest 30-50 cm from the board and a pulse reading from a watch or
finger clip taken during it. Prints "no heart signal" rather than a guess.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))

from csi_recorder import load_csirec  # noqa: E402
from lifefi.heart import WINDOW_S, estimate_heart, summarize  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    d = load_csirec(sys.argv[1])
    if len(d["ts_us"]) < 2:
        print("no frames in the recording")
        return 1
    windows = estimate_heart(d["ts_us"], d["csi"])
    if not windows:
        print(f"no continuous stretch of {WINDOW_S:.0f} s (Wi-Fi pauses split the recording)")
        return 1
    print("   t      bpm    snr  conf    acf  breath   result")
    for w in windows:
        result = "VALID" if w.valid else w.reason
        print(f"{w.t_start:5.0f}s  {w.bpm:5.1f}  {w.snr:5.1f}  {w.confidence:4.2f}  {w.acf_bpm:5.1f}  {w.breath_bpm:5.1f}   {result}")
    s = summarize(windows)
    if s["bpm"] is None and s["valid"]:
        print(f"\nno heart signal: too few valid windows ({s['valid']}/{s['windows']})")
    elif s["bpm"] is None:
        print(f"\nno heart signal in {s['windows']} windows (experimental; see engine/README.md)")
    elif not s["consistent"]:
        rates = sorted(w.bpm for w in windows if w.valid)
        print(f"\nno consistent rate: {s['valid']}/{s['windows']} valid windows range "
              f"{rates[0]:.1f}-{rates[-1]:.1f} /min")
    else:
        print(f"\nheart {s['bpm']:.1f} /min (median of {s['valid']}/{s['windows']} valid windows; "
              "experimental, check against a pulse sensor)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
