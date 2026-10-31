"""The engine: CSI packets in, one result per tick out (plan-v2 §3; contracts/).

`Engine` has no sockets and no clock of its own: `feed(packet, host_us)`
takes every frame the board sends, `tick(now_s)` returns the next result
(contracts/results.schema.json), and `handle(cmd, reply)` answers the
commands of contracts/control.md. lifefi.control puts it on TCP 6000;
the tests drive it directly, faster than real time.

Per tick:
1. lifefi.live turns the packets into F (the training pipeline's code);
2. motion M on the last `fall.window_s` of F;
3. breathing (lifefi.breathing) every 5 s on 30 s of raw CSI;
4. presence (lifefi.presence) from M, breathing energy B and S;
5. `no_breathing` (lifefi.apnea), the fall rule (lifefi.fall) and its
   escalation to `fainted_suspected`;
6. the movement model and posture (hidden unless rules.yaml says so).

The engine reports conditions; the server decides alerts (plan-v2 design
rule 5). Every threshold is in engine/config/rules.yaml (rule 6).

The empty-room calibration belongs to the signal it was taken on: live and
replay each keep their own, and only the live one is saved to disk
(`calibration_path`) and loaded again at the next start.
"""

import hashlib
import json
import pathlib
import struct
import sys
import time
from collections import deque

import numpy as np
import yaml

from . import apnea, breathing, calibration, dsp, fall, models, posture, presence
from . import live as live_mod
from . import motion as motion_mod
from .live import LiveF

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firmware" / "tools"))
import csi_recorder  # noqa: E402  (frame header, .csirec format)

VERSION = "0.1.0"
RULES = ROOT / "engine" / "config" / "rules.yaml"
PROFILES = ROOT / "contracts" / "profiles.yml"
MODELS = ROOT / "ml" / "models"
LLTF = np.array(csi_recorder.LLTF_PAIRS)
CLOCK_WINDOW_S = 60.0
FALL_EDGE_S = 5.0            # fall candidates this close to the window start are skipped (filter start-up)
CALIBRATION = ROOT / "data" / "calibration.json"
ACTIVITY_LABELS = ("none", "walking", "sit_down", "lie_down", "rise", "fall")   # results.schema.json activityLabel


def lltf(data, first_word_invalid):
    """csi_recorder.lltf_complex, vectorised: the 52 LLTF subcarriers, k = -26..-1, +1..+26."""
    p = np.frombuffer(bytes(data[:128]), dtype=np.int8).reshape(64, 2)[LLTF].astype(np.float32)
    c = p[:, 1] + 1j * p[:, 0]                       # pairs are [imag, real]
    if first_word_invalid:
        c[26] = c[27]
    return c.astype(np.complex64)


class Clock:
    """ESP time -> host time per boot: the lower envelope of host - ts (delivery only adds delay)."""

    def __init__(self):
        self.boot = None
        self.win = deque()                           # (host_us, d) with d increasing: sliding minimum

    def map(self, boot_id, ts_us, host_us):
        if boot_id != self.boot:
            self.boot = boot_id
            self.win.clear()
        d = host_us - ts_us
        while self.win and self.win[-1][1] >= d:
            self.win.pop()
        self.win.append((host_us, d))
        while self.win[0][0] < host_us - CLOCK_WINDOW_S * 1e6:
            self.win.popleft()
        return (ts_us + self.win[0][1]) / 1e6


class Events:
    """`active` holds one event per type. Ids start from a number taken from the start time, so
    a restarted engine never reuses an id the server may still hold an alert for (control.md)."""

    def __init__(self, first_id=None):
        self.next_id = int(time.time()) % 1_000_000 * 1000 + 1 if first_id is None else first_id
        self.active = {}
        self.changes = []

    def set(self, kind, on, t_ms, data=None):
        ev = self.active.get(kind)
        if on and ev is None:
            ev = {"id": self.next_id, "type": kind, "t": t_ms, "data": data or {}}
            self.next_id += 1
            self.active[kind] = ev
            self.changes.append({**ev, "state": "active"})
        elif not on and ev is not None:
            del self.active[kind]
            self.changes.append({"id": ev["id"], "type": kind, "state": "cleared", "t": t_ms, "data": data or {}})

    def clear_all(self, t_ms, data=None):
        for kind in list(self.active):
            self.set(kind, False, t_ms, data)

    def pop(self):
        out, self.changes = self.changes, []
        return out


class Engine:
    def __init__(self, rules_path=RULES, models_dir=MODELS, mode="live", calibration_path=None):
        """calibration_path: where the live calibration is saved and loaded (None: memory only)."""
        self.rules_path, self.models_dir = pathlib.Path(rules_path), pathlib.Path(models_dir)
        self.calibration_path = pathlib.Path(calibration_path) if calibration_path else None
        self.mode = mode
        self.source_hook = None                      # set by lifefi.control: (mode, file, speed, loop) -> None
        self.source_info_hook = None                 # set by lifefi.control: () -> get_status source_info
        self.events = Events()
        self.calibrations = {"live": self._load_calibration(), "replay": None}
        self.calibration = self.calibrations.get(mode)
        self.cal_pending = self.calibration is not None   # applied to presence on the first tick
        self.cal_seq = int(self.calibration.id.split("-")[-1]) if self.calibration else 0
        self.cal_job = None
        self.recording = None
        self.started = None
        self.load_rules()
        self.load_models()
        self._reset_signal()
        self.boot_id = 0
        self.hdr = None
        self.clock = Clock()
        self.rejected = {"layout": 0, "gain_invalid": 0, "source": 0}
        self.rx = deque()                            # (host_s, seq, rx_seq) of the last 10 s
        self.last_host_us = 0

    # ---- configuration -------------------------------------------------
    def load_rules(self, t=0.0):
        text = self.rules_path.read_bytes()
        self.rules = yaml.safe_load(text)
        prof = PROFILES.read_bytes() if PROFILES.exists() else b""
        self.config_hash = hashlib.sha256(text + prof).hexdigest()[:6]
        r = self.rules
        self.presence = presence.Presence(r["presence"])
        if self.calibration is not None:
            self.presence.calibrate(presence.Levels.from_calibration(self.calibration, self.presence.cfg), t)
        self.apnea = apnea.NoBreathing(r["apnea"])

    def _load_calibration(self):
        path = self.calibration_path
        if path is None or not path.exists():
            return None
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
            d["p_empty"] = np.asarray(d["p_empty"], dtype=np.float32)
            if d["p_empty"].shape != (52,):
                raise ValueError("p_empty must have 52 values")
            return calibration.Calibration(**d)
        except (OSError, ValueError, TypeError, KeyError) as err:
            print(f"ignoring {path}: {err}")
            return None

    def _save_calibration(self, cal):
        if self.calibration_path is None:
            return
        try:
            self.calibration_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.calibration_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(cal.to_dict()), encoding="utf-8")
            tmp.replace(self.calibration_path)
        except OSError as err:
            print(f"could not save the calibration to {self.calibration_path}: {err}")

    def _use_calibration(self, cal, t):
        """Presence starts again from EMPTY with these levels, or with none (motion only)."""
        self.calibration = cal
        self.presence = presence.Presence(self.rules["presence"])
        if cal is not None:
            self.presence.calibrate(presence.Levels.from_calibration(cal, self.presence.cfg), t)

    def load_models(self):
        self.model, self.model_status = models.load(self.models_dir, self.rules.get("movement_model", "gbm"))
        labels = self.model.labels if self.model else ["none", "walking", "sit_down", "lie_down", "rise", "fall"]
        self.posture = posture.Posture(labels, self.rules["posture"])

    def _reset_signal(self):
        self.live = LiveF()
        self.segment = self.live.segment
        self.warm_until = -np.inf
        self.breath = None
        self.breath_at = None
        self.next_breath = -np.inf
        self.breath_valid = False
        self.m_hist = deque()                        # (t, M) for the provisional quiet level
        self.last_motion = None
        self.fall_done = []
        self.fall_t = None
        self.still_run = 0.0
        self.motion_run = 0.0

    # ---- input ----------------------------------------------------------
    def feed(self, packet, host_us, source="live"):
        """One frame from the board (or the replay), with its host receive time in µs."""
        if source != self.mode:
            self.rejected["source"] += 1
            return
        parsed = csi_recorder.parse_frame(packet)
        if parsed is None:
            self.rejected["layout"] += 1
            return
        hdr, data = parsed
        if self.recording is not None:
            self.recording["fh"].write(csi_recorder.RECORD.pack(len(packet), host_us) + packet)
            self.recording["frames"] += 1
            self.recording["t_end_us"] = host_us
        if not hdr["csi_parts"] & 1 or hdr["cwb"] != 0 or len(data) < 128:
            self.rejected["layout"] += 1             # HT40 or no LLTF: not what the models know
            return
        if hdr["boot_id"] != self.boot_id:
            self.boot_id = hdr["boot_id"]
            self.live.new_segment()
            self.warm_until = host_us / 1e6 + self.rules["warmup_s"]
        self.hdr = hdr
        self.last_host_us = host_us
        t = self.clock.map(hdr["boot_id"], hdr["ts_us"], host_us)
        self.live.add(t, lltf(data, hdr["first_word_invalid"]))
        self.rx.append((host_us / 1e6, hdr["seq"], hdr["rx_seq"]))
        while self.rx and self.rx[0][0] < host_us / 1e6 - 10.0:
            self.rx.popleft()

    # ---- one tick -------------------------------------------------------
    def tick(self, now):
        """The result for host time `now` (s)."""
        r = self.rules
        if self.started is None:
            self.started = now
            self.warm_until = max(self.warm_until, now + r["warmup_s"])
        if self.cal_pending:
            self.cal_pending = False
            self._use_calibration(self.calibration, now)
        self.live.update()
        lv = self.live
        if lv.segment != self.segment:               # a gap: everything that looks back starts again
            self.segment = lv.segment
            self.warm_until = max(self.warm_until, now + r["warmup_s"])
            self.fall_done = []
            self.next_breath = -np.inf
        warm = now < self.warm_until or lv.seconds() < 1.0
        t_ms = int(round(now * 1000))

        tF, F, V = lv.last(r["fall"]["window_s"])
        M = motion_mod.motion(F) if len(F) >= int(motion_mod.FS) else None
        M_now = float(M[-1]) if M is not None else None
        if M_now is not None:
            self.m_hist.append((now, M_now))
            while self.m_hist[0][0] < now - 120.0:
                self.m_hist.popleft()
        quiet = self._quiet_level()
        m_on = self._m_on(quiet)
        moving = M_now is not None and M_now > m_on
        if moving:
            self.last_motion = now

        self._calibration_step(now)
        self._breathing_step(now)

        B = S = None
        if lv.seconds() >= presence.B_WIN_S:
            tB, FB, VB = lv.last(presence.B_WIN_S)
            if VB.mean() >= 0.9:
                B = presence.breath_energy(FB)
        if self.calibration is not None and lv.seconds() >= presence.S_WIN_S:
            S = presence.static_deviation(lv.last(presence.S_WIN_S)[1], self.calibration.p_empty)
        if M_now is not None:
            self.presence.update(now, M_now, B, S, breathing_valid=self.breath_valid)
        state = self.presence.state
        present = state == "present"
        self.events.set("presence_uncertain", state == "uncertain" and not warm, t_ms)

        quiet_for = now - self.last_motion if self.last_motion is not None else now - self.started
        self.breath_valid = bool(self.breath is not None and self.breath.valid and present and not warm
                                 and now - self.breath_at <= breathing.STEP_S * 2
                                 and quiet_for >= r["breathing"]["low_motion_s"])
        still = M_now is not None and M_now / quiet < r["fall"]["t_still"]

        ch = self.apnea.update(now, *lv.raw(45.0), present=present and not warm, still=still)
        if ch == "active":
            self.events.set("no_breathing", True, t_ms, {"since_s": getattr(self.apnea, "since_s", None)})
        elif ch == "cleared":
            self.events.set("no_breathing", False, t_ms)

        self._fall_step(now, t_ms, F, tF, M, quiet, still, moving, state, warm)
        post = self._posture_step(now, present)

        level = float(presence.motion_level(M_now, m_on, r["presence"]["motion_span"])) if M_now is not None else 0.0
        return self._result(now, t_ms, state, level, B, S, post, warm)

    def _quiet_level(self):
        """The fall rule's baseline: the empty calibration's P10 of M, else a provisional P10."""
        if self.calibration is not None:
            return max(self.calibration.m_p10, 1e-12)
        if not self.m_hist:
            return 1.0
        return max(float(np.percentile([m for _, m in self.m_hist], 10)), 1e-12)

    def _m_on(self, quiet):
        if self.presence.levels is not None:
            return self.presence.levels.m_on
        return self.rules["presence"]["nocal_m_on_x"] * quiet

    def _breathing_step(self, now):
        if now < self.next_breath:
            return
        self.next_breath = now + breathing.STEP_S
        t_raw, csi = self.live.raw(breathing.WINDOW_S + 0.5)
        if len(t_raw) < 10 or t_raw[-1] - t_raw[0] < breathing.WINDOW_S:
            return
        w = breathing.estimate_breathing((t_raw * 1e6).astype(np.int64), csi)
        if not w:
            return
        self.breath, self.breath_at = w[-1], now
        self.apnea.on_breathing(now, w[-1], *self.live.raw(45.0))

    def _fall_step(self, now, t_ms, F, tF, M, quiet, still, moving, state, warm):
        f = self.rules["fall"]
        tick = self.rules["tick_s"]
        if M is not None and len(F) >= 4 * motion_mod.FS:
            cands = fall.detect(F, quiet, t_fall=f["t_fall"], ratio=f["ratio"], t_still=f["t_still"],
                                still_s=f["still_s"], M=M)
            for c in cands:
                t_abs = float(tF[0] + c.t_peak)
                # M restarts at the window's first sample: a window that begins mid-movement shows a
                # false onset there. Those moments were judged on earlier ticks, deep inside the window.
                if t_abs < tF[0] + FALL_EDGE_S or any(abs(t_abs - d) < 1.0 for d in self.fall_done):
                    continue
                if c.fall and state != "empty" and not warm:
                    self.fall_done.append(t_abs)
                    if "fall" not in self.events.active:
                        self.events.set("fall", True, t_ms, {"peak": round(c.peak, 1), "burst_s": round(c.burst_s, 2),
                                                             "ratio": round(c.ratio, 1), "t_peak": int(t_abs * 1000)})
                        self.fall_t, self.still_run, self.motion_run = now, 0.0, 0.0
                elif now - t_abs > c.burst_s + 1.0 + f["still_s"] + 2.0:
                    self.fall_done.append(t_abs)      # did not settle into stillness: not a fall
            self.fall_done = [d for d in self.fall_done if d > now - f["window_s"] - 5.0]
        if "fall" in self.events.active:
            self.still_run = self.still_run + tick if still else 0.0
            self.motion_run = self.motion_run + tick if moving else 0.0
            if self.still_run >= f["fainted_after_s"] and self.fall_t is not None:
                self.events.set("fainted_suspected", True, t_ms, {"still_s": round(now - self.fall_t, 1)})
            if self.motion_run >= f["clear_motion_s"]:
                self.events.set("fall", False, t_ms)
                self.events.set("fainted_suspected", False, t_ms)
                self.fall_t = None

    def _posture_step(self, now, present):
        p = None
        if self.model is not None and self.live.seconds() >= self.model.window / dsp.FS:
            tW, FW, VW = self.live.last(self.model.window / dsp.FS)
            if len(FW) == self.model.window and VW.mean() >= 0.9:
                p = self.model.predict(FW)
        self.last_p = p
        return self.posture.update(now, p, present)

    # ---- calibration ----------------------------------------------------
    def start_calibration(self, now, kind, duration_s, done):
        """done(ok, data, error) is called when it finishes (contracts/control.md: the ack comes then)."""
        if kind != "empty":
            return done(False, {}, f"calibration kind '{kind}' is not supported (only 'empty')")
        if duration_s < calibration.MIN_S:
            return done(False, {}, f"calibration needs at least {calibration.MIN_S:.0f} s, got {duration_s}")
        if self.cal_job is not None:
            return done(False, {}, "a calibration is already running")
        self.cal_job = {"start": now, "until": now + duration_s, "done": done}

    def _calibration_step(self, now):
        job = self.cal_job
        if job is None or now < job["until"]:
            return
        self.cal_job = None
        sel = (self.live.t >= job["start"]) & (self.live.t <= job["until"])
        # lifefi.live clears F at every gap, so a short calibration window means the signal stopped
        if sel.sum() < 0.9 * (job["until"] - job["start"] - live_mod.BUFFER_S) * dsp.FS:
            return job["done"](False, {}, f"only {sel.sum() / dsp.FS:.0f} s of continuous signal during "
                                          f"the {job['until'] - job['start']:.0f} s calibration")
        self.cal_seq += 1
        cal_id = f"cal-{self.cal_seq:04d}"
        try:
            cal = calibration.from_empty(self.live.F[sel], self.live.valid[sel], cal_id, now)
        except calibration.Refused as err:
            return job["done"](False, {}, str(err))
        self.calibration = self.calibrations[self.mode] = cal
        self.presence.calibrate(presence.Levels.from_calibration(cal, self.presence.cfg), now)
        if self.mode == "live":
            self._save_calibration(cal)
        job["done"](True, {"id": cal_id}, None)

    # ---- output ---------------------------------------------------------
    def _health(self, now, warm):
        while self.rx and self.rx[0][0] < now - 10.0:     # a silent board must show 0 Hz, not its last rate
            self.rx.popleft()
        rx = list(self.rx)
        rate = sum(1 for x in rx if x[0] >= now - 2.0) / 2.0
        lost_udp = lost_air = 0
        for (_, s0, r0), (_, s1, r1) in zip(rx, rx[1:]):
            lost_udp += max(0, s1 - s0 - 1) if s1 > s0 else 0
            d = (r1 - r0) % 4096
            lost_air += d - 1 if 1 < d < 1000 else 0
        n = max(len(rx), 1)
        _, _, V = self.live.last(3.0)
        return {"rate_hz": round(rate, 1), "loss_udp": round(min(1.0, lost_udp / (n + lost_udp)), 4),
                "loss_air": round(min(1.0, lost_air / (n + lost_air)), 4),
                "invalid_ratio": round(float(1.0 - V.mean()), 4) if len(V) else 0.0,
                "rejected": dict(self.rejected), "warmup": bool(warm)}

    def _calibration_status(self, now):
        if self.cal_job is not None:
            return {"state": "running", "id": None, "age_s": None}
        if self.calibration is None:
            return {"state": "none", "id": None, "age_s": None}
        age = max(0.0, now - self.calibration.at)
        stale = age > self.rules["calibration"]["stale_after_h"] * 3600
        return {"state": "stale" if stale else "ok", "id": self.calibration.id, "age_s": round(age, 1)}

    def _activity(self):
        """The movement model's guess (results.schema.json activity), or None."""
        p = self.last_p
        if p is None or self.model is None or len(p) != len(self.model.labels):
            return None
        labels = self.model.labels
        if not set(labels) <= set(ACTIVITY_LABELS):     # an older model's classes: not in the contract
            return None
        p = np.clip(np.nan_to_num(np.asarray(p, dtype=np.float64)), 0.0, 1.0)
        k = int(np.argmax(p))
        return {"label": labels[k], "p": round(float(p[k]), 3),
                "probs": {lab: round(float(v), 3) for lab, v in zip(labels, p)}, "src": "model"}

    def outputs(self):
        """Which optional result fields this engine fills (get_status engine.outputs)."""
        return {"posture": bool(self.rules["posture"]["publish"]), "count": False, "activity": self.model is not None}

    def _result(self, now, t_ms, state, level, B, S, post, warm):
        b = self.breath
        wave = []
        if b is not None and b.v is not None:
            r = apnea.projected(*self.live.raw(45.0), b.v)
            if r is not None:
                g, y = r
                wave = [round(float(x), 3) for x in y[g > g[-1] - self.rules["tick_s"]]]
        show_posture = self.rules["posture"]["publish"] and post is not None
        return {
            "type": "result", "v": 2, "ts": t_ms, "t_rx_last_us": int(self.last_host_us),
            "node": int(self.hdr["node_id"]) if self.hdr else 1, "boot_id": int(self.boot_id),
            "source": self.mode, "config_hash": self.config_hash, "pipeline_version": dsp.PIPELINE_VERSION,
            "health": self._health(now, warm),
            "calibration": self._calibration_status(now),
            "presence": {"value": state == "present", "state": state, "S": round(float(S or 0.0), 4),
                         "B": round(float(B or 0.0), 5), "M": round(level, 3)},
            "motion": round(level, 3),
            "posture": {"label": post[0], "since": int(post[1] * 1000), "src": post[2]} if show_posture else None,
            "count": None,
            "activity": self._activity(),
            "breathing": {"bpm": round(float(b.bpm), 1) if self.breath_valid else None,
                          "confidence": round(float(np.clip(b.confidence, 0, 1)), 3) if b is not None else 0.0,
                          "valid": self.breath_valid, "wave": wave},
            "csi": [[round(float(v), 1) for v in row] for row in self.live.F[-5:]],
            "events": self.events.pop(),
            "active": [e["id"] for e in self.events.active.values()],
        }

    def status(self, now):
        """get_status ack data (contracts/control.md). The firmware sends no status packet, so
        `device` is built from the CSI frames: last_status_us is the last frame's time."""
        h = self.hdr
        engine = {"version": VERSION, "pipeline_version": dsp.PIPELINE_VERSION, "config_hash": self.config_hash,
                  "source": self.mode, "uptime_s": int(now - self.started) if self.started else 0,
                  "inference_ms": self.model.timing() if self.model else {"p50": 0.0, "p95": 0.0},
                  "models": [self.model_status], "calibration": self._calibration_status(now),
                  "recording": None if self.recording is None else
                  {"session": self.recording["session"], "frames": self.recording["frames"]},
                  "active_events": [{k: e[k] for k in ("id", "type", "t", "data")} for e in self.events.active.values()],
                  "source_info": self.source_info_hook() if self.source_info_hook else
                  {"name": None, "state": "none", "file": None, "speed": 1.0, "loop": False, "error": None},
                  "outputs": self.outputs()}
        if h is None:
            return {"engine": engine, "device": None}
        health = self._health(now, False)
        device = {"node": int(h["node_id"]), "boot_id": int(h["boot_id"]), "fw_version": "unknown",
                  "rssi_dbm": int(h["rssi_dbm"]), "channel": int(h["channel"]), "uptime_s": int(h["ts_us"] // 1_000_000),
                  "rate_hz": health["rate_hz"], "loss_udp": health["loss_udp"], "loss_air": health["loss_air"],
                  "rejected": dict(self.rejected), "queue_drops": 0, "send_errors": 0, "wifi_disconnects": 0,
                  "ping_rate_hz": 0, "ping_timeouts_last_s": 0, "last_status_us": int(self.last_host_us)}
        return {"engine": engine, "device": device}

    # ---- commands (contracts/control.md) --------------------------------
    def handle(self, cmd, reply, now):
        """reply(ack dict) once per command; calibrate replies when it finishes."""
        cid = cmd.get("id", -1)
        kind = cmd.get("type")

        def ack(ok, data=None, error=None):
            reply({"type": "ack", "id": cid, "ok": ok, "error": error, "data": data or {}})

        try:
            if kind == "get_status":
                return ack(True, self.status(now))
            if kind == "set_source":
                mode = cmd.get("mode")
                if mode not in ("live", "replay"):
                    return ack(False, error="mode must be live or replay")
                speed = 1.0 if cmd.get("speed") is None else float(cmd["speed"])
                if speed <= 0:
                    return ack(False, error="speed must be > 0")
                if self.source_hook is not None:
                    self.source_hook(mode, cmd.get("file"), speed, bool(cmd.get("loop")))
                # they belonged to the old signal; the reason keeps the dashboard from calling it "all clear"
                self.events.clear_all(int(round(now * 1000)), {"reason": "source changed"})
                self.mode = mode
                self._reset_signal()
                self.rx.clear()
                self._use_calibration(self.calibrations.get(mode), now)
                self.cal_pending = False
                return ack(True)
            if kind == "calibrate":
                dur = float(cmd.get("duration_s", self.rules["calibration"]["default_s"]))
                return self.start_calibration(now, cmd.get("kind", "empty"), dur,
                                              lambda ok, data, err: ack(ok, data, err))
            if kind == "record_start":
                if self.mode != "live":
                    return ack(False, error="recording is live only")
                if self.recording is not None:
                    return ack(False, error="already recording")
                path = pathlib.Path(cmd["path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                fh = open(path, "wb")
                fh.write(csi_recorder.CSIREC_MAGIC + struct.pack("<HH", 1, 0))
                self.recording = {"fh": fh, "session": cmd.get("session"), "path": str(path), "frames": 0,
                                  "t_start_us": int(now * 1e6), "t_end_us": int(now * 1e6)}
                return ack(True)
            if kind == "record_stop":
                if self.recording is None:
                    return ack(False, error="not recording")
                rec, self.recording = self.recording, None
                rec["fh"].close()
                return ack(True, {"frames": rec["frames"], "t_start_us": rec["t_start_us"], "t_end_us": rec["t_end_us"]})
            if kind == "reload_models":
                self.load_models()
                return ack(True, {"models": [self.model_status]})
            if kind == "reload_rules":
                self.load_rules(now)
                return ack(True, {"config_hash": self.config_hash})
            return ack(False, error=f"unknown command '{kind}'")
        except Exception as err:                     # a bad argument must never cost the connection
            return ack(False, error=str(err) if isinstance(err, ValueError) else f"{type(err).__name__}: {err}")

    def close(self):
        if self.recording is not None:
            self.recording["fh"].close()
            self.recording = None


def result_json(result):
    return json.dumps(result, separators=(",", ":"))
