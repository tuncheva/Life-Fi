"""Run the Life-Fi engine: board (or a recording) in, results to the server on TCP 6000.

    .venv/Scripts/python engine/run.py --serial COM3              # the board over USB
    .venv/Scripts/python engine/run.py --esp 192.168.100.111      # the board over Wi-Fi (UDP)
    .venv/Scripts/python engine/run.py --replay f.csirec [--loop]  # a recording, in real time

Then start the server and the dashboard as usual (npm run dev:server,
npm run dev:ui), without the mock engine: both listen on the same port.
Do the 2-minute empty-room calibration from the dashboard first; until
then presence counts motion only. Thresholds: engine/config/rules.yaml;
models: ml/models/ (rebuild with ml/train_gbm.py --final if missing; the
rules run without them).
"""

import argparse
import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lifefi import engine as engine_mod  # noqa: E402
from lifefi.control import Server  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--serial", help="the board over USB, e.g. COM3 (close serial monitors first)")
    src.add_argument("--esp", help="the board's IP for UDP streaming (default: broadcast)")
    src.add_argument("--replay", help="a .csirec to replay instead of the board")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed (breathing reads this x faster)")
    ap.add_argument("--loop", action="store_true", help="replay: start again at the end")
    ap.add_argument("--port", type=int, default=6000)
    ap.add_argument("--rules", default=str(engine_mod.RULES))
    ap.add_argument("--models", default=str(engine_mod.MODELS))
    args = ap.parse_args()

    eng = engine_mod.Engine(args.rules, args.models, mode="replay" if args.replay else "live")
    print(f"rules {args.rules} (config {eng.config_hash}); model: {eng.model_status}")
    live = {"serial": args.serial, "baud": args.baud} if args.serial else {"esp": args.esp} if args.esp else {}
    server = Server(eng, port=args.port, live_args=live)
    if args.replay:
        server.set_source("replay", args.replay, args.speed, args.loop)
    elif live:
        server.set_source("live")
    else:
        print("no --serial / --esp / --replay: waiting for set_source from the server")
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
