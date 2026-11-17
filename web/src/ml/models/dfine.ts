/**
 * D-FINE person/ball detector adapter. Input `pixel_values [B,3,S,S]`: the display frame stretched to S x S, RGB, x/255,
 * no mean/std. Outputs `logits [B,300,80]` (sigmoid, person = class 0, sports ball = class 32) and `pred_boxes
 * [B,300,4]` (cx, cy, w, h normalised to the frame). S is any multiple of 32 (the 480 px WASM tiers reuse the 640 px
 * weights).
 */
import type { Rotation } from '@/contracts/posetrack';
import { type Box, nms, type ScoredBox } from '../geometry';
import { displaySize, mapResize, NORM_UNIT, type PixelImage, sampleToCHW } from '../preprocess/cpu';

/** Tensor names of the ONNX graph. */
export const DFINE_IO = { input: 'pixel_values', logits: 'logits', boxes: 'pred_boxes' } as const;
export const DFINE_PERSON_CLASS = 0;
export const DFINE_BALL_CLASS = 32;
export const DFINE_QUERIES = 300;
export const DFINE_CLASSES = 80;
/** Duplicate guard between ball boxes (the persons use the configured detector NMS). */
const BALL_NMS_IOU = 0.5;

export interface DetectorDecodeParams {
  /** Person boxes below this score are dropped (the tracker's low-score floor, below the pose threshold). */
  readonly minPersonScore: number;
  readonly nmsIou: number;
  readonly minBoxHeightPx: number;
  readonly minBallScore: number;
}

export interface DetectorOutput {
  /** Score-sorted person boxes in display px. */
  readonly persons: readonly ScoredBox[];
  /** Score-sorted `sports ball` boxes in display px. */
  readonly balls: readonly ScoredBox[];
}

/** CPU pre-processing: the `[3, S, S]` input plane for one frame. */
export function prepareDetectorInput(image: PixelImage, rotation: Rotation, size: number): Float32Array {
  const display = displaySize(image, rotation);
  const out = new Float32Array(3 * size * size);
  sampleToCHW(image, rotation, out, 0, size, size, mapResize(display.width, display.height, size, size), {
    norm: NORM_UNIT,
    border: 'replicate',
  });
  return out;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Decodes batch item `item` of the model outputs into display-pixel boxes. A query can be both a person and a ball
 * candidate; each list is thresholded and de-duplicated on its own.
 */
export function decodeDetections(
  logits: ArrayLike<number>,
  boxes: ArrayLike<number>,
  item: number,
  displayWidth: number,
  displayHeight: number,
  params: DetectorDecodeParams,
): DetectorOutput {
  const persons: ScoredBox[] = [];
  const balls: ScoredBox[] = [];
  for (let q = 0; q < DFINE_QUERIES; q++) {
    const l = (item * DFINE_QUERIES + q) * DFINE_CLASSES;
    const personScore = sigmoid(logits[l + DFINE_PERSON_CLASS] as number);
    const ballScore = sigmoid(logits[l + DFINE_BALL_CLASS] as number);
    if (personScore < params.minPersonScore && ballScore < params.minBallScore) continue;
    const b = (item * DFINE_QUERIES + q) * 4;
    const cx = boxes[b] as number;
    const cy = boxes[b + 1] as number;
    const w = boxes[b + 2] as number;
    const h = boxes[b + 3] as number;
    const box: Box = [
      (cx - w / 2) * displayWidth,
      (cy - h / 2) * displayHeight,
      (cx + w / 2) * displayWidth,
      (cy + h / 2) * displayHeight,
    ];
    if (personScore >= params.minPersonScore && box[3] - box[1] >= params.minBoxHeightPx) {
      persons.push({ box, score: personScore });
    }
    if (ballScore >= params.minBallScore) balls.push({ box, score: ballScore });
  }
  return { persons: nms(persons, params.nmsIou), balls: nms(balls, BALL_NMS_IOU) };
}
