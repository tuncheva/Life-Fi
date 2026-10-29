/**
 * heart.ts on synthetic raw CSI with known breathing and heart rates.
 *
 *   node engine/ts/tests/heart.test.ts
 *
 * Same scenarios as engine/tests/test_heart.py (with a different random
 * generator). The key cases are breathing harmonics with no heartbeat: they
 * fall in the heart band and must never be reported as a pulse.
 */

import { estimateHeart, summarize } from "../src/heart.ts";
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
  breathBpm?: number | null;
  harmonics?: number;
  dominant?: [number, number];
  heartBpm?: number;
  heartDb?: number;
  motion?: boolean;
  seed?: number;
  rate?: number;
}

/**
 * Raw CSI as in breathing.test.ts, plus non-sinusoidal breathing (harmonics
 * 2..14, each `harmonics` x the fundamental; `dominant` = [k, amp] makes
 * harmonic k stand out, as the 6th did on the 2026-10-28 recording) and an
 * optional heartbeat on its own ~40 % of subcarriers.
 */
function synth(seconds: number, { breathBpm = 9, harmonics = 0.25, dominant, heartBpm, heartDb = 0.15, motion = false, seed = 1, rate = 55 }: SynthOptions = {}): [number[], CsiMatrix] {
  const r = rng(seed);
  const t: number[] = [];
  for (let acc = 0, i = 0; i < Math.trunc(seconds * rate); i++) t.push((acc += r.uniform(0.6, 1.4) / rate));
  const staticAmp = Array.from({ length: 52 }, () => r.uniform(15, 60));
  const staticPhase = Array.from({ length: 52 }, () => r.uniform(0, 2 * Math.PI));
  const pattern = () => Array.from({ length: 52 }, () => (r.next() < 0.5 ? -1 : 1) * (r.next() < 0.4 ? 1 : 0));
  const breathW = pattern();
  const heartW = pattern();
  const harm = Array.from({ length: 13 }, (_, j) => ({
    k: j + 2,
    amp: dominant && j + 2 === dominant[0] ? dominant[1] : harmonics,
    ph: r.uniform(0, 2 * Math.PI),
  }));
  const motions = motion
    ? Array.from({ length: 12 }, () => ({ f: r.uniform(0.15, 3.0), ph: r.uniform(0, 6.3), w: Array.from({ length: 52 }, () => r.normal(0, 1)) }))
    : [];
  const n = t.length;
  const re = new Float64Array(n * 52);
  const im = new Float64Array(n * 52);
  t.forEach((ti, row) => {
    let breath = 0;
    if (breathBpm !== null) {
      const w = (2 * Math.PI * breathBpm) / 60;
      breath = Math.sin(w * ti);
      for (const h of harm) breath += h.amp * Math.sin(h.k * w * ti + h.ph);
      breath *= 0.5;
    }
    const heart = heartBpm === undefined ? 0 : heartDb * Math.sin((2 * Math.PI * heartBpm * ti) / 60);
    const gain = r.uniform(0.6, 1.4);
    for (let c = 0; c < 52; c++) {
      let db = breath * breathW[c] + heart * heartW[c];
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
  return summarize(estimateHeart(ts, csi));
}

console.log("== breathing 9 /min with strong harmonics, heartbeat 67.5 /min (between harmonics 63 and 72)");
let s = run(90, { heartBpm: 67.5 });
check(s.bpm !== null && Math.abs(s.bpm - 67.5) <= 2, `rate 67.5 found (${s.bpm}, ${s.valid}/${s.windows} valid)`);
check(s.valid >= 0.6 * s.windows, `most windows valid (${s.valid}/${s.windows})`);

for (const [heart, seed] of [[52, 3], [80, 4], [102, 6]]) {
  s = run(90, { heartBpm: heart, breathBpm: 12, seed });
  check(s.bpm !== null && Math.abs(s.bpm - heart) <= 2, `rate ${heart} found (${s.bpm})`);
}

console.log("== pulse 1 /min from a breathing harmonic (85 vs 7 x 12 = 84): not separable in 30 s");
s = run(90, { heartBpm: 85, breathBpm: 12, seed: 4 });
check(s.bpm === null || Math.abs(s.bpm - 85) <= 2, `never a wrong rate (${s.bpm}, ${s.valid} valid)`);

console.log("== breathing harmonics only, no heartbeat");
for (const seed of [1, 2, 3]) {
  s = run(90, { seed });
  check(s.valid === 0, `harmonics never reported as a pulse (seed ${seed}: ${s.valid}/${s.windows} valid)`);
}
for (const [k, seed] of [[6, 1], [7, 2], [10, 3]]) {   // one clean harmonic peak: only the removal stops it
  s = run(90, { harmonics: 0.02, dominant: [k, 0.4], seed });
  check(s.valid === 0, `dominant ${k}th harmonic (${9 * k} /min) not reported (${s.valid}/${s.windows} valid)`);
}

console.log("== heartbeat too weak (0.03 dB)");
s = run(90, { heartBpm: 70, heartDb: 0.03, seed: 8 });
check(s.bpm === null || Math.abs(s.bpm - 70) <= 2, `never a wrong rate (${s.bpm}, ${s.valid} valid)`);

console.log("== nobody: noise only");
s = run(90, { breathBpm: null, seed: 7 });
check(s.valid <= 0.1 * s.windows, `no heart reported (${s.valid}/${s.windows} valid)`);

console.log("== a person moving");
s = run(90, { heartBpm: 70, motion: true, seed: 9 });
check(s.valid <= 0.1 * s.windows, `motion blocks the estimate (${s.valid}/${s.windows} valid)`);

console.log(`\nheart.test ${failures ? "FAILED" : "PASSED"}: ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
