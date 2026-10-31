"""Records labelled spots for the spot model (ml/train_spots.py) through the running app.

    .venv/Scripts/python ml/record_spots.py --start-at <epoch s> \
        --spots "desk:0.4:40,middle:2:40,far:4:40,empty:0:40" [--gap 12] [--pin 1234]

Starts a live recording (POST /api/v1/recordings/start) just before
`--start-at`, then follows the schedule: each spot `name:distance_m:seconds`
in order with `--gap` seconds between them to walk over (not labelled).
`empty` means nobody in the room. Writes data/sessions/<id>/spots.json with
the host-clock µs of every spot, next to the engine's .csirec.

--say speaks every step out loud (Windows speech), so nobody has to watch
the clock: where to go, when recording starts, when to move on.
"""

import argparse
import json
import pathlib
import subprocess
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def call(base, path, body, pin):
    req = urllib.request.Request(f"{base}/api/v1{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "x-lifefi-pin": pin})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


WHERE = {"close": "close to the sensor", "middle": "to the middle of the room", "far": "far from the sensor",
         "empty": "out of the room"}


def say(text, on):
    print(f"{time.strftime('%H:%M:%S')} say: {text}", flush=True)
    if on:
        subprocess.Popen(["powershell", "-NoProfile", "-Command",
                          "Add-Type -AssemblyName System.Speech; "
                          f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text}')"])


def wait_until(t):
    while (left := t - time.time()) > 0:
        time.sleep(min(left, 0.5))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-at", type=float, required=True, help="epoch s of the first spot")
    ap.add_argument("--spots", required=True, help="name:distance_m:seconds,...")
    ap.add_argument("--gap", type=float, default=12.0)
    ap.add_argument("--pin", default="1234")
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--say", action="store_true", help="speak every step out loud")
    ap.add_argument("--intro", default="", help="said first, e.g. which posture this round")
    a = ap.parse_args()

    spots = []
    t = a.start_at
    for item in a.spots.split(","):
        name, d, secs = item.split(":")
        spots.append({"name": name, "d_m": float(d), "t0": t, "t1": t + float(secs)})
        t += float(secs) + a.gap
    session = time.strftime("spots-%Y%m%d-%H%M%S", time.localtime(a.start_at))
    for s in spots:
        print(f"{s['name']:>8} {s['d_m']:>4} m  {time.strftime('%H:%M:%S', time.localtime(s['t0']))}"
              f" - {time.strftime('%H:%M:%S', time.localtime(s['t1']))}", flush=True)

    lead = round(spots[0]["t0"] - time.time())
    if a.intro:
        say(a.intro, a.say)
        time.sleep(4)
    say(f"Go {WHERE.get(spots[0]['name'], spots[0]['name'])}. Recording starts in {lead} seconds.", a.say)
    wait_until(a.start_at - 5)
    call(a.base, "/recordings/start", {"session": session, "meta": {"kind": "spots"}}, a.pin)
    print(f"recording {session}", flush=True)
    try:
        for i, s in enumerate(spots):
            wait_until(s["t0"])
            say(f"Recording. Stay {WHERE.get(s['name'], s['name'])} for {round(s['t1'] - s['t0'])} seconds.", a.say)
            wait_until(s["t1"])
            if i + 1 < len(spots):
                nxt = spots[i + 1]
                say(f"Stop. Go {WHERE.get(nxt['name'], nxt['name'])}. Recording starts in {round(nxt['t0'] - s['t1'])} seconds.", a.say)
    finally:
        stopped = call(a.base, "/recordings/stop", {}, a.pin)
    say("All done. You can come back.", a.say)
    out = ROOT / "data" / "sessions" / session / "spots.json"
    out.write_text(json.dumps({"session": session, "spots": [
        {"name": s["name"], "d_m": s["d_m"], "t0_us": int(s["t0"] * 1e6), "t1_us": int(s["t1"] * 1e6)} for s in spots
    ]}, indent=2), encoding="utf-8")
    print(f"stopped: {stopped.get('frames')} frames; labels in {out}", flush=True)


if __name__ == "__main__":
    main()
