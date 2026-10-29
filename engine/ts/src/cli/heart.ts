/**
 * Heart rate per 30 s window of a .csirec recording. EXPERIMENTAL.
 *
 *   node engine/ts/src/cli/heart.ts firmware/recordings/<file>.csirec
 *
 * TypeScript port of engine/tools/heart.py; same output. Prints "no heart
 * signal" rather than a guess.
 */

import { loadCsirec } from "../csirec.ts";
import { WINDOW_S, estimateHeart, summarize } from "../heart.ts";
import { fixed } from "../format.ts";

/** Right-aligned fixed-point number, like Python's f"{v:{width}.{digits}f}". */
function f(v: number, width: number, digits: number): string {
  return fixed(v, digits).padStart(width);
}

function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.log("usage: node engine/ts/src/cli/heart.ts <recording.csirec>");
    return 2;
  }
  const d = loadCsirec(argv[0]);
  if (d.csi.n < 2) {
    console.log("no frames in the recording");
    return 1;
  }
  const windows = estimateHeart(d.tsUs, d.csi);
  if (windows.length === 0) {
    console.log(`no continuous stretch of ${fixed(WINDOW_S, 0)} s (Wi-Fi pauses split the recording)`);
    return 1;
  }
  console.log("   t      bpm    snr  conf    acf  breath   result");
  for (const w of windows) {
    const result = w.valid ? "VALID" : w.reason;
    console.log(`${f(w.tStart, 5, 0)}s  ${f(w.bpm, 5, 1)}  ${f(w.snr, 5, 1)}  ${f(w.confidence, 4, 2)}  ${f(w.acfBpm, 5, 1)}  ${f(w.breathBpm, 5, 1)}   ${result}`);
  }
  const s = summarize(windows);
  if (s.bpm === null && s.valid) {
    console.log(`\nno heart signal: too few valid windows (${s.valid}/${s.windows})`);
  } else if (s.bpm === null) {
    console.log(`\nno heart signal in ${s.windows} windows (experimental; see engine/README.md)`);
  } else if (!s.consistent) {
    const rates = windows.filter((w) => w.valid).map((w) => w.bpm).sort((a, b) => a - b);
    console.log(`\nno consistent rate: ${s.valid}/${s.windows} valid windows range ` +
      `${fixed(rates[0], 1)}-${fixed(rates[rates.length - 1], 1)} /min`);
  } else {
    console.log(`\nheart ${fixed(s.bpm, 1)} /min (median of ${s.valid}/${s.windows} valid windows; ` +
      "experimental, check against a pulse sensor)");
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
