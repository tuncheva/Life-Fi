/**
 * Reader for .csirec recordings from firmware/tools/csi_recorder.py.
 *
 * Format (docs/plan/plan-v2.md §4.3):
 *   file   = "CSIR" + uint16 version=1 + uint16 reserved=0
 *   record = uint32 len + uint64 host_rx_us + packet[len]
 *   packet = csi_frame_hdr_t (54 bytes, firmware/src/csi_frame.h) + int8 CSI
 */

import { readFileSync } from "node:fs";

export const CSI_MAGIC = 0x31495343;
export const HDR_SIZE = 54;
export const N_SUB = 52;

/** Mirrors csi_frame_hdr_t (packed, little-endian). */
export interface CsiHeader {
  magic: number;
  version: number;
  hdrLen: number;
  nodeId: number;
  source: number;
  sigMode: number;
  mcs: number;
  cwb: number;
  stbc: number;
  firstWordInvalid: number;
  gainValid: number;
  agcGain: number;
  fftGain: number;
  rssiDbm: number;
  noiseFloorDbm: number;
  channel: number;
  secondaryChannel: number;
  srcMac: string;
  csiParts: number;
  csiShift: number;
  rxSeq: number;
  gainComp: number;
  bootId: number;
  tsUs: bigint;
  seq: number;
  nValues: number;
}

/** LLTF CSI, row-major [n][52], subcarriers k = -26..-1, +1..+26. */
export interface CsiMatrix {
  n: number;
  re: ArrayLike<number>;
  im: ArrayLike<number>;
}

export interface Recording {
  hostUs: BigUint64Array;
  tsUs: BigUint64Array;
  seq: Uint32Array;
  rssi: Int8Array;
  csi: CsiMatrix;
}

// Subcarrier k -> pair index j in one 64-pair LTF block, output order k = -26..-1, +1..+26
const LLTF_PAIRS = [...range(38, 64), ...range(1, 27)];

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a }, (_, i) => a + i);
}

/** Header plus the raw int8 CSI bytes, or null if it isn't a v2 CSI frame. */
export function parseFrame(packet: Uint8Array): { hdr: CsiHeader; data: Int8Array } | null {
  if (packet.length < HDR_SIZE) return null;
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const hdr: CsiHeader = {
    magic: v.getUint32(0, true),
    version: v.getUint16(4, true),
    hdrLen: v.getUint16(6, true),
    nodeId: v.getUint8(8),
    source: v.getUint8(9),
    sigMode: v.getUint8(10),
    mcs: v.getUint8(11),
    cwb: v.getUint8(12),
    stbc: v.getUint8(13),
    firstWordInvalid: v.getUint8(14),
    gainValid: v.getUint8(15),
    agcGain: v.getUint8(16),
    fftGain: v.getInt8(17),
    rssiDbm: v.getInt8(18),
    noiseFloorDbm: v.getInt8(19),
    channel: v.getUint8(20),
    secondaryChannel: v.getUint8(21),
    srcMac: Array.from(packet.subarray(22, 28), (b) => b.toString(16).padStart(2, "0")).join(":"),
    csiParts: v.getUint8(28),
    csiShift: v.getUint8(29),
    rxSeq: v.getUint16(30, true),
    gainComp: v.getFloat32(32, true),
    bootId: v.getUint32(36, true),
    tsUs: v.getBigUint64(40, true),
    seq: v.getUint32(48, true),
    nValues: v.getUint16(52, true),
  };
  if (hdr.magic !== CSI_MAGIC || hdr.version !== 2 || hdr.hdrLen !== HDR_SIZE) return null;
  if (packet.length < HDR_SIZE + hdr.nValues) return null;
  const data = new Int8Array(packet.buffer, packet.byteOffset + HDR_SIZE, hdr.nValues);
  return { hdr, data };
}

/** Writes the 52 LLTF subcarriers of one frame into re/im at row `row`. */
export function lltfInto(data: Int8Array, firstWordInvalid: number, re: Int8Array, im: Int8Array, row: number): void {
  const o = row * N_SUB;
  LLTF_PAIRS.forEach((j, i) => {
    im[o + i] = data[2 * j];
    re[o + i] = data[2 * j + 1];
  });
  if (firstWordInvalid) { // bytes 0..3 (DC and k = +1) are garbage
    re[o + 26] = re[o + 27];
    im[o + 26] = im[o + 27];
  }
}

/** (host_rx_us, packet) records of a .csirec file. */
export function* iterCsirec(buf: Uint8Array): Generator<[bigint, Uint8Array]> {
  const head = new TextDecoder().decode(buf.subarray(0, 4));
  if (head !== "CSIR") throw new Error("not a .csirec file");
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = v.getUint32(p, true);
    const hostUs = v.getBigUint64(p + 4, true);
    p += 12;
    if (p + len > buf.length) return;
    yield [hostUs, buf.subarray(p, p + len)];
    p += len;
  }
}

/**
 * Arrays for analysis. Amplitude is |csi|; phase from a single antenna
 * carries a random offset and slope per packet: sanitise it before use.
 */
export function loadCsirec(path: string): Recording {
  const frames: { hostUs: bigint; hdr: CsiHeader; data: Int8Array }[] = [];
  for (const [hostUs, packet] of iterCsirec(readFileSync(path))) {
    const parsed = parseFrame(packet);
    if (parsed === null) continue;
    const { hdr, data } = parsed;
    if (!(hdr.csiParts & 1) || hdr.cwb !== 0) continue;
    frames.push({ hostUs, hdr, data });
  }
  const n = frames.length;
  const rec: Recording = {
    hostUs: new BigUint64Array(n),
    tsUs: new BigUint64Array(n),
    seq: new Uint32Array(n),
    rssi: new Int8Array(n),
    csi: { n, re: new Int8Array(n * N_SUB), im: new Int8Array(n * N_SUB) },
  };
  frames.forEach(({ hostUs, hdr, data }, i) => {
    rec.hostUs[i] = hostUs;
    rec.tsUs[i] = hdr.tsUs;
    rec.seq[i] = hdr.seq;
    rec.rssi[i] = hdr.rssiDbm;
    lltfInto(data, hdr.firstWordInvalid, rec.csi.re as Int8Array, rec.csi.im as Int8Array, i);
  });
  return rec;
}
