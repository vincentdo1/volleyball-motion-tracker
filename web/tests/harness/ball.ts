/**
 * Ball detection scoring against hand-reviewed labels. Labels and predictions are keyed by PTS in microseconds.
 * A prediction is a hit when it lies within the hit radius of the labelled centre: 9 px at 1920 px frame width scaled
 * to the frame, but never tighter than a share of the labelled ball radius, because motion blur makes the centre of a
 * large close-up ball uncertain by that much.
 */
import { get } from './access.ts';

export interface BallLabel {
  ptsUs: number;
  file: string;
  visible: boolean;
  x?: number;
  y?: number;
  /** Labelled ball radius in pixels. */
  radius?: number;
}

export interface BallClipLabels {
  video: string;
  width: number;
  height: number;
  frames: BallLabel[];
}

export interface BallLabels {
  /** Hit radius in pixels at a frame width of 1920. */
  toleranceAt1920: number;
  clips: Record<string, BallClipLabels>;
}

export interface BallPoint {
  x: number;
  y: number;
}

export interface BallPredictionFrame {
  ptsUs: number;
  ball: BallPoint | null;
}

export interface BallPredictions {
  clips: Record<string, BallPredictionFrame[]>;
}

export interface BallScore {
  /** Labelled frames considered. */
  frames: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface BallOptions {
  /** Hit radius is at least this share of the labelled ball radius (0 = the strict 9 px at 1920 rule only). */
  radiusShare: number;
}

export const STRICT: BallOptions = { radiusShare: 0 };
export const SIZE_AWARE: BallOptions = { radiusShare: 0.4 };

const safeDivide = (a: number, b: number): number => (b === 0 ? 0 : a / b);

export function hitRadius(label: BallLabel, width: number, toleranceAt1920: number, options: BallOptions): number {
  return Math.max((toleranceAt1920 * width) / 1920, options.radiusShare * (label.radius ?? 0));
}

export function scoreBall(
  labels: BallLabels,
  predictions: BallPredictions,
  options: BallOptions = SIZE_AWARE,
): BallScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let frames = 0;
  for (const [name, clip] of Object.entries(labels.clips)) {
    const predicted = new Map((predictions.clips[name] ?? []).map((frame) => [frame.ptsUs, frame.ball]));
    for (const label of clip.frames) {
      frames++;
      const ball = predicted.get(label.ptsUs) ?? null;
      if (!label.visible) {
        if (ball) fp++;
        else tn++;
      } else if (!ball) {
        fn++;
      } else {
        const distance = Math.hypot(ball.x - (label.x ?? 0), ball.y - (label.y ?? 0));
        if (distance <= hitRadius(label, clip.width, labels.toleranceAt1920, options)) tp++;
        else {
          fp++;
          fn++;
        }
      }
    }
  }
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  return { frames, tp, fp, fn, tn, precision, recall, f1: safeDivide(2 * precision * recall, precision + recall) };
}

/** Per-clip scores, for reports. */
export function scoreBallByClip(
  labels: BallLabels,
  predictions: BallPredictions,
  options: BallOptions = SIZE_AWARE,
): Record<string, BallScore> {
  return Object.fromEntries(
    Object.keys(labels.clips).map((name) => [
      name,
      scoreBall({ ...labels, clips: { [name]: get(labels.clips, name) } }, predictions, options),
    ]),
  );
}
