# Downloads only the ESP32 samples of CSI-Bench FallDetection (494 files, 16 MB)
# into raw/E9_CSI-Bench, one file at a time to stay under Kaggle's rate limit.
# Needs `pip install kaggle pandas` and a Kaggle token in ~/.kaggle/.
import os, time, zipfile, pandas as pd
from kaggle.api.kaggle_api_extended import KaggleApi
api = KaggleApi(); api.authenticate()
os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw", "E9_CSI-Bench"), exist_ok=True)
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw", "E9_CSI-Bench"))
meta = "FallDetection/metadata/sample_metadata.csv"
if not os.path.exists(meta):
    api.dataset_download_file("guozhenjennzhu/csi-bench", meta, path=os.path.dirname(meta), quiet=True)
    if os.path.exists(meta + ".zip"):
        zipfile.ZipFile(meta + ".zip").extractall(os.path.dirname(meta)); os.remove(meta + ".zip")
d = pd.read_csv(meta)
paths = ["FallDetection/" + p[2:] for p in d[d.device == "ESP32"].file_path]
ok = 0
for i, p in enumerate(paths):
    if os.path.exists(p): ok += 1; continue
    folder = os.path.dirname(p)
    for attempt in range(6):
        try:
            api.dataset_download_file("guozhenjennzhu/csi-bench", p, path=folder, quiet=True)
            z = p + ".zip" if os.path.exists(p + ".zip") else os.path.join(folder, os.path.basename(p) + ".zip")
            if os.path.exists(z):
                zipfile.ZipFile(z).extractall(folder); os.remove(z)
            ok += 1; break
        except Exception as e:
            time.sleep(15 * (attempt + 1))
    time.sleep(1)
    if i % 50 == 0: print(i, ok, flush=True)
print("done", ok, "of", len(paths))
