"""Run the Life-Fi engine: board (or a recording) in, results to the server on TCP 6000.

    .venv/Scripts/python engine/run.py                            # the board over USB, port found by itself
    .venv/Scripts/python engine/run.py --serial COM3              # the board over USB, this port
    .venv/Scripts/python engine/run.py --esp 192.168.100.111      # the board over Wi-Fi (UDP; --esp alone: broadcast)
    .venv/Scripts/python engine/run.py --replay f.csirec [--loop]  # a recording, in real time

Usually started for you, with the dashboard and its backend, by
`npm run dev` (the board over USB). Do the 2-minute empty-room calibration from the dashboard
first; until then presence counts motion only. The live calibration is
saved (--calibration) and used again at the next start. Thresholds: engine/config/rules.yaml;
models: ml/models/ (rebuild with ml/train_gbm.py --final if missing; the
rules run without them).
"""

import argparse
import asyncio
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lifefi import engine as engine_mod  # noqa: E402
from lifefi.control import Server  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--serial", help="the board over USB, e.g. COM3, or auto (the default: the one USB serial "
                                      "port that looks like a board; close serial monitors first)")
    src.add_argument("--esp", nargs="?", const="", help="the board's IP for UDP streaming (no value: broadcast)")
    src.add_argument("--replay", help="a .csirec to replay instead of the board")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed (breathing reads this x faster)")
    ap.add_argument("--loop", action="store_true", help="replay: start again at the end")
    ap.add_argument("--calibrate-at-start", action="store_true",
                    help="start the 2-minute empty-room calibration right away (for a recording that begins "
                         "with 2 min of empty room, at --speed 1)")
    ap.add_argument("--host", default="127.0.0.1", help="where the server connects (contracts/control.md)")
    ap.add_argument("--port", type=int, default=6000)
    ap.add_argument("--calibration", default=str(engine_mod.CALIBRATION),
                    help="the live calibration is saved here and loaded at start ('' = keep it in memory only)")
    ap.add_argument("--rules", default=str(engine_mod.RULES))
    ap.add_argument("--models", default=str(engine_mod.MODELS))
    args = ap.parse_args()

    eng = engine_mod.Engine(args.rules, args.models, mode="replay" if args.replay else "live",
                            calibration_path=args.calibration or None)
    print(f"rules {args.rules} (config {eng.config_hash}); model: {eng.model_status}")
    if eng.calibration is not None:
        print(f"live calibration {eng.calibration.id} loaded from {args.calibration}")
    # live is always configured, so the dashboard can switch from a replay to the board and back
    live = {"esp": args.esp or None} if args.esp is not None else {"serial": args.serial or "auto", "baud": args.baud}
    server = Server(eng, host=args.host, port=args.port, live_args=live)
    try:
        if args.replay:
            server.set_source("replay", args.replay, args.speed, args.loop)
        else:
            server.set_source("live")
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    if args.calibrate_at_start:
        dur = eng.rules["calibration"]["default_s"]
        eng.start_calibration(time.time(), "empty", dur, lambda ok, data, err: print(
            f"calibration at start: {data.get('id') if ok else 'refused: ' + str(err)}"))
        print(f"calibration at start: {dur:.0f} s, the room must stay empty")
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
