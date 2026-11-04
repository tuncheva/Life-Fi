"""Does the venue routine help? Simulated on E8's rooms (model-training-plan §6).

    .venv/Scripts/python ml/venue_sim.py

For each E8 room: train CsiNet on everything else (E1 + the other three
rooms, no locked subjects), then treat the held-out room as the venue:
- its trials 1-5 are the "setup" recordings, trials 6-10 the demo;
- AdaBN on all setup windows, labels ignored (the 4 min free movement;
  here more than 4 min, so this is an upper bound for that step);
- head fine-tune on GUIDED_MIN minutes of labelled setup clips (the
  guided reps);
- score the demo half before, after AdaBN, and after AdaBN + head.
The gradient-boosting model has no BatchNorm; its venue step is to retrain
with the guided clips added (weight GBM_GUIDED_WEIGHT).
Writes ml/results/venue_sim.json.
"""

import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import adapt  # noqa: E402
import data  # noqa: E402
import evaluate  # noqa: E402
import lightgbm as lgb  # noqa: E402
import torch  # noqa: E402
import train_cnn  # noqa: E402
import train_gbm  # noqa: E402

GUIDED_MIN = 5.0
GBM_GUIDED_WEIGHT = 5.0


def trial_of(d):
    tri = {}
    with open(data.ROOT / "datasets" / "manifest" / "e8_segments.csv", encoding="utf-8") as fh:
        import csv
        for r in csv.DictReader(fh):
            tri[r["rec_id"]] = int(r["trial"])
    return np.array([tri.get(d["clips"][c]["rec_id"], 0) for c in d["clip"]])


def probs(net, X):
    with torch.no_grad():
        return torch.softmax(net(adapt.view(X)), dim=1).numpy()


def main():
    d = data.build_windows()
    Xg = torch.from_numpy(d["X"]).to(train_cnn.DEV)
    yg = torch.from_numpy(d["y"]).long().to(train_cnn.DEV)
    splits = data.load_splits()
    trial = trial_of(d)
    F, _ = train_gbm.features(d)
    rng = np.random.default_rng(0)
    out = {}
    for name, train_m, test_m in data.folds(d, splits):
        if not name.startswith("room"):
            continue
        net = train_cnn.train(Xg, yg, np.where(train_m & (d["y"] != data.IGNORE))[0]).cpu().eval()
        setup, demo = test_m & (trial <= 5), test_m & (trial > 5)
        # guided: whole labelled clips from the setup half, up to GUIDED_MIN minutes
        clips = rng.permutation(np.unique(d["clip"][setup]))
        guided, secs = [], 0.0
        for c in clips:
            if secs >= GUIDED_MIN * 60:
                break
            guided.append(c)
            secs += 10.0
        gm = setup & np.isin(d["clip"], guided)
        Xd, yd, cd = d["X"][demo], d["y"][demo], d["clip"][demo]
        r = {"before": evaluate.score(probs(net, Xd), yd, cd, d["clips"])}
        bn = adapt.adabn(net, d["X"][setup])
        r["adabn"] = evaluate.score(probs(bn, Xd), yd, cd, d["clips"])
        head = adapt.finetune_head(bn, d["X"][gm], d["y"][gm])
        r["adabn+head"] = evaluate.score(probs(head, Xd), yd, cd, d["clips"])
        tr = train_m & (d["y"] != data.IGNORE)
        g = gm & (d["y"] != data.IGNORE)
        base = lgb.train(train_gbm.PARAMS, lgb.Dataset(F[tr], d["y"][tr], weight=train_gbm.class_weights(d["y"][tr])),
                         train_gbm.ROUNDS)
        r["gbm before"] = evaluate.score(base.predict(F[demo]), yd, cd, d["clips"])
        both = tr | g
        w = train_gbm.class_weights(d["y"][both]) * np.where(g[both], GBM_GUIDED_WEIGHT, 1.0)
        more = lgb.train(train_gbm.PARAMS, lgb.Dataset(F[both], d["y"][both], weight=w), train_gbm.ROUNDS)
        r["gbm +guided"] = evaluate.score(more.predict(F[demo]), yd, cd, d["clips"])
        out[name] = r
        print(name, "  ".join(f"{k}: F1 {v['macro_f1']:.3f} false {v['false_event_share']}" for k, v in r.items()),
              flush=True)
    mean = {k: round(float(np.mean([r[k]["macro_f1"] for r in out.values()])), 3)
            for k in ("before", "adabn", "adabn+head", "gbm before", "gbm +guided")}
    print("mean macro-F1 over the 4 rooms:", mean)
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "venue_sim.json").write_text(json.dumps({"rooms": out, "mean_macro_f1": mean}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
