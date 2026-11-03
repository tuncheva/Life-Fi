"""ml.train_spots command line on synthetic sessions (no .csirec needed).

    .venv/Scripts/python ml/tests/test_train_spots.py
"""

import contextlib
import io
import json
import pathlib
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import train_spots  # noqa: E402

T0_US = 1_761_750_000_000_000           # host epoch µs
RATE = 60.0                             # packets/s
MODE = {"separable": True}
# one gain-free pattern per spot, the same in every session (what a fixed transmitter gives)
PATTERN = {n: np.random.default_rng(i).normal(0, 3, 52) for i, n in enumerate(["empty", "close", "middle", "far"])}


def fake_csirec(path):
    """A recording that follows the session's spots.json: each spot has its own pattern and RSSI (or none)."""
    d = pathlib.Path(path).parent
    spec = json.loads((d / "spots.json").read_text(encoding="utf-8"))
    rng = np.random.default_rng(int(d.name[-6:]))
    t_end = max(s["t1_us"] for s in spec["spots"]) + 5_000_000
    host_us = np.arange(T0_US, t_end, 1e6 / RATE).astype(np.int64)
    db = np.full((len(host_us), 52), 30.0)
    rssi = np.full(len(host_us), -50.0)
    for s in spec["spots"]:
        m = (host_us >= s["t0_us"]) & (host_us < s["t1_us"])
        if MODE["separable"]:
            db[m] += PATTERN[s["name"]]
            rssi[m] += {"empty": 0, "close": -3, "middle": -6, "far": -9}[s["name"]]
    db += rng.normal(0, 1.0, db.shape)
    rssi += rng.normal(0, 1.0, rssi.shape)
    return {"host_us": host_us, "csi": (10 ** (db / 20) - 1).astype(np.complex64), "rssi": rssi}


train_spots.load_csirec = fake_csirec


def session(root, i, names=("close", "middle", "far"), csirec=True, spots=True):
    sid = f"spots-20261103-0{i}0000"
    d = pathlib.Path(root) / sid
    d.mkdir()
    if csirec:
        (d / f"{sid}.csirec").write_bytes(b"")
    t = T0_US + 5_000_000
    out = []
    for n in ["empty", *names, "empty"]:
        out.append({"name": n, "d_m": 0.0 if n == "empty" else 1.0, "t0_us": t, "t1_us": t + 20_000_000})
        t += 25_000_000                 # 5 s walk between
    if spots:
        (d / "spots.json").write_text(json.dumps({"session": sid, "spots": out}), encoding="utf-8")
    return str(d)


def run(*argv):
    buf, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
        code = train_spots.main(list(argv))
    return code, buf.getvalue(), err.getvalue()


def metrics(stdout):
    lines = [L for L in stdout.splitlines() if L.startswith("METRICS ")]
    assert len(lines) == 1, stdout
    return json.loads(lines[0][len("METRICS "):])


def test_separable_spots_score_high():
    MODE["separable"] = True
    with tempfile.TemporaryDirectory() as tmp:
        dirs = [session(tmp, i) for i in range(3)]
        out = pathlib.Path(tmp) / "model.json"
        code, so, _ = run("--out", str(out), "--json", *dirs)
        assert code == 0, so
        m = metrics(so)
        assert m["loso_bal_acc"] > 0.9, m
        assert len(m["loso_by_session"]) == 3 and m["labels"] == ["empty", "close", "middle", "far"]
        assert m["chance"] == 0.25 and len(m["confusion"]) == 4
        model = json.loads(out.read_text(encoding="utf-8"))
        assert model["loso_bal_acc"] == m["loso_bal_acc"] and len(model["W"]) == 4


def test_noise_scores_low():
    MODE["separable"] = False
    try:
        with tempfile.TemporaryDirectory() as tmp:
            dirs = [session(tmp, i) for i in range(3)]
            code, so, _ = run("--out", str(pathlib.Path(tmp) / "m.json"), "--json", *dirs)
            assert code == 0 and metrics(so)["loso_bal_acc"] < 0.5, so
    finally:
        MODE["separable"] = True


def test_out_writes_only_there():
    with tempfile.TemporaryDirectory() as tmp:
        dirs = [session(tmp, i) for i in range(2)]
        live = train_spots.OUT
        before = live.stat().st_mtime_ns if live.exists() else None
        out = pathlib.Path(tmp) / "sub" / "cand.json"
        assert run("--out", str(out), *dirs)[0] == 0
        assert out.is_file()
        assert (live.stat().st_mtime_ns if live.exists() else None) == before


def test_one_session_has_no_loso():
    with tempfile.TemporaryDirectory() as tmp:
        code, so, _ = run("--out", str(pathlib.Path(tmp) / "m.json"), "--json", session(tmp, 0))
        m = metrics(so)
        assert code == 0 and m["loso_bal_acc"] is None and m["loso_by_session"] is None


def test_unusable_dirs_are_skipped():
    with tempfile.TemporaryDirectory() as tmp:
        dirs = [session(tmp, 0), session(tmp, 1), session(tmp, 2, spots=False), session(tmp, 3, csirec=False)]
        code, so, _ = run("--out", str(pathlib.Path(tmp) / "m.json"), "--json", *dirs)
        assert code == 0 and "no spots.json" in so and "no .csirec" in so
        assert len(metrics(so)["sessions"]) == 2
        assert run("--out", str(pathlib.Path(tmp) / "m.json"), dirs[2])[0] == 2


def test_differing_labels_stop():
    with tempfile.TemporaryDirectory() as tmp:
        dirs = [session(tmp, 0), session(tmp, 1, names=("close", "far"))]
        out = pathlib.Path(tmp) / "m.json"
        code, _, err = run("--out", str(out), *dirs)
        assert code == 2 and "labels differ between sessions" in err and not out.exists()


def test_teach_spots_json_shape_loads():
    """The shape ui/src/server/teach.ts writes (extra keys, empty twice) loads unchanged."""
    with tempfile.TemporaryDirectory() as tmp:
        d = pathlib.Path(session(tmp, 0))
        spec = json.loads((d / "spots.json").read_text(encoding="utf-8"))
        spec.update(frames=12345, protocol="teach-v1", transmitter="fixed")
        (d / "spots.json").write_text(json.dumps(spec), encoding="utf-8")
        X, y, *_rest, labels, dist, sessions = train_spots.load([d])
        assert labels == ["empty", "close", "middle", "far"] and dist["empty"] is None and len(X) > 100


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
    print("all passed")
