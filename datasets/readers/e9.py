"""E9 CSI-Bench, FallDetection, ESP32 part only (494 samples).

`metadata/sample_metadata.csv` lists every sample; only device ESP32 is
downloaded (277 Fall / 217 Nonfall, users U08-U22, one room E22). Each
`.h5` holds `CSI_amps` float32 (64, 500, 1): linear amplitude, centred
64-bin layout with the DC at j = 32, so k = -26..-1 is j 6..31 and
k = +1..+26 is j 33..58 (checked 2026-10-30 on the mean profile).

The files carry no time. CSI-Bench (arXiv 2505.21866, §3.2 and §4.2)
sounds at 100 Hz for general tasks and cuts fall detection into 5 s
samples, so 500 rows = 5 s at 100 Hz. Settles dataset-preparation §6.4.

CC BY-NC-ND 4.0: **evaluation only** (never sets a threshold or trains a
model), and no converted copy leaves this machine (datasets/processed/
is gitignored). Needs h5py.
"""

import csv
import pathlib

import numpy as np

from common import Recording

RAW = pathlib.Path(__file__).resolve().parents[1] / "raw" / "E9_CSI-Bench" / "FallDetection"
J = list(range(6, 32)) + list(range(33, 59))
RATE_HZ = 100.0
MIN_SECONDS = 4.5


def files():
    with open(RAW / "metadata" / "sample_metadata.csv", newline="", encoding="utf-8") as fh:
        return sorted(RAW / r["file_path"] for r in csv.DictReader(fh) if r["device"] == "ESP32")


def read(path):
    import h5py

    path = pathlib.Path(path)
    user, act = path.parts[-5], path.parts[-4]                  # user_U08 / act_Fall / env_E22 / device_ESP32 / f.h5
    label = {"act_Fall": "fall", "act_Nonfall": "nonfall"}[act]
    meta = {"dataset": "e9", "room": "e9_e22", "subject": f"e9_{user.split('_')[1]}", "clip_label": label,
            "ltf": "lltf", "bw": "ht20", "source": str(path.relative_to(RAW)), "eval_only": 1}
    rec_id = f"e9/{user}/{act}/{path.stem}"
    with h5py.File(path, "r") as h:
        a = h["CSI_amps"][:, :, 0]                               # (64, 500)
    amp = a[J].T.astype(np.float32)                              # (500, 52)
    t = np.arange(len(amp)) / RATE_HZ
    return Recording(rec_id, t, amp, np.zeros(len(amp), bool), meta)
