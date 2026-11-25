/** Association cost terms of the online tracker: expanded IoU, pose OKS and the OC-SORT direction term. */
import { COCO17_NUM_KEYPOINTS, KP_VALUES } from '@/contracts/halpe26';
import { type Box, boxArea, type Pose, VISIBLE_SCORE } from '../geometry';

/** A skeleton needs this many visible COCO joints before its OKS says anything about identity. */
const MIN_POSE_JOINTS = 4;
/** Direction terms are ignored for displacements shorter than this fraction of the box height (noise, not motion). */
const MIN_DIRECTION_MOVE_H = 0.03;

export function expandBox(box: Box, factor: number): Box {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const hw = ((box[2] - box[0]) / 2) * factor;
  const hh = ((box[3] - box[1]) / 2) * factor;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/** IoU of both boxes after growing each by `factor` around its centre (1 is the plain IoU). */
export function expandedIou(a: Box, b: Box, factor: number): number {
  const ea = expandBox(a, factor);
  const eb = expandBox(b, factor);
  const w = Math.min(ea[2], eb[2]) - Math.max(ea[0], eb[0]);
  const h = Math.min(ea[3], eb[3]) - Math.max(ea[1], eb[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (boxArea(ea) + boxArea(eb) - inter);
}

/** Whether a person carries a skeleton usable for OKS (low-score detections carry NaN keypoints). */
export function hasUsablePose(keypoints: Float32Array): boolean {
  let visible = 0;
  for (let k = 0; k < COCO17_NUM_KEYPOINTS; k++) {
    if ((keypoints[k * KP_VALUES + 2] as number) >= VISIBLE_SCORE) visible++;
  }
  return visible >= MIN_POSE_JOINTS;
}

/** `pose` moved and scaled as its box moved from `from` to `to`. */
export function carryPose(pose: Pose, from: Box, to: Box): Pose {
  const scale = (to[3] - to[1]) / Math.max(1e-3, from[3] - from[1]);
  const fx = (from[0] + from[2]) / 2;
  const fy = (from[1] + from[3]) / 2;
  const tx = (to[0] + to[2]) / 2;
  const ty = (to[1] + to[3]) / 2;
  const keypoints = new Float32Array(pose.keypoints.length);
  for (let i = 0; i < keypoints.length; i += KP_VALUES) {
    keypoints[i] = tx + ((pose.keypoints[i] as number) - fx) * scale;
    keypoints[i + 1] = ty + ((pose.keypoints[i + 1] as number) - fy) * scale;
    keypoints[i + 2] = pose.keypoints[i + 2] as number;
  }
  return { box: to, score: pose.score, keypoints };
}

export interface Motion {
  readonly dx: number;
  readonly dy: number;
}

/**
 * OC-SORT observation-centric momentum: 0 when the detection continues the track's observed heading, 1 when it
 * reverses it (angle / pi). Zero when either displacement is too small to define a direction.
 */
export function directionCost(track: Motion | null, step: Motion, boxHeight: number): number {
  if (!track) return 0;
  const min = MIN_DIRECTION_MOVE_H * boxHeight;
  const a = Math.hypot(track.dx, track.dy);
  const b = Math.hypot(step.dx, step.dy);
  if (a < min || b < min) return 0;
  const cos = (track.dx * step.dx + track.dy * step.dy) / (a * b);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / Math.PI;
}

export interface CostWeights {
  readonly eiou: number;
  readonly oks: number;
}

/** `w_e (1 - EIoU) + w_o (1 - OKS)` normalised by the weights in use; plain `1 - EIoU` when a side has no skeleton. */
export function poseAwareCost(eiou: number, oks: number | null, weights: CostWeights): number {
  if (oks === null || weights.oks <= 0) return 1 - eiou;
  const total = weights.eiou + weights.oks;
  return (weights.eiou * (1 - eiou) + weights.oks * (1 - oks)) / total;
}
