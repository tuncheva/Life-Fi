// Mock engine: stands in for engine/ until the Python engine exists.
// Speaks exactly contracts/control.md on TCP 127.0.0.1:6000 and emits
// results from contracts/results.schema.json every 0.5 s.
//
//   npm run mock-engine -w server            # scenario "normal"
//   MOCK_SCENARIO=fall npm run mock-engine -w server
//
// Mock-only commands (not in the contract): mock_scenario {name}, mock_list_scenarios.
import net from "node:net";
import { listScenarios } from "./scenarios.js";
import { Simulator } from "./simulator.js";

const port = Number(process.env.LIFEFI_ENGINE_PORT ?? 6000);
const host = "127.0.0.1";
const initial = process.env.MOCK_SCENARIO ?? process.argv[2] ?? "normal";

const sim = new Simulator(initial, Date.now());
let client: net.Socket | null = null;
let recording: { session: string; path: string; startedUs: number; frames: number } | null = null;

const log = (msg: string, extra: Record<string, unknown> = {}) => {
  const e = Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
  console.log(`[mock-engine ${new Date().toISOString().slice(11, 19)}] ${msg}${e}`);
};

function ack(id: number, ok: boolean, data: Record<string, unknown> = {}, error: string | null = null): string {
  return JSON.stringify({ type: "ack", id, ok, error, data }) + "\n";
}

function handle(cmd: Record<string, unknown>): string {
  const id = typeof cmd.id === "number" ? cmd.id : -1;
  const now = Date.now();
  switch (cmd.type) {
    case "get_status":
      return ack(id, true, sim.statusData(now));
    case "set_source": {
      if (cmd.mode !== "live" && cmd.mode !== "replay") return ack(id, false, {}, "mode must be live or replay");
      sim.source = cmd.mode;
      log("source", { mode: cmd.mode });
      return ack(id, true);
    }
    case "calibrate": {
      const kind = cmd.kind ?? "empty";
      const duration = typeof cmd.duration_s === "number" ? cmd.duration_s : 120;
      if (kind === "empty" && sim.currentMotion() > 0.1) return ack(id, false, {}, "motion seen during calibration");
      // The real engine acks when the calibration finishes. We do the same.
      sim.startCalibration(now, duration);
      log("calibration started", { kind, duration_s: duration });
      setTimeout(() => {
        if (client) client.write(ack(id, true, { id: sim.calibration.id }));
        log("calibration finished", { id: sim.calibration.id });
      }, duration * 1000);
      return ""; // deferred
    }
    case "record_start": {
      if (sim.source !== "live") return ack(id, false, {}, "recording is live only");
      if (recording) return ack(id, false, {}, "already recording");
      recording = { session: String(cmd.session), path: String(cmd.path), startedUs: now * 1000, frames: 0 };
      log("record_start", { session: recording.session });
      return ack(id, true);
    }
    case "record_stop": {
      if (!recording) return ack(id, false, {}, "not recording");
      const r = recording;
      recording = null;
      return ack(id, true, { frames: r.frames, t_start_us: r.startedUs, t_end_us: now * 1000 });
    }
    case "reload_models":
      return ack(id, true);
    case "reload_rules":
      return ack(id, true, { config_hash: sim.configHash });
    case "mock_scenario": {
      const name = String(cmd.name);
      if (!sim.setScenario(name, now)) return ack(id, false, {}, `unknown scenario '${name}'`);
      log("scenario", { name });
      return ack(id, true, { scenario: name });
    }
    case "mock_list_scenarios":
      return ack(id, true, { scenarios: listScenarios(), current: sim.scenarioName, phase: sim.phaseLabel });
    default:
      return ack(id, false, {}, `unknown command '${String(cmd.type)}'`);
  }
}

const server = net.createServer((sock) => {
  if (client) {
    log("second client, closing the old one");
    client.destroy();
  }
  client = sock;
  sock.setEncoding("utf8");
  sock.setNoDelay(true);
  log("server connected", { from: `${sock.remoteAddress}:${sock.remotePort}` });
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const out = handle(JSON.parse(line) as Record<string, unknown>);
        if (out) sock.write(out);
      } catch (err) {
        log("bad command line", { err: (err as Error).message });
      }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (client === sock) client = null;
    log("server disconnected");
  });
});

let lastPhase = "";
setInterval(() => {
  const now = Date.now();
  const r = sim.step(now);
  if (recording && r) recording.frames += 44; // ~88 Hz × 0.5 s
  const phase = `${sim.scenarioName}/${sim.phaseLabel}`;
  if (phase !== lastPhase) {
    lastPhase = phase;
    log("phase", { scenario: sim.scenarioName, phase: sim.phaseLabel });
  }
  if (r && client) client.write(JSON.stringify(r) + "\n");
}, 500);

server.listen(port, host, () => log(`listening on ${host}:${port}`, { scenario: initial }));
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
