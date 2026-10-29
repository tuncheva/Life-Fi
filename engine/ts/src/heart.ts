/**
 * Heart rate from raw CSI, offline. EXPERIMENTAL. TypeScript port of
 * engine/lifefi/heart.py (same steps, constants and gates):
 *
 * Same skeleton as breathing.ts, at 20 Hz and in the 0.75-2 Hz band
 * (45-120 /min), with two extra protections found on real data (2026-10-28):
 *
 * - Breathing is not a pure sine. Its harmonics (a 9 /min breath has them at
 *   54, 63, ..., 117 /min) land in the heart band and are often stronger than
 *   any pulse. Per window the breathing fundamental fb is estimated with the
 *   breathing pipeline. Sinusoids at k*fb are fitted and subtracted, and
 *   every bin within NOTCH_HZ of k*fb is also removed before the subcarrier
 *   choice, the PCA and the peak search.
 * - A single ESP32 antenna is near its limit for 0.1-0.5 mm chest motion, so
 *   a "largest peak" on a flat noise floor is meaningless. `valid` needs the
 *   peak to stand MIN_SNR above the mean of the remaining band, away from its
 *   edges and at least HARMONIC_GUARD_HZ (3.6 /min) from a breathing
 *   harmonic: a sweep showed closer peaks are pulled by leakage (errors up to
 *   2.4 /min), the resolution limit of a 30 s window. Depending on the
 *   breathing rate this leaves 20-40 % of the band measurable.
 *
 * Validate against a pulse sensor before trusting any number. Not a medical
 * device.
 */

import type { CsiMatrix } from "./csirec.ts";
import * as B from "./breathing.ts";
import { fixed } from "./format.ts";

export const FS = 20.0;                 // analysis rate, Hz
export const WINDOW_S = 30.0;
export const STEP_S = 5.0;
export const BAND: [number, number] = [0.75, 2.0];      // 45-120 /min
export const REF_BAND: [number, number] = [2.5, 5.0];   // noise reference above the heart band
export const TOP_SUBCARRIERS = 8;
export const NOTCH_HZ = 0.035;          // [H] around every breathing harmonic (about one 30 s bin each side)
export const HARMONIC_GUARD_HZ = 0.06;  // [H] peaks closer to a breathing harmonic are leakage-shifted (sweep, 2026-10-28)
export const PEAK_HALF_HZ = 0.05;       // "near the peak" for the confidence share
export const MIN_SNR = 6.0;             // [H] peak vs mean power of the allowed band (pure noise: ~4)
export const MIN_CONFIDENCE = 0.35;     // [H] share of allowed band power near the peak
export const SECOND_PEAK_MAX = 0.5;     // [H] largest peak > 0.1 Hz away, relative to the main peak
export const MAX_DISAGREE_BPM = 5.0;    // FFT vs autocorrelation
export const CONSISTENT_BPM = 8.0;      // valid windows must agree within this to give a rate
export const MIN_VALID_SHARE = 0.3;     // [H] a rate needs at least this share of windows valid

const PAD = 8;

export interface HeartWindow {
  tStart: number;       // s from the first packet
  bpm: number;
  snr: number;
  confidence: number;
  acfBpm: number;
  breathBpm: number;    // breathing fundamental whose harmonics were removed
  valid: boolean;
  reason: string;       // why not valid ("" when valid)
}

export interface HeartSummary {
  windows: number;
  valid: number;
  bpm: number | null;
  spread: number | null;
  consistent: boolean;
}

/** DFT bins of real signals of length m zero-padded to n points, with a shared twiddle table. */
class Dft {
  private n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  constructor(n: number) {
    this.n = n;
    this.cos = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * i) / n));
    this.sin = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / n));
  }
  bin(x: ArrayLike<number>, k: number): [number, number] {
    let re = 0;
    let im = 0;
    for (let i = 0, idx = 0; i < x.length; i++, idx = (idx + k) % this.n) {
      re += x[i] * this.cos[idx];
      im -= x[i] * this.sin[idx];
    }
    return [re, im];
  }
  power(x: ArrayLike<number>, k: number): number {
    const [re, im] = this.bin(x, k);
    return re * re + im * im;
  }
}

/** True for frequency f within NOTCH_HZ of a harmonic k*fb (k >= 1). */
function nearHarmonic(f: number, fb: number): boolean {
  const k = Math.max(Math.round(f / fb), 1);
  return Math.abs(f - k * fb) <= NOTCH_HZ;
}

/**
 * Least-squares fit and subtract sinusoids at k*fb up to just above the
 * heart band, per subcarrier. Notching bins alone leaves a harmonic that
 * falls between two bins leaking into their neighbours as fake peaks.
 */
function removeHarmonics(seg: Float64Array[], fb: number): Float64Array[] {
  const win = seg[0].length;
  const kMax = Math.trunc((BAND[1] + 0.1) / fb);
  const cols: Float64Array[] = [];
  for (const trig of [Math.cos, Math.sin]) {
    for (let k = 1; k <= kMax; k++) {
      cols.push(Float64Array.from({ length: win }, (_, i) => trig(2 * Math.PI * (i / FS) * (k * fb))));
    }
  }
  const m = cols.length;
  const ata = cols.map((a) => cols.map((b) => a.reduce((acc, v, i) => acc + v * b[i], 0)));
  return seg.map((y) => {
    // normal equations, Gaussian elimination with partial pivoting
    const M = ata.map((row, r) => [...row, cols[r].reduce((acc, v, i) => acc + v * y[i], 0)]);
    for (let c = 0; c < m; c++) {
      let p = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < m; r++) {
        const fct = M[r][c] / M[c][c];
        for (let j = c; j <= m; j++) M[r][j] -= fct * M[c][j];
      }
    }
    const coef = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) {
      let acc = M[r][m];
      for (let j = r + 1; j < m; j++) acc -= M[r][j] * coef[j];
      coef[r] = acc / M[r][r];
    }
    return y.map((v, i) => v - cols.reduce((acc, col, j) => acc + col[i] * coef[j], 0));
  });
}

/** Windowed power of every column at the bins `ks`: Map k -> per-column power. */
function columnPowers(seg: Float64Array[], ks: Iterable<number>, dft: Dft, w: Float64Array): Map<number, Float64Array> {
  const xw = seg.map((col) => col.map((v, i) => v * w[i]));
  const out = new Map<number, Float64Array>();
  for (const k of ks) out.set(k, Float64Array.from(xw, (col) => dft.power(col, k)));
  return out;
}

/** PC1 of the top subcarriers (by `keep` vs `ref` power), band-limited to `keep`; and the top. */
function bandPc1(seg: Float64Array[], spec: Map<number, Float64Array>, keep: number[], ref: number[], dft: Dft): [Float64Array, number[]] {
  const win = seg[0].length;
  const ratio = seg.map((_, c) => {
    let pk = 0;
    let pr = 0;
    for (const k of keep) pk += spec.get(k)![c];
    for (const k of ref) pr += spec.get(k)![c];
    return pk / (pr + 1e-30);
  });
  const top = ratio.map((v, c) => [v, c]).sort((a, b) => a[0] - b[0]).slice(-TOP_SUBCARRIERS).map(([, c]) => c);
  const xb = top.map((c) => {
    const out = new Float64Array(win);
    for (const k of keep) {
      const [re, im] = dft.bin(seg[c], k);
      for (let i = 0; i < win; i++) {
        const a = (2 * Math.PI * k * i) / win;
        out[i] += (2 / win) * (re * Math.cos(a) - im * Math.sin(a));
      }
    }
    return out;
  });
  const means = xb.map((col) => col.reduce((acc, v) => acc + v, 0) / win);
  const cov = xb.map((ci, i) => xb.map((cj, j) => {
    let acc = 0;
    for (let k = 0; k < win; k++) acc += (ci[k] - means[i]) * (cj[k] - means[j]);
    return acc;
  }));
  const v = B.topEigenvector(cov);
  return [Float64Array.from({ length: win }, (_, i) => xb.reduce((acc, col, j) => acc + col[i] * v[j], 0)), top];
}

/**
 * breathing.ts's band ratio (breathing band vs 0.6-2 Hz, summed) for the
 * breathing subcarriers, with the breathing harmonics left out of the
 * reference: they are breathing, not movement. Per-bin powers are scaled
 * back to the full reference width so breathing's MIN_BAND_RATIO still applies.
 */
function motionRatio(spec: Map<number, Float64Array>, top: number[], br: number[], brRef: number[], notched: (k: number) => boolean): number {
  const ref = brRef.filter((k) => !notched(k));
  const mean = (ks: number[], c: number) => ks.reduce((acc, k) => acc + spec.get(k)![c], 0) / ks.length;
  const perBin = top.map((c) => mean(br, c) / (mean(ref, c) + 1e-30));
  return perBin.reduce((acc, v) => acc + (v * br.length) / brRef.length, 0) / perBin.length;
}

/** Rate from the autocorrelation maximum over the band's lags, parabolic-interpolated. */
function acfRate(sig: Float64Array): number {
  const mean = sig.reduce((acc, v) => acc + v, 0) / sig.length;
  const s = sig.map((v) => v - mean);
  const acf = (lag: number) => {
    let acc = 0;
    for (let i = 0; i + lag < s.length; i++) acc += s[i] * s[i + lag];
    return acc;
  };
  const lo = Math.trunc(FS / BAND[1]);
  const hi = Math.trunc(FS / BAND[0]);
  let lag = lo;
  let best = -Infinity;
  for (let l = lo; l < hi; l++) {
    const a = acf(l);
    if (a > best) {
      best = a;
      lag = l;
    }
  }
  const [y0, y1, y2] = [acf(lag - 1), acf(lag), acf(lag + 1)];
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0.0;
  return (60.0 * FS) / (lag + shift);
}

/** Heart windows from packet timestamps (us) and LLTF CSI [n][52]. */
export function estimateHeart(tsUs: ArrayLike<bigint | number>, csi: CsiMatrix): HeartWindow[] {
  const t0 = BigInt(tsUs[0]);
  const t = Float64Array.from({ length: csi.n }, (_, i) => Number(BigInt(tsUs[i]) - t0) / 1e6);
  const x = B.features(csi);
  const win = Math.trunc(WINDOW_S * FS);
  const step = Math.trunc(STEP_S * FS);
  const f = (k: number) => B.freq(k, win, FS);
  const br = B.bins(win, B.BAND, FS);
  const brRef = B.bins(win, B.REF_BAND, FS);
  const hb = B.bins(win, BAND, FS);
  const ref = B.bins(win, REF_BAND, FS);
  const n = PAD * win;
  const ff = (k: number) => B.freq(k, n, FS);
  const hbPad = B.bins(n, BAND, FS);
  const w = B.hanning(win);
  const dftWin = new Dft(win);
  const dftPad = new Dft(n);
  const allBins = [...new Set([...br, ...brRef, ...hb, ...ref])];
  const out: HeartWindow[] = [];
  for (const [s, e] of B.segments(t)) {
    if (t[e - 1] - t[s] < WINDOW_S) continue;
    const r = B.resample(t, x, s, e, FS);
    if (r === null) continue;
    const { grid, y } = r;
    for (let w0 = 0; w0 + win <= grid.length; w0 += step) {
      let seg = y.map((col) => B.detrend(col.subarray(w0, w0 + win)));
      let spec = columnPowers(seg, allBins, dftWin, w);
      const [pcb, topB] = bandPc1(seg, spec, br, brRef, dftWin);
      const [fb] = B.fftPeak(pcb, B.BAND, FS);
      const notched = (k: number) => nearHarmonic(f(k), fb);
      const breathRatio = motionRatio(spec, topB, br, brRef, notched);
      const keep = hb.filter((k) => !notched(k));
      seg = removeHarmonics(seg, fb);
      spec = columnPowers(seg, [...new Set([...keep, ...ref])], dftWin, w);
      const [pc1] = bandPc1(seg, spec, keep, ref, dftWin);
      const pw = pc1.map((v, i) => v * w[i]);
      const allowed = hbPad.filter((k) => !nearHarmonic(ff(k), fb));
      const ps = new Map<number, number>();
      for (const k of allowed) ps.set(k, dftPad.power(pw, k));
      let i = allowed[0];
      for (const k of allowed) if (ps.get(k)! > ps.get(i)!) i = k;
      for (const k of [i - 1, i + 1]) if (!ps.has(k)) ps.set(k, dftPad.power(pw, k));
      const [y0, y1, y2] = [i - 1, i, i + 1].map((k) => Math.log(ps.get(k)! + 1e-30));
      const den = y0 - 2 * y1 + y2;
      const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0.0;
      const peak = ff(i) + shift * (ff(1) - ff(0));
      const pa = allowed.map((k) => ps.get(k)!);
      const total = pa.reduce((acc, v) => acc + v, 0);
      const snr = ps.get(i)! / (total / pa.length + 1e-30);
      // A true peak has allowed bins on both sides. At a band or notch edge it is
      // leakage, or a pulse within ~2 /min of a breathing harmonic, which
      // a 30 s window cannot separate from it.
      const atEdge = !allowed.includes(i - 1) || !allowed.includes(i + 1);
      let near = 0;
      let far = 0;
      let anyFar = false;
      allowed.forEach((k, j) => {
        const d = Math.abs(ff(k) - peak);
        if (d <= PEAK_HALF_HZ) near += pa[j];
        if (d > 0.1) {
          far = Math.max(far, pa[j]);
          anyFar = true;
        }
      });
      const conf = near / (total + 1e-30);
      const second = anyFar ? far / ps.get(i)! : 0.0;
      const bpm = 60.0 * peak;
      const harmonic = Math.max(Math.round(peak / fb), 1) * fb;
      const acfBpm = acfRate(pc1);
      const reasons: string[] = [];
      if (Math.abs(peak - harmonic) < HARMONIC_GUARD_HZ) reasons.push(`near breathing harmonic (${fixed(60 * harmonic, 0)})`);
      if (snr < MIN_SNR) reasons.push(`at noise floor (snr ${fixed(snr, 1)})`);
      if (atEdge) reasons.push("peak at band/notch edge");
      if (conf < MIN_CONFIDENCE) reasons.push(`no clear peak (${fixed(conf, 2)})`);
      if (second >= SECOND_PEAK_MAX) reasons.push(`several peaks (${fixed(second, 2)})`);
      if (!(Math.abs(acfBpm - bpm) <= MAX_DISAGREE_BPM)) reasons.push("FFT/ACF disagree");
      if (breathRatio < B.MIN_BAND_RATIO) reasons.push(`motion (${fixed(breathRatio, 1)})`);
      out.push({ tStart: grid[w0], bpm, snr, confidence: conf, acfBpm, breathBpm: 60.0 * fb, valid: reasons.length === 0, reason: reasons.join("; ") });
    }
  }
  return out;
}

/**
 * Median rate over valid windows (null below MIN_VALID_SHARE), the share
 * that are valid, and whether they agree.
 */
export function summarize(windows: HeartWindow[]): HeartSummary {
  const valid = windows.filter((w) => w.valid).map((w) => w.bpm).sort((a, b) => a - b);
  const m = valid.length;
  const median = m === 0 || m < MIN_VALID_SHARE * windows.length ? null : m % 2 ? valid[(m - 1) / 2] : (valid[m / 2 - 1] + valid[m / 2]) / 2;
  const spread = m === 0 ? null : valid[m - 1] - valid[0];
  return {
    windows: windows.length,
    valid: m,
    bpm: median,
    spread,
    consistent: spread !== null && spread <= CONSISTENT_BPM,
  };
}
