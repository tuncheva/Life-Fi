/**
 * Breathing rate from raw CSI, offline. TypeScript port of
 * engine/lifefi/breathing.py (same steps, constants and gates):
 *
 * 1. Amplitude in dB minus each packet's mean over subcarriers (cancels AGC).
 * 2. Split at gaps > 1 s; never bridge a gap.
 * 3. Box-average onto a 10 Hz grid (also the anti-alias low-pass).
 * 4. Per 30 s window, every 5 s: remove the linear trend, keep 0.1-0.5 Hz
 *    (6-30 /min), and pick the 8 subcarriers with the highest ratio of
 *    breathing-band power to 0.6-2 Hz power.
 * 5. PC1 of those subcarriers; FFT peak with 8x zero-padding and parabolic
 *    interpolation gives the rate; autocorrelation cross-checks it.
 * 6. `valid` only when the rhythm is clear: peak share >= MIN_CONFIDENCE,
 *    band ratio >= MIN_BAND_RATIO, FFT and autocorrelation agree, and a
 *    peak at the 6 /min edge is not just slow drift leaking into the band.
 *
 * Only the DFT bins that are used are computed, so no FFT library is needed.
 * Frequencies follow numpy's rfftfreq exactly (k / (n * d) in float64), so the
 * band edges select the same bins as the Python version.
 *
 * Assumes one person, still, near the link (plan-v2 §13). Not a medical
 * device.
 */

import { N_SUB, type CsiMatrix } from "./csirec.ts";
import { fixed } from "./format.ts";

export const FS = 10.0;                // analysis rate, Hz
export const WINDOW_S = 30.0;
export const STEP_S = 5.0;
export const MAX_GAP_S = 1.0;
export const BAND: [number, number] = [0.1, 0.5];       // 6-30 breaths/min
export const REF_BAND: [number, number] = [0.6, 2.0];   // motion / noise reference
export const TOP_SUBCARRIERS = 8;
export const MIN_CONFIDENCE = 0.4;     // [H] share of band power within +-0.02 Hz of the peak; E1 sweep (ml/tune_breathing.py)
export const MIN_BAND_RATIO = 2.0;     // [H] breathing band vs 0.6-2 Hz, mean of the top subcarriers; 1.5 lets motion through (TS motion test)
export const MAX_DISAGREE_BPM = 2.0;   // FFT vs autocorrelation

const PAD = 8;

export interface BreathWindow {
  tStart: number;       // s from the first packet
  bpm: number;
  confidence: number;
  bandRatio: number;
  acfBpm: number;
  valid: boolean;
  reason: string;       // why not valid ("" when valid)
}

export interface BreathSummary {
  windows: number;
  valid: number;
  bpm: number | null;
  spread: number | null;
  consistent: boolean;
}

/** numpy.fft.rfftfreq(n, 1 / fs)[k] */
export function freq(k: number, n: number, fs = FS): number {
  return k * (1.0 / (n * (1.0 / fs)));
}

/** Bins k (of an n-point rfft) whose frequency lies in [lo, hi]. */
export function bins(n: number, [lo, hi]: [number, number], fs = FS): number[] {
  const out: number[] = [];
  for (let k = 0; k <= n / 2; k++) {
    const f = freq(k, n, fs);
    if (f >= lo && f <= hi) out.push(k);
  }
  return out;
}

/** numpy.hanning(m) */
export function hanning(m: number): Float64Array {
  const w = new Float64Array(m);
  for (let i = 0; i < m; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1));
  return w;
}

/** One DFT bin k of x zero-padded to n points: [re, im]. */
function dft(x: ArrayLike<number>, k: number, n: number): [number, number] {
  let re = 0;
  let im = 0;
  const step = (2 * Math.PI * k) / n;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(step * i);
    im -= x[i] * Math.sin(step * i);
  }
  return [re, im];
}

function power(x: ArrayLike<number>, k: number, n: number): number {
  const [re, im] = dft(x, k, n);
  return re * re + im * im;
}

/** Gain-free amplitude features [n][52] in dB, row-major. */
export function features(csi: CsiMatrix): Float64Array {
  const x = new Float64Array(csi.n * N_SUB);
  for (let r = 0; r < csi.n; r++) {
    let mean = 0;
    for (let c = 0; c < N_SUB; c++) {
      const i = r * N_SUB + c;
      x[i] = 20.0 * Math.log10(Math.hypot(csi.re[i], csi.im[i]) + 1.0);
      mean += x[i];
    }
    mean /= N_SUB;
    for (let c = 0; c < N_SUB; c++) x[r * N_SUB + c] -= mean;
  }
  return x;
}

export function segments(t: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  let s = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > MAX_GAP_S) {
      out.push([s, i]);
      s = i;
    }
  }
  out.push([s, t.length]);
  return out;
}

/** numpy.searchsorted(t, v, side="left") within t[s:e], relative to s. */
function searchsorted(t: Float64Array, s: number, e: number, v: number): number {
  let lo = s;
  let hi = e;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo - s;
}

/** Box average over +-0.5/fs around each grid point; interpolate empty bins. Columns [52][grid]. */
export function resample(t: Float64Array, x: Float64Array, s: number, e: number, fs = FS): { grid: Float64Array; y: Float64Array[] } | null {
  const t0 = t[s];
  const t1 = t[e - 1];
  const len = Math.ceil((t1 - t0) / (1.0 / fs));
  const grid = new Float64Array(len);
  for (let g = 0; g < len; g++) grid[g] = t0 + g * (1.0 / fs);
  const n = e - s;
  const cum = new Float64Array((n + 1) * N_SUB);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < N_SUB; c++) cum[(r + 1) * N_SUB + c] = cum[r * N_SUB + c] + x[(s + r) * N_SUB + c];
  }
  const y = Array.from({ length: N_SUB }, () => new Float64Array(len).fill(NaN));
  for (let g = 0; g < len; g++) {
    const lo = searchsorted(t, s, e, grid[g] - 0.5 / fs);
    const hi = searchsorted(t, s, e, grid[g] + 0.5 / fs);
    if (hi <= lo) continue;
    for (let c = 0; c < N_SUB; c++) y[c][g] = (cum[hi * N_SUB + c] - cum[lo * N_SUB + c]) / (hi - lo);
  }
  for (const col of y) {
    const good: number[] = [];
    col.forEach((v, g) => { if (!Number.isNaN(v)) good.push(g); });
    if (good.length === 0) return null;
    let j = 0;
    for (let g = 0; g < len; g++) {
      if (!Number.isNaN(col[g])) continue;
      while (j < good.length - 1 && good[j + 1] < g) j++;
      if (g < good[0]) col[g] = col[good[0]];          // np.interp clamps at the ends
      else if (g > good[good.length - 1]) col[g] = col[good[good.length - 1]];
      else {
        const a = good[j];
        const b = good[j + 1];
        col[g] = col[a] + ((col[b] - col[a]) * (grid[g] - grid[a])) / (grid[b] - grid[a]);
      }
    }
  }
  return { grid, y };
}

export function detrend(x: Float64Array): Float64Array {
  const n = x.length;
  const xm = (n - 1) / 2;
  let ym = 0;
  for (const v of x) ym += v;
  ym /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xm) * (x[i] - ym);
    sxx += (i - xm) * (i - xm);
  }
  const slope = sxy / sxx;
  return x.map((v, i) => v - (ym + slope * (i - xm)));
}

/** Eigenvector of the largest eigenvalue of a symmetric matrix (cyclic Jacobi). */
export function topEigenvector(a: number[][]): number[] {
  const m = a.length;
  const A = a.map((row) => row.slice());
  const V: number[][] = A.map((_, i) => A.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) off += A[p][q] * A[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < m; p++) {
      for (let q = p + 1; q < m; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tt * tt + 1);
        const s = tt * c;
        for (let k = 0; k < m; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < m; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < m; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < m; i++) if (A[i][i] > A[best][best]) best = i;
  return V.map((row) => row[best]);
}

export function fftPeak(sig: Float64Array, band: [number, number] = BAND, fs = FS): [number, number] {
  const n = PAD * sig.length;
  const w = hanning(sig.length);
  const xw = sig.map((v, i) => v * w[i]);
  const b = bins(n, band, fs);
  const spec = new Map<number, number>();
  for (let k = b[0] - 1; k <= b[b.length - 1] + 1; k++) spec.set(k, power(xw, k, n));
  let i = b[0];
  for (const k of b) if (spec.get(k)! > spec.get(i)!) i = k;
  // parabolic interpolation on the log magnitude
  const [y0, y1, y2] = [i - 1, i, i + 1].map((k) => Math.log(spec.get(k)! + 1e-30));
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? (0.5 * (y0 - y2)) / den : 0.0;
  const peak = freq(i, n, fs) + shift * (freq(1, n, fs) - freq(0, n, fs));
  let near = 0;
  let total = 0;
  for (const k of b) {
    total += spec.get(k)!;
    if (Math.abs(freq(k, n, fs) - peak) <= 0.02) near += spec.get(k)!;
  }
  return [peak, near / (total + 1e-30)];
}

/** Nearest rfft bin of an n-point transform to frequency f (numpy argmin of |f_k - f|). */
function nearestBin(f: number, n: number): number {
  let best = 0;
  for (let k = 1; k <= n / 2; k++) {
    if (Math.abs(freq(k, n) - f) < Math.abs(freq(best, n) - f)) best = k;
  }
  return best;
}

/**
 * True when a peak near the low band edge is only slow drift leaking in.
 *
 * Body shifts and RSSI changes put most power at 1-4 /min. After the band
 * filter that leakage looks like a peak at the 6 /min edge, so a peak within
 * one resolution bin of the edge must beat the power one bin below the band
 * in the unfiltered signal.
 */
function driftAtEdge(sig: Float64Array, peak: number): boolean {
  if (peak - BAND[0] >= 1.0 / WINDOW_S) return false;
  const n = PAD * sig.length;
  const w = hanning(sig.length);
  const xw = sig.map((v, i) => v * w[i]);
  const below = power(xw, nearestBin(BAND[0] - 1.0 / WINDOW_S, n), n);
  return below > power(xw, nearestBin(peak, n), n);
}

function acfRate(sig: Float64Array): number {
  let mean = 0;
  for (const v of sig) mean += v;
  mean /= sig.length;
  const s = sig.map((v) => v - mean);
  const lo = Math.trunc(FS / BAND[1]);
  const hi = Math.trunc(FS / BAND[0]);   // periods of 2-10 s
  if (hi >= s.length) return NaN;
  let bestLag = lo;
  let best = -Infinity;
  for (let lag = lo; lag < hi; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < s.length; i++) acc += s[i] * s[i + lag];
    if (acc > best) {
      best = acc;
      bestLag = lag;
    }
  }
  return (60.0 * FS) / bestLag;
}

/** Breathing windows from packet timestamps (us) and LLTF CSI [n][52]. */
export function estimateBreathing(tsUs: ArrayLike<bigint | number>, csi: CsiMatrix): BreathWindow[] {
  const t0 = BigInt(tsUs[0]);
  const t = Float64Array.from({ length: csi.n }, (_, i) => Number(BigInt(tsUs[i]) - t0) / 1e6);
  const x = features(csi);
  const win = Math.trunc(WINDOW_S * FS);
  const step = Math.trunc(STEP_S * FS);
  const br = bins(win, BAND);
  const ref = bins(win, REF_BAND);
  const w = hanning(win);
  const out: BreathWindow[] = [];
  for (const [s, e] of segments(t)) {
    if (t[e - 1] - t[s] < WINDOW_S) continue;
    const r = resample(t, x, s, e);
    if (r === null) continue;
    const { grid, y } = r;
    for (let w0 = 0; w0 + win <= grid.length; w0 += step) {
      const seg = y.map((col) => detrend(col.subarray(w0, w0 + win)));
      const ratio = seg.map((col) => {
        const xw = col.map((v, i) => v * w[i]);
        let pb = 0;
        let pr = 0;
        for (const k of br) pb += power(xw, k, win);
        for (const k of ref) pr += power(xw, k, win);
        return pb / (pr + 1e-30);
      });
      const top = ratio.map((v, c) => [v, c]).sort((a, b) => a[0] - b[0]).slice(-TOP_SUBCARRIERS).map(([, c]) => c);
      // Keep only the breathing band (irfft of the band bins of the unwindowed rfft)
      const xb = top.map((c) => {
        const out = new Float64Array(win);
        for (const k of br) {
          const [re, im] = dft(seg[c], k, win);
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
      const v = topEigenvector(cov);
      const project = (cols: Float64Array[]) =>
        Float64Array.from({ length: win }, (_, i) => cols.reduce((acc, col, j) => acc + col[i] * v[j], 0));
      const pc1 = project(xb);
      const [peak, conf] = fftPeak(pc1);
      const bpm = 60.0 * peak;
      const acfBpm = acfRate(pc1);
      const bandRatio = top.reduce((acc, c) => acc + ratio[c], 0) / top.length;
      const reasons: string[] = [];
      if (conf < MIN_CONFIDENCE) reasons.push(`no clear peak (${fixed(conf, 2)})`);
      if (bandRatio < MIN_BAND_RATIO) reasons.push(`motion/noise (${fixed(bandRatio, 1)})`);
      if (!(Math.abs(acfBpm - bpm) <= MAX_DISAGREE_BPM)) reasons.push("FFT/ACF disagree");
      if (driftAtEdge(project(top.map((c) => seg[c])), peak)) reasons.push("drift at band edge");
      out.push({ tStart: grid[w0], bpm, confidence: conf, bandRatio, acfBpm, valid: reasons.length === 0, reason: reasons.join("; ") });
    }
  }
  return out;
}

/**
 * Median rate over valid windows, the share that are valid, and whether
 * they agree (a median of two rate groups is not a breathing rate).
 */
export function summarize(windows: BreathWindow[]): BreathSummary {
  const valid = windows.filter((w) => w.valid).map((w) => w.bpm).sort((a, b) => a - b);
  const m = valid.length;
  const median = m === 0 ? null : m % 2 ? valid[(m - 1) / 2] : (valid[m / 2 - 1] + valid[m / 2]) / 2;
  const spread = m === 0 ? null : valid[m - 1] - valid[0];
  return {
    windows: windows.length,
    valid: m,
    bpm: median,
    spread,
    consistent: spread !== null && spread <= 2 * MAX_DISAGREE_BPM,
  };
}
