/**
 * RTMPose-m/s Halpe26 adapter (SimCC head). Input `input [B,3,256,192]`: one MMPose top-down crop per person (box
 * centre, size x1.25, grown to the 3:4 aspect; bilinear warp with a black border), RGB, ImageNet mean/std in 0..255
 * units. Outputs `simcc_x [B,26,384]` and `simcc_y [B,26,512]` logits (not normalised); the joint is the argmax / 2 in
 * crop pixels and its score is min(max_x, max_y).
 */
import { HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { PoseParams } from '@/contracts/params';
import type { Rotation } from '@/contracts/posetrack';
import { type Box, bboxToCS, type CropRegion } from '../geometry';
import { mapAffineCrop, NORM_IMAGENET, type PixelImage, sampleToCHW } from '../preprocess/cpu';

/** Tensor names of the ONNX graph. */
export const POSE_IO = { input: 'input', simccX: 'simcc_x', simccY: 'simcc_y' } as const;
export const POSE_INPUT_WIDTH = 192;
export const POSE_INPUT_HEIGHT = 256;
export const POSE_INPUT_ASPECT = POSE_INPUT_WIDTH / POSE_INPUT_HEIGHT;
/** Values in one `[3, 256, 192]` crop. */
export const POSE_CROP_VALUES = 3 * POSE_INPUT_WIDTH * POSE_INPUT_HEIGHT;
export const SIMCC_X_LENGTH = 2 * POSE_INPUT_WIDTH;
export const SIMCC_Y_LENGTH = 2 * POSE_INPUT_HEIGHT;
/** SimCC bins per crop pixel. */
const SIMCC_SPLIT = 2;
/** MMPose `bbox_xyxy2cs` padding. */
const CROP_PADDING = 1.25;

/** One pose call: `count` real crops starting at person `start`, padded with blank crops to `batch`. */
export interface PoseBatch {
  readonly start: number;
  readonly count: number;
  readonly batch: number;
}

/** Smallest bucket that holds `n` crops, or the largest bucket when `n` exceeds them all. */
export function bucketFor(n: number, buckets: readonly number[]): number {
  return buckets.find((b) => b >= n) ?? (buckets[buckets.length - 1] as number);
}

/**
 * Splits `personCount` crops into pose calls: `single` mode runs one person per call (WASM), `buckets` mode fills the
 * largest bucket and pads the remainder up to the next bucket so only warmed shapes ever run.
 */
export function planPoseBatches(personCount: number, pose: Pick<PoseParams, 'batching' | 'batchBuckets'>): PoseBatch[] {
  const batches: PoseBatch[] = [];
  const maxBatch = pose.batching === 'single' ? 1 : (pose.batchBuckets[pose.batchBuckets.length - 1] as number);
  for (let start = 0; start < personCount; start += maxBatch) {
    const count = Math.min(maxBatch, personCount - start);
    batches.push({ start, count, batch: pose.batching === 'single' ? 1 : bucketFor(count, pose.batchBuckets) });
  }
  return batches;
}

export function cropRegions(boxes: readonly Box[]): CropRegion[] {
  return boxes.map((box) => bboxToCS(box, POSE_INPUT_ASPECT, CROP_PADDING));
}

/** CPU pre-processing: the `[batch, 3, 256, 192]` input for `regions` (blank crops fill the padding). */
export function preparePoseInput(
  image: PixelImage,
  rotation: Rotation,
  regions: readonly CropRegion[],
  batch: number,
): Float32Array {
  const out = new Float32Array(batch * POSE_CROP_VALUES);
  regions.forEach((region, i) => {
    sampleToCHW(
      image,
      rotation,
      out,
      i * POSE_CROP_VALUES,
      POSE_INPUT_WIDTH,
      POSE_INPUT_HEIGHT,
      mapAffineCrop(region, POSE_INPUT_WIDTH, POSE_INPUT_HEIGHT),
      { norm: NORM_IMAGENET, border: 'zero' },
    );
  });
  return out;
}

function argmax(a: ArrayLike<number>, offset: number, length: number): { index: number; value: number } {
  let index = 0;
  let value = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < length; i++) {
    const v = a[offset + i] as number;
    if (v > value) {
      value = v;
      index = i;
    }
  }
  return { index, value };
}

/**
 * Decodes `regions.length` persons of a pose batch into packed Halpe26 keypoints (x, y, score) in display pixels,
 * one `PERSON_KP_VALUES` slice per person.
 */
export function decodeSimcc(
  simccX: ArrayLike<number>,
  simccY: ArrayLike<number>,
  regions: readonly CropRegion[],
): Float32Array {
  const out = new Float32Array(regions.length * PERSON_KP_VALUES);
  regions.forEach((region, b) => {
    for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
      const x = argmax(simccX, (b * HALPE26_NUM_KEYPOINTS + k) * SIMCC_X_LENGTH, SIMCC_X_LENGTH);
      const y = argmax(simccY, (b * HALPE26_NUM_KEYPOINTS + k) * SIMCC_Y_LENGTH, SIMCC_Y_LENGTH);
      const o = b * PERSON_KP_VALUES + k * KP_VALUES;
      out[o] = region.cx - region.w / 2 + (x.index / SIMCC_SPLIT) * (region.w / POSE_INPUT_WIDTH);
      out[o + 1] = region.cy - region.h / 2 + (y.index / SIMCC_SPLIT) * (region.h / POSE_INPUT_HEIGHT);
      out[o + 2] = Math.min(x.value, y.value);
    }
  });
  return out;
}
