// Writes src/ml/__fixtures__/oracles.json: outputs of the bake-off reference implementation (geometry, pre-processing,
// decoders) on the deterministic inputs of src/ml/__fixtures__/synthetic.ts. The oracle tests in src/ml/ run the
// TypeScript ports on the same inputs and compare. Run once after changing synthetic.ts or the reference:
//   VBT_BAKEOFF_TOOLS=/path/to/bakeoff-tools node scripts/ml/make-oracles.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  syntheticDetections,
  syntheticDetectorOutputs,
  syntheticImage,
  syntheticPersons,
  syntheticSimcc,
} from '../../src/ml/__fixtures__/synthetic.ts';

const tools = process.env.VBT_BAKEOFF_TOOLS;
if (!tools) {
  console.error('set VBT_BAKEOFF_TOOLS to the bake-off tools directory (the one with src/geometry.mjs)');
  process.exit(2);
}
const ref = (rel) => import(pathToFileURL(join(tools, rel)).href);
const geometry = await ref('src/geometry.mjs');
const imageops = await ref('src/imageops.mjs');
const vballnet = await ref('src/models/vballnet.mjs');
const detr = await ref('src/models/detr.mjs');
const rtmpose = await ref('src/models/rtmpose.mjs');

// node/cadence.mjs runs its simulation at import time, so its `propagate` is copied here verbatim
// (PAD = 0.1 and KP_THR = 0.3 are the script's defaults).
const PAD = 0.1;
const KP_THR = 0.3;
const MIN_JOINTS = 4;
function propagate(persons, W, H) {
  const out = [];
  for (const p of persons) {
    const v = p.kps.filter((k) => k[2] >= KP_THR);
    if (v.length < MIN_JOINTS) continue; // track lost: wait for the next detection
    let x0 = Math.min(...v.map((k) => k[0])),
      x1 = Math.max(...v.map((k) => k[0]));
    let y0 = Math.min(...v.map((k) => k[1])),
      y1 = Math.max(...v.map((k) => k[1]));
    const w = x1 - x0,
      h = y1 - y0;
    x0 = Math.max(0, x0 - PAD * w);
    x1 = Math.min(W, x1 + PAD * w);
    y0 = Math.max(0, y0 - PAD * h);
    y1 = Math.min(H, y1 + PAD * h);
    if (y1 - y0 < 8 || x1 - x0 < 4) continue;
    const meanKp = v.reduce((a, k) => a + k[2], 0) / v.length;
    out.push({ box: [x0, y0, x1, y1], score: p.score * Math.min(1, meanKp) });
  }
  // two tracks collapsing onto one person: keep the higher-scoring one
  out.sort((a, b) => b.score - a.score);
  return out.filter((b, i) => out.slice(0, i).every((a) => geometry.iou(a.box, b.box) < 0.7));
}

const W = 1280;
const H = 720;
const indicesOf = (all, kept) => kept.map((k) => all.indexOf(k));

function geometryOracles() {
  const dets = syntheticDetections(1, 12, W, H);
  const iou = [];
  for (let i = 0; i < dets.length; i++)
    for (let j = i + 1; j < dets.length; j += 3) iou.push([i, j, geometry.iou(dets[i].box, dets[j].box)]);
  const nms = [0.3, 0.5, 0.7].map((threshold) => ({ threshold, keep: indicesOf(dets, geometry.nms(dets, threshold)) }));
  const bboxToCS = dets.map((d) => geometry.bboxToCS(d.box, 192 / 256, 1.25));

  const persons = syntheticPersons(2, 40, W, H, 0.4);
  const oksPair = [];
  for (let i = 0; i < persons.length; i++)
    for (let j = 0; j < persons.length; j += 4) oksPair.push([i, j, geometry.oksPair(persons[i], persons[j])]);
  const boxFromKps = [0, 0.3, 0.7].map((threshold) => ({
    threshold,
    boxes: persons.map((p) => geometry.boxFromKps(p.kps, threshold)),
  }));
  // Persons partly outside the frame exercise the clamping.
  const propagated = propagate(syntheticPersons(3, 30, W * 1.1, H * 1.1, 0.5), W, H);
  return {
    detections: { seed: 1, clusters: 12, width: W, height: H },
    persons: { seed: 2, count: 40, width: W, height: H, duplicateFraction: 0.4 },
    propagateInput: { seed: 3, count: 30, width: W * 1.1, height: H * 1.1, duplicateFraction: 0.5, frame: [W, H] },
    iou,
    nms,
    bboxToCS,
    oksPair,
    boxFromKps,
    propagate: propagated,
  };
}

// Pre-processing. The reference has no rotation, so the oracle rotates the pixels clockwise by 90 degrees a few times
// and samples the rotated image; the port samples the original pixels with a rotation argument.
const ROTATIONS = [0, 90, 180, 270];
const f32 = Math.fround;

function rotateClockwise(img) {
  const { W, H, C, data } = img;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < H; x++)
      for (let c = 0; c < C; c++) out[(y * H + x) * C + c] = data[((H - 1 - x) * W + y) * C + c];
  return { data: out, W: H, H: W, C };
}

function rotated(img, rotation) {
  let out = img;
  for (let i = 0; i < rotation / 90; i++) out = rotateClockwise(out);
  return out;
}

const toRef = (img) => ({ data: img.data, W: img.width, H: img.height, C: img.channels });
const round = (a) => Array.from(a, (v) => f32(v));

function preprocessOracles() {
  const images = [
    { seed: 11, width: 41, height: 29, channels: 3 },
    { seed: 12, width: 37, height: 53, channels: 4 },
  ];
  const resize = { outW: 16, outH: 16 };
  // Centre, size: one inside the frame, one hanging over the right and bottom edges, one over the top-left corner.
  // Expressed as fractions of the display size so they apply to every rotation.
  const crops = [
    { cx: 0.5, cy: 0.5, w: 0.6, h: 0.8 },
    { cx: 0.95, cy: 0.9, w: 0.5, h: 0.7 },
    { cx: 0.02, cy: 0.05, w: 0.4, h: 0.5 },
  ];
  const cropOut = { outW: 12, outH: 16 };
  const gray = { outW: 512, outH: 288, stride: 97 };
  const cases = [];
  for (const spec of images) {
    const coded = syntheticImage(spec.seed, spec.width, spec.height, spec.channels);
    for (const rotation of ROTATIONS) {
      const ref = rotated(toRef(coded), rotation);
      const resized = new Float32Array(3 * resize.outW * resize.outH);
      imageops.sampleToCHW(
        ref,
        resized,
        0,
        resize.outW,
        resize.outH,
        imageops.mapResize(0, 0, ref.W, ref.H, resize.outW, resize.outH),
        {
          mean: imageops.NORM.unit.mean,
          std: imageops.NORM.unit.std,
          border: 'replicate',
        },
      );
      const cropped = crops.map((c) => {
        const cs = { cx: c.cx * ref.W, cy: c.cy * ref.H, w: c.w * ref.W, h: c.h * ref.H };
        const out = new Float32Array(3 * cropOut.outW * cropOut.outH);
        imageops.sampleToCHW(
          ref,
          out,
          0,
          cropOut.outW,
          cropOut.outH,
          imageops.mapAffineCrop(cs, cropOut.outW, cropOut.outH),
          {
            mean: imageops.NORM.imagenet.mean,
            std: imageops.NORM.imagenet.std,
            border: 'constant',
            borderValue: 0,
          },
        );
        return round(out);
      });
      const grayPlane = new Float32Array(gray.outW * gray.outH);
      vballnet.grayInto(ref, grayPlane, 0);
      const sampled = [];
      for (let i = 0; i < grayPlane.length; i += gray.stride) sampled.push(f32(grayPlane[i]));
      cases.push({ image: spec, rotation, resized: round(resized), cropped, gray: sampled });
    }
  }
  return { resize, crops, cropOut, gray, cases };
}

// Decoders. The reference VballNet decode keeps one intensity-weighted peak window per frame, while the port decodes
// several blobs, so the ball decoder is tested against hand-computed cases instead.
function decoderOracles() {
  const frame = { width: 1280, height: 720 };
  const detector = { seed: 21, batch: 2, minPersonScore: 0.15, nmsIou: 0.7, minBoxHeightPx: 8, minBallScore: 0.25 };
  const out = syntheticDetectorOutputs(detector.seed, detector.batch);
  const items = [];
  for (let item = 0; item < detector.batch; item++) {
    const logits = out.logits.subarray(item * out.queries * out.classes, (item + 1) * out.queries * out.classes);
    const boxes = out.boxes.subarray(item * out.queries * 4, (item + 1) * out.queries * 4);
    const decoded = detr.decodeDetr(
      logits,
      [1, out.queries, out.classes],
      boxes,
      { W: frame.width, H: frame.height },
      { personIdx: 0, ballIdx: 32 },
      {
        scoreThr: detector.minPersonScore,
        ballThr: detector.minBallScore,
        nmsThr: detector.nmsIou,
        minBoxH: detector.minBoxHeightPx,
      },
    );
    items.push(decoded);
  }

  const pose = { seed: 22, batch: 8, count: 5, region: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 } };
  const regions = Array.from({ length: pose.count }, (_, i) => ({
    cx: 100 + 150 * i,
    cy: 200 + 40 * i,
    w: 90 + 7 * i,
    h: (90 + 7 * i) / 0.75,
  }));
  const simcc = syntheticSimcc(pose.seed, pose.batch);
  const decodedPose = rtmpose.decodeRtmpose(
    simcc.simccX,
    simcc.simccY,
    [pose.batch, 26, 384],
    [pose.batch, 26, 512],
    { cs: regions, n: pose.count, flip: false },
    { inW: 192, inH: 256, split: 2 },
  );
  return {
    frame,
    detector,
    items,
    pose: { ...pose, regions, keypoints: decodedPose.map((kps) => kps.flat().map(f32)) },
  };
}

const oracles = {
  generator: 'scripts/ml/make-oracles.mjs',
  geometry: geometryOracles(),
  preprocess: preprocessOracles(),
  decoders: decoderOracles(),
};
const out = fileURLToPath(new URL('../../src/ml/__fixtures__/oracles.json', import.meta.url));
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(oracles)}\n`);
console.log(`wrote ${out}`);
