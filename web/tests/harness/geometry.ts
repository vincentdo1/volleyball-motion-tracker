import { HALPE26_SIGMAS } from '../../src/contracts/halpe26.ts';
import type { Box } from './types.ts';

/** COCO-17 OKS sigmas: the first 17 Halpe26 joints share the COCO order. */
export const COCO_SIGMAS: readonly number[] = HALPE26_SIGMAS.slice(0, 17);
export const COCO_JOINTS = 17;
/** Shoulders and hips. */
export const TORSO: readonly number[] = [5, 6, 11, 12];

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

export const boxArea = (b: Box): number => Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
export const boxDiagonal = (b: Box): number => Math.hypot(b[2] - b[0], b[3] - b[1]);
export const boxHeight = (b: Box): number => b[3] - b[1];

export function sigma(joint: number): number {
  const value = COCO_SIGMAS[joint];
  if (value === undefined) throw new Error(`no OKS sigma for joint ${joint}`);
  return value;
}
