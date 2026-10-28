/**
 * breathing.ts on synthetic raw CSI with a known breathing rate.
 *
 *   node engine/ts/tests/breathing.test.ts
 *
 * Same scenarios as engine/tests/test_breathing.py (with a different random
 * generator). Synthetic data checks the processing, not real-world accuracy:
 * that needs recordings with a reference (counted breaths or a chest sensor).
 */

import { estimateBreathing, summarize } from "../src/breathing.ts";
import type { CsiMatrix } from "../src/csirec.ts";

let failures = 0;

function check(cond: boolean, what: string): void {
  console.log((cond ? "  ok   " : "  FAIL ") + what);
  if (!cond) failures++;
}

/** Seeded uniform [0, 1) (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * next();
  const normal = (mu: number, sigma: number) =>
    mu + sigma * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, uniform, normal };
}

interface SynthOptions {
  bpm?: number;
  breathDb?: number;
  motion?: boolean;
  gap?: [number, number];
  seed?: number;
  rate?: number;
}

/**
 * Raw CSI like the ESP32 delivers it: static multipath, an optional
 * breathing modulation on ~40 % of subcarriers, per-packet AGC gain,
 * receiver noise, jittered timing, and an optional gap.
 */
function synth(seconds: number, { bpm, breathDb = 0.5, motion = false, gap, seed = 1, rate = 90 }: SynthOptions = {}): [number[], CsiMatrix] {
  const r = rng(seed);
  let t: number[] = [];
  for (let acc = 0, i = 0; i < Math.trunc(seconds * rate); i++) t.push((acc += r.uniform(0.6, 1.4) / rate));
  if (gap) t = t.filter((v) => v < gap[0] || v > gap[1]);
  const staticAmp = Array.from({ length: 52 }, () => r.uniform(15, 60));
  const staticPhase = Array.from({ length: 52 }, () => r.uniform(0, 2 * Math.PI));
  const affected = Array.from({ length: 52 }, () => (r.next() < 0.4 ? 1 : 0));
  const sign = Array.from({ length: 52 }, () => (r.next() < 0.5 ? -1 : 1));
  const motions = motion
    ? Array.from({ length: 12 }, () => ({ f: r.uniform(0.15, 3.0), ph: r.uniform(0, 6.3), w: Array.from({ length: 52 }, () => r.normal(0, 1)) }))
    : [];
  const n = t.length;
  const re = new Float64Array(n * 52);
  const im = new Float64Array(n * 52);
  t.forEach((ti, row) => {
    const gain = r.uniform(0.6, 1.4);   // AGC / auto-scale per packet
    const breath = bpm === undefined ? 0 : breathDb * Math.sin((2 * Math.PI * bpm * ti) / 60);
    for (let c = 0; c < 52; c++) {
      let db = breath * sign[c] * affected[c];
      for (const m of motions) db += 2.0 * Math.sin(2 * Math.PI * m.f * ti + m.ph) * m.w[c];
      const amp = staticAmp[c] * 10 ** (db / 20) * gain;
      re[row * 52 + c] = amp * Math.cos(staticPhase[c]) + r.normal(0, 0.7);
      im[row * 52 + c] = amp * Math.sin(staticPhase[c]) + r.normal(0, 0.7);
    }
  });
  return [t.map((v) => Math.round(v * 1e6)), { n, re, im }];
}

function run(seconds: number, opts: SynthOptions) {
  const [ts, csi] = synth(seconds, opts);
  return summarize(estimateBreathing(ts, csi));
}

console.log("== still person breathing 15 /min, 2 min, a 10 s Wi-Fi pause");
let s = run(120, { bpm: 15, gap: [50, 60] });
check(s.bpm !== null && Math.abs(s.bpm - 15) <= 1, `rate 15 found (${s.bpm})`);
check(s.valid >= 0.8 * s.windows, `most windows valid (${s.valid}/${s.windows})`);

for (const bpm of [8, 22]) {
  s = run(90, { bpm, seed: bpm });
  check(s.bpm !== null && Math.abs(s.bpm - bpm) <= 1, `rate ${bpm} found (${s.bpm})`);
}

console.log("== shallow breathing (0.2 dB), close to the noise");
s = run(90, { bpm: 12, breathDb: 0.2, seed: 5 });
check(s.bpm === null || Math.abs(s.bpm - 12) <= 1, `never a wrong rate (${s.bpm}, ${s.valid} valid)`);

console.log("== nobody: noise only");
s = run(120, { seed: 7 });
check(s.valid <= 0.1 * s.windows, `no breathing reported (${s.valid}/${s.windows} valid)`);

console.log("== a person moving");
s = run(120, { bpm: 15, motion: true, seed: 9 });
check(s.valid <= 0.1 * s.windows, `motion blocks the estimate (${s.valid}/${s.windows} valid)`);

console.log("== recording split by long pauses");
const [ts, csi] = synth(60, { bpm: 15, gap: [20, 40], seed: 11 });
check(estimateBreathing(ts, csi).length === 0, "no window bridges a gap; 20 s pieces give nothing");

console.log(`\nbreathing.test ${failures ? "FAILED" : "PASSED"}: ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
