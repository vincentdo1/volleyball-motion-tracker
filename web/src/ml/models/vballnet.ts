/**
 * VballNetV4c ball model adapter. Input `clip [B,9,288,512]`: nine consecutive display frames, each stretched to
 * 512 x 288 in grayscale and divided by 255. Output `heatmaps [B,18,288,512]`: channels 0-8 are the per-frame ball
 * heatmaps (already sigmoid), channels 9-17 the per-frame ball radius in units of the frame width. Each heatmap is
 * decoded into up to a few blobs: connected regions at or above the threshold, centroid of the region (what the
 * upstream contour-moment decode does), the peak value as confidence.
 */
import type { BallCandidate } from '@/contracts/pipeline';
import { BallSource, type Rotation } from '@/contracts/posetrack';
import { type PixelImage, sampleGray } from '../preprocess/cpu';

export const BALL_INPUT_WIDTH = 512;
export const BALL_INPUT_HEIGHT = 288;
/** Frames per clip (and heatmaps per output). */
export const BALL_CLIP_LENGTH = 9;
export const BALL_PLANE = BALL_INPUT_WIDTH * BALL_INPUT_HEIGHT;

export interface BlobDecodeParams {
  readonly heatmapThreshold: number;
  readonly maxBlobsPerFrame: number;
}

/** CPU pre-processing: one grayscale `[288, 512]` plane written at `out[offset ...]`. */
export function prepareBallFrame(image: PixelImage, rotation: Rotation, out: Float32Array, offset: number): void {
  sampleGray(image, rotation, out, offset, BALL_INPUT_WIDTH, BALL_INPUT_HEIGHT);
}

interface Blob {
  area: number;
  sumX: number;
  sumY: number;
  sumRadius: number;
  peak: number;
}

/**
 * Candidates of clip frame `t` (0-8) in display pixels, largest region first.
 * `heatmaps` is the `[18, 288, 512]` output of batch item 0.
 */
export function decodeBallFrame(
  heatmaps: ArrayLike<number>,
  t: number,
  displayWidth: number,
  displayHeight: number,
  params: BlobDecodeParams,
): BallCandidate[] {
  const heat = t * BALL_PLANE;
  const radius = (BALL_CLIP_LENGTH + t) * BALL_PLANE;
  const seen = new Uint8Array(BALL_PLANE);
  const stack: number[] = [];
  const blobs: Blob[] = [];
  for (let start = 0; start < BALL_PLANE; start++) {
    if (seen[start] || (heatmaps[heat + start] as number) < params.heatmapThreshold) continue;
    const blob: Blob = { area: 0, sumX: 0, sumY: 0, sumRadius: 0, peak: 0 };
    seen[start] = 1;
    stack.push(start);
    for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
      const x = i % BALL_INPUT_WIDTH;
      const y = (i - x) / BALL_INPUT_WIDTH;
      blob.area++;
      blob.sumX += x;
      blob.sumY += y;
      blob.sumRadius += heatmaps[radius + i] as number;
      blob.peak = Math.max(blob.peak, heatmaps[heat + i] as number);
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < BALL_INPUT_WIDTH - 1 ? i + 1 : -1,
        y > 0 ? i - BALL_INPUT_WIDTH : -1,
        y < BALL_INPUT_HEIGHT - 1 ? i + BALL_INPUT_WIDTH : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || (heatmaps[heat + n] as number) < params.heatmapThreshold) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    blobs.push(blob);
  }
  blobs.sort((a, b) => b.area - a.area || b.peak - a.peak);
  return blobs.slice(0, params.maxBlobsPerFrame).map(
    (b): BallCandidate => ({
      x: ((b.sumX / b.area + 0.5) * displayWidth) / BALL_INPUT_WIDTH - 0.5,
      y: ((b.sumY / b.area + 0.5) * displayHeight) / BALL_INPUT_HEIGHT - 0.5,
      radius: (b.sumRadius / b.area) * displayWidth,
      confidence: b.peak,
      source: BallSource.VBALLNET,
    }),
  );
}
