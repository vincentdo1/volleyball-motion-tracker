/**
 * Box and pose geometry: IoU, greedy NMS, the MMPose top-down crop (`bbox_xyxy2cs`), OKS, OKS-NMS, boxes from
 * keypoints and the keypoint-box propagation used between detector frames. Ports of the bake-off `src/geometry.mjs`
 * and `propagate()` from `node/cadence.mjs`; `geometry.test.ts` checks them against values those files produce.
 * Boxes are [x0, y0, x1, y1] in display pixels; keypoints are packed (x, y, score) per Halpe26 joint, NaN when missing.
 */
import { COCO17_NUM_KEYPOINTS, HALPE26_NUM_KEYPOINTS, HALPE26_SIGMAS, KP_VALUES } from '@/contracts/halpe26';
import type { RawPerson } from '@/contracts/pipeline';

export type Box = RawPerson['box'];

export interface ScoredBox {
  readonly box: Box;
  readonly score: number;
}

export interface Pose extends ScoredBox {
  /** Packed (x, y, score) per joint. */
  readonly keypoints: Float32Array;
}

/** Keypoints at or above this score count as visible (RTMPose scores are SimCC maxima, not probabilities). */
export const VISIBLE_SCORE = 0.3;
/** COCO: the segment area of a person is about 0.53 of its box area. */
const OKS_AREA_PER_BOX_AREA = 0.53;

export function boxArea(b: Box): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS: a box survives when its IoU with every kept, higher-scoring box is below `iouThreshold`. */
export function nms<T extends ScoredBox>(dets: readonly T[], iouThreshold: number): T[] {
  const keep: T[] = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    if (keep.every((k) => iou(k.box, d.box) < iouThreshold)) keep.push(d);
  }
  return keep;
}

/** Crop centre and size in display pixels. */
export interface CropRegion {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

/** MMPose `bbox_xyxy2cs` (padding) + `_fix_aspect_ratio` (grow the short side to the model aspect w/h). */
export function bboxToCS(box: Box, aspect: number, padding = 1.25): CropRegion {
  let w = (box[2] - box[0]) * padding;
  let h = (box[3] - box[1]) * padding;
  if (w > h * aspect) h = w / aspect;
  else w = h * aspect;
  return { cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, w, h };
}

/**
 * OKS of `b` against the COCO-17 joints of `a` that are visible (score >= threshold); the area comes from a's box.
 * A joint missing in `b` contributes 0. Not symmetric: OKS-NMS evaluates both directions.
 */
export function oksPair(a: Pose, b: Pose, visibleThreshold = VISIBLE_SCORE): number {
  const area = Math.max(1, boxArea(a.box) * OKS_AREA_PER_BOX_AREA);
  let num = 0;
  let den = 0;
  for (let k = 0; k < COCO17_NUM_KEYPOINTS; k++) {
    const i = k * KP_VALUES;
    if (!((a.keypoints[i + 2] as number) >= visibleThreshold)) continue;
    den++;
    const dx = (a.keypoints[i] as number) - (b.keypoints[i] as number);
    const dy = (a.keypoints[i + 1] as number) - (b.keypoints[i + 1] as number);
    if (Number.isNaN(dx) || Number.isNaN(dy)) continue;
    const s = 2 * (HALPE26_SIGMAS[k] as number);
    num += Math.exp(-(dx * dx + dy * dy) / (2 * area * s * s));
  }
  return den > 0 ? num / den : 0;
}

/**
 * Pose NMS: drops a person whose OKS with a kept, higher-scoring person reaches `threshold`. The OKS is taken from the
 * smaller of the two boxes (its area and its visible joints): measured with the larger box a small person next to a
 * big one is "close enough" to look like a duplicate (the bake-off variant lost 1.7 points of recall that way), while
 * real duplicates have near-identical skeletons whichever box is used.
 */
export function oksNms<T extends Pose>(persons: readonly T[], threshold: number): T[] {
  const keep: T[] = [];
  const duplicates = (a: Pose, b: Pose) =>
    (boxArea(a.box) <= boxArea(b.box) ? oksPair(a, b) : oksPair(b, a)) >= threshold;
  for (const p of [...persons].sort((a, b) => b.score - a.score)) {
    if (keep.every((k) => !duplicates(k, p))) keep.push(p);
  }
  return keep;
}

/** Bounding box of the joints scoring at least `threshold`, or null when there are none. */
export function boxFromKeypoints(keypoints: ArrayLike<number>, threshold = 0): Box | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const n = Math.floor(keypoints.length / KP_VALUES);
  for (let k = 0; k < n; k++) {
    const i = k * KP_VALUES;
    if (!((keypoints[i + 2] as number) >= threshold)) continue;
    const x = keypoints[i] as number;
    const y = keypoints[i + 1] as number;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** Keypoint-box propagation (06 §2.6): geometric constants in pixels or fractions, no time constants. */
export const PROPAGATION = {
  keypointScore: VISIBLE_SCORE,
  /** Extent padding per side, as a fraction of the visible-joint extent. */
  pad: 0.1,
  minJoints: 4,
  minHeightPx: 8,
  minWidthPx: 4,
  /** Two propagated boxes overlapping this much are one person (two tracks collapsing): keep the higher score. */
  duplicateIou: 0.7,
} as const;

/**
 * Boxes for the next frame from each person's own visible joints (detector cadence > 1). The score is the box score
 * scaled by the mean visible-joint score; persons with too few visible joints are dropped until the next detection.
 */
export function propagate(persons: readonly Pose[], width: number, height: number): ScoredBox[] {
  const out: ScoredBox[] = [];
  for (const p of persons) {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    let visible = 0;
    let scoreSum = 0;
    for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
      const i = k * KP_VALUES;
      const s = p.keypoints[i + 2] as number;
      if (!(s >= PROPAGATION.keypointScore)) continue;
      const x = p.keypoints[i] as number;
      const y = p.keypoints[i + 1] as number;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      visible++;
      scoreSum += s;
    }
    if (visible < PROPAGATION.minJoints) continue;
    const w = x1 - x0;
    const h = y1 - y0;
    const box: Box = [
      Math.max(0, x0 - PROPAGATION.pad * w),
      Math.max(0, y0 - PROPAGATION.pad * h),
      Math.min(width, x1 + PROPAGATION.pad * w),
      Math.min(height, y1 + PROPAGATION.pad * h),
    ];
    if (box[3] - box[1] < PROPAGATION.minHeightPx || box[2] - box[0] < PROPAGATION.minWidthPx) continue;
    out.push({ box, score: p.score * Math.min(1, scoreSum / visible) });
  }
  return nms(out, PROPAGATION.duplicateIou);
}
