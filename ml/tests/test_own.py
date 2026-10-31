"""ml.own label reading on a synthetic recording (no .csirec needed).

    .venv/Scripts/python ml/tests/test_own.py
"""

import json
import pathlib
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import data  # noqa: E402
import own  # noqa: E402

T0 = 1_761_750_000.0                  # host epoch s
BURST_S = 30.0                        # a 1 s movement 30 s in


def fake_segments(_path):
    rng = np.random.default_rng(0)
    t = np.arange(0, 60, 0.011)
    amp = 30 + rng.normal(0, 0.3, (len(t), 52))
    burst = (t > BURST_S) & (t < BURST_S + 1)
    amp[burst] *= 1 + 0.5 * np.sin(np.linspace(0, 6 * np.pi, burst.sum()))[:, None]
    segs = own.dsp.to_features(t, amp)
    for s in segs:
        s.t = s.t + T0
    return segs


own.load_segments = fake_segments


def write(lines):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    f.write("\n".join(json.dumps(L) if isinstance(L, dict) else L for L in lines))
    f.close()
    return f.name


def raises(fn, text):
    try:
        fn()
    except ValueError as e:
        assert text in str(e), e
        return
    raise AssertionError(f"no ValueError containing {text!r}")


def test_both_formats_give_the_same_windows():
    t_us = int((T0 + BURST_S + 0.3) * 1e6)
    v2 = write([{"kind": "mark", "session": "s1", "t_press_us": t_us, "event": "sit_down"}])
    key = write([{"t": t_us // 1000, "label": "sit_down"}])
    _, y1, _, r1 = own.windows("x", v2)
    _, y2, _, r2 = own.windows("x", key)
    assert r1["marks"] == r2["marks"] == 1 and r1["snapped"] == 1
    assert np.array_equal(y1, y2) and (y1 == data.C["sit_down"]).any()


def test_unknown_line_stops():
    raises(lambda: own.windows("x", write([{"time": 1, "what": "sit_down"}])), "unknown label line")


def test_wrong_clock_stops():
    raises(lambda: own.windows("x", write([{"t": T0 + 30, "label": "sit_down"}])), "not host epoch milliseconds")
    late = int((T0 + 5000) * 1e6)
    raises(lambda: own.windows("x", write([{"kind": "mark", "t_press_us": late, "event": "fall"}])),
           "falls inside")


def test_span_as_point_stops():
    raises(lambda: own.windows("x", write([{"t": int(T0 * 1000), "label": "walking"}])), "not a moment")


def test_missing_file_stops():
    try:
        own.windows("x", "no/such/labels.jsonl")
    except FileNotFoundError:
        return
    raise AssertionError("missing labels file was accepted")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
