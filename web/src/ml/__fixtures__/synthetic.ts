/**
 * Deterministic synthetic inputs shared by `scripts/ml/make-oracles.mjs` (which runs the bake-off reference code on
 * them and stores the outputs in `oracles.json`) and the oracle tests (which run the ports on the same inputs).
 * Node loads this file directly (type stripping), so it has no imports and uses only erasable TypeScript.
 * Every coordinate is rounded to float32 so the double-precision reference and the Float32Array ports see the same
 * numbers.
 */

export type Rng = () => number;
export type SyntheticBox = [number, number, number, number];

export interface SyntheticDetection {
  box: SyntheticBox;
  score: number;
}

/** Bake-off person layout: keypoints as [x, y, score] rows (26 Halpe joints). */
export interface SyntheticPerson extends SyntheticDetection {
  kps: [number, number, number][];
}

const f32 = Math.fround;

/** mulberry32: uniform floats in [0, 1) from a 32-bit seed. */
export function rng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBox(r: Rng, width: number, height: number): SyntheticBox {
  const h = 20 + r() * 0.5 * height;
  const w = h * (0.25 + r() * 0.6);
  const x0 = r() * (width - w);
  const y0 = r() * (height - h);
  return [f32(x0), f32(y0), f32(x0 + w), f32(y0 + h)];
}

function jitterBox(r: Rng, box: SyntheticBox, amount: number): SyntheticBox {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const j = (size: number) => (r() - 0.5) * 2 * amount * size;
  return [f32(box[0] + j(w)), f32(box[1] + j(h)), f32(box[2] + j(w)), f32(box[3] + j(h))];
}

/** Boxes in overlapping clusters (2-4 near-copies each), for NMS. */
export function syntheticDetections(seed: number, clusters: number, width: number, height: number) {
  const r = rng(seed);
  const out: SyntheticDetection[] = [];
  for (let c = 0; c < clusters; c++) {
    const base = randomBox(r, width, height);
    const copies = 2 + Math.floor(r() * 3);
    for (let i = 0; i < copies; i++)
      out.push({ box: i === 0 ? base : jitterBox(r, base, 0.15), score: f32(0.15 + 0.85 * r()) });
  }
  return out;
}

function randomPerson(r: Rng, box: SyntheticBox): SyntheticPerson {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const kps: [number, number, number][] = [];
  for (let k = 0; k < 26; k++) kps.push([f32(box[0] + r() * w), f32(box[1] + r() * h), f32(r())]);
  return { box, score: f32(0.3 + 0.7 * r()), kps };
}

/**
 * Persons with keypoints inside their boxes. About `duplicateFraction` of them are near-copies of the previous person
 * (box and keypoints moved by a few percent of the box size), which is what D-FINE's double boxes look like.
 */
export function syntheticPersons(
  seed: number,
  count: number,
  width: number,
  height: number,
  duplicateFraction = 0.3,
): SyntheticPerson[] {
  const r = rng(seed);
  const out: SyntheticPerson[] = [];
  for (let i = 0; i < count; i++) {
    const prev = out[out.length - 1];
    if (prev !== undefined && r() < duplicateFraction) {
      const box = jitterBox(r, prev.box, 0.05);
      const h = box[3] - box[1];
      const kps = prev.kps.map(([x, y, s]): [number, number, number] => [
        f32(x + (r() - 0.5) * 0.04 * h),
        f32(y + (r() - 0.5) * 0.04 * h),
        f32(Math.min(1, Math.max(0, s + (r() - 0.5) * 0.2))),
      ]);
      out.push({ box, score: f32(0.3 + 0.7 * r()), kps });
    } else {
      out.push(randomPerson(r, randomBox(r, width, height)));
    }
  }
  return out;
}

/** Interleaved 8-bit noise image (3 or 4 channels), for the pre-processing oracles. */
export function syntheticImage(seed: number, width: number, height: number, channels: 3 | 4) {
  const r = rng(seed);
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  return { data, width, height, channels };
}

/**
 * D-FINE outputs for `batch` frames: logits [batch, 300, 80] (a few confident persons and balls, the rest background,
 * with person/ball ambiguity on some queries) and normalised cx, cy, w, h boxes [batch, 300, 4]. Boxes come in
 * near-duplicate pairs, as the real model produces them.
 */
export function syntheticDetectorOutputs(seed: number, batch: number) {
  const r = rng(seed);
  const queries = 300;
  const classes = 80;
  const logits = new Float32Array(batch * queries * classes);
  const boxes = new Float32Array(batch * queries * 4);
  for (let q = 0; q < batch * queries; q++) {
    for (let c = 0; c < classes; c++) logits[q * classes + c] = f32(-8 + r() * 3);
    const kind = r();
    const pair = q > 0 && kind < 0.15;
    if (kind < 0.3) logits[q * classes] = f32(-2.5 + r() * 6);
    if (kind > 0.85) logits[q * classes + 32] = f32(-2 + r() * 5);
    if (kind > 0.28 && kind < 0.32) logits[q * classes + 32] = f32(r() * 2);
    if (pair) {
      for (let k = 0; k < 4; k++) boxes[q * 4 + k] = f32((boxes[(q - 1) * 4 + k] as number) + (r() - 0.5) * 0.01);
    } else {
      const h = 0.01 + r() * 0.4;
      const w = h * (0.2 + r() * 0.5);
      boxes.set([f32(w / 2 + r() * (1 - w)), f32(h / 2 + r() * (1 - h)), f32(w), f32(h)], q * 4);
    }
  }
  return { logits, boxes, queries, classes };
}

/** RTMPose SimCC outputs for `batch` crops: simcc_x [batch, 26, 384], simcc_y [batch, 26, 512] noise with one peak per joint. */
export function syntheticSimcc(seed: number, batch: number) {
  const r = rng(seed);
  const make = (length: number) => {
    const out = new Float32Array(batch * 26 * length);
    for (let i = 0; i < out.length; i++) out[i] = f32(r() * 2);
    for (let row = 0; row < batch * 26; row++) out[row * length + Math.floor(r() * length)] = f32(2 + r() * 8);
    return out;
  };
  return { simccX: make(384), simccY: make(512) };
}
