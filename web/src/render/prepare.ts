import { PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { RenderPlayer, ViewTransform } from '@/contracts/renderer';
import { assessPose, type PoseAssessment } from './assess';
import { clamp, type Rgb } from './color';
import { isReusedSlot, slotColor } from './palette';

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A player converted to canvas pixels, with everything the painters need computed once. */
export interface PreparedPlayer {
  readonly player: RenderPlayer;
  readonly assessment: PoseAssessment;
  /** x, y per Halpe26 joint in canvas px (NaN when missing); empty for box-only players. */
  readonly points: Float32Array;
  /** Apparent height in canvas px (box height for box-only players). */
  readonly height: number;
  /** Extent of the player on the canvas: confident joints, or the detector box. null when nothing is known. */
  readonly bounds: Bounds | null;
  /** Detector box in canvas px, if any. */
  readonly box: Bounds | null;
  /** Display px -> canvas px factor (view scale x dpr). */
  readonly pxScale: number;
  readonly color: Rgb;
  readonly reusedColor: boolean;
}

const JOINT_COUNT = PERSON_KP_VALUES / 3;

function boundsOfConfident(points: Float32Array, player: RenderPlayer): Bounds | null {
  const kp = player.keypoints;
  if (!kp) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const score = kp[j * 3 + 2] as number;
    if (!(score > 0.3)) continue;
    const x = points[j * 2] as number;
    const y = points[j * 2 + 1] as number;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function preparePlayer(player: RenderPlayer, view: ViewTransform): PreparedPlayer {
  const { scale, offsetX, offsetY, dpr } = view;
  const kp = player.keypoints;
  const points = new Float32Array(kp ? JOINT_COUNT * 2 : 0);
  if (kp) {
    for (let j = 0; j < JOINT_COUNT; j++) {
      points[j * 2] = ((kp[j * 3] as number) * scale + offsetX) * dpr;
      points[j * 2 + 1] = ((kp[j * 3 + 1] as number) * scale + offsetY) * dpr;
    }
  }
  const box = player.box
    ? {
        x0: (player.box[0] * scale + offsetX) * dpr,
        y0: (player.box[1] * scale + offsetY) * dpr,
        x1: (player.box[2] * scale + offsetX) * dpr,
        y1: (player.box[3] * scale + offsetY) * dpr,
      }
    : null;
  const assessment = assessPose(player);
  const poseBounds = assessment.level === 'marker' ? null : boundsOfConfident(points, player);
  const height = assessment.level === 'marker' ? (box ? box.y1 - box.y0 : 0) : assessment.apparentHeight * scale * dpr;
  return {
    player,
    assessment,
    points,
    height,
    bounds: poseBounds ?? box,
    box,
    pxScale: scale * dpr,
    color: slotColor(player.colorSlot),
    reusedColor: isReusedSlot(player.colorSlot),
  };
}

/** Base bone width W in canvas px (05 §2.3). */
export function baseWidth(height: number, widthK: number): number {
  return clamp(widthK * height, 1.6, 15);
}
