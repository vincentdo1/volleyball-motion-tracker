/**
 * CPU reference pre-processing: one bilinear sampler that turns a region of a frame into a model input plane.
 * Port of the bake-off `imageops.mjs` (`sampleToCHW`, `mapResize`, `mapAffineCrop`, `grayInto`) with frame rotation
 * added. It is the WASM tier's pre-processing path and the reference the WGSL kernels are tested against, so the
 * sub-pixel conventions matter and are spelled out:
 *   - Pixel (i, j) has its centre at integer coordinates (i, j); the image spans [-0.5, W - 0.5].
 *   - Whole-frame resize follows cv2.resize / PIL: src = (u + 0.5) * s - 0.5.
 *   - The MMPose top-down crop follows cv2.warpAffine as MMPose calls it: src = x0 + u * cropSize / outSize.
 * The sampler reads the coded (un-rotated) pixels and works in display coordinates, so callers never rotate pixels.
 */
import type { FrameSource } from '@/contracts/pipeline';
import type { Rotation } from '@/contracts/posetrack';
import type { CropRegion } from '../geometry';

/** Interleaved 8-bit pixels in coded orientation (the `pixels` variant of `FrameSource`). */
export type PixelImage = Omit<Extract<FrameSource, { kind: 'pixels' }>, 'kind'>;

/** value = (raw - mean) / std with raw in 0..255. */
export interface Normalization {
  readonly mean: readonly [number, number, number];
  readonly std: readonly [number, number, number];
}

/** x / 255 (D-FINE). */
export const NORM_UNIT: Normalization = { mean: [0, 0, 0], std: [255, 255, 255] };
/** ImageNet statistics in 0..255 units (RTMPose). */
export const NORM_IMAGENET: Normalization = { mean: [123.675, 116.28, 103.53], std: [58.395, 57.12, 57.375] };

/** What a tap outside the frame reads: the nearest edge pixel, or black. */
export type Border = 'replicate' | 'zero';

/** Output pixel (u, v) samples display coordinates (ax * u + bx, ay * v + by). */
export interface SamplingMap {
  readonly ax: number;
  readonly bx: number;
  readonly ay: number;
  readonly by: number;
}

export interface SampleOptions {
  readonly norm: Normalization;
  readonly border: Border;
}

/** Size of the frame as displayed: 90 and 270 degrees swap the coded width and height. */
export function displaySize(image: Pick<PixelImage, 'width' | 'height'>, rotation: Rotation) {
  const swap = rotation === 90 || rotation === 270;
  return { width: swap ? image.height : image.width, height: swap ? image.width : image.height };
}

/** Stretch the whole display frame onto `outW` x `outH` with half-pixel centres. */
export function mapResize(displayWidth: number, displayHeight: number, outW: number, outH: number): SamplingMap {
  const sx = displayWidth / outW;
  const sy = displayHeight / outH;
  return { ax: sx, bx: 0.5 * sx - 0.5, ay: sy, by: 0.5 * sy - 0.5 };
}

/** MMPose top-down crop (no rotation): `region` in display pixels onto `outW` x `outH`, src = x0 + u * size / out. */
export function mapAffineCrop(region: CropRegion, outW: number, outH: number): SamplingMap {
  const sx = region.w / outW;
  const sy = region.h / outH;
  return { ax: sx, bx: region.cx - region.w / 2, ay: sy, by: region.cy - region.h / 2 };
}

/** Coded coordinates from display coordinates: x = xx * xd + xy * yd + x0, y = yx * xd + yy * yd + y0. */
export interface Orientation {
  readonly xx: number;
  readonly xy: number;
  readonly x0: number;
  readonly yx: number;
  readonly yy: number;
  readonly y0: number;
}

/** The frame is shown rotated clockwise by `rotation`; the maps below are the inverse, over pixel-centre indices. */
export function orientation(rotation: Rotation, displayWidth: number, displayHeight: number): Orientation {
  const w = displayWidth - 1;
  const h = displayHeight - 1;
  switch (rotation) {
    case 0:
      return { xx: 1, xy: 0, x0: 0, yx: 0, yy: 1, y0: 0 };
    case 90:
      return { xx: 0, xy: 1, x0: 0, yx: -1, yy: 0, y0: w };
    case 180:
      return { xx: -1, xy: 0, x0: w, yx: 0, yy: -1, y0: h };
    case 270:
      return { xx: 0, xy: -1, x0: h, yx: 1, yy: 0, y0: 0 };
  }
}

/** Calls `visit(index, r, g, b)` with the bilinearly sampled raw colour (0..255) of every output pixel. */
function sampleRaw(
  image: PixelImage,
  rotation: Rotation,
  outW: number,
  outH: number,
  map: SamplingMap,
  border: Border,
  visit: (index: number, r: number, g: number, b: number) => void,
): void {
  const { data, width: W, height: H, channels: C } = image;
  const display = displaySize(image, rotation);
  const o = orientation(rotation, display.width, display.height);
  const replicate = border === 'replicate';
  const clampX = (x: number) => (x < 0 ? 0 : x >= W ? W - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= H ? H - 1 : y);
  /** Offset of pixel (x, y), or -1 when it is outside the frame and the border is black. */
  const at = (x: number, y: number) => {
    if (replicate) return (clampY(y) * W + clampX(x)) * C;
    return x >= 0 && y >= 0 && x < W && y < H ? (y * W + x) * C : -1;
  };
  const channel = (offset: number, c: number) => (offset < 0 ? 0 : (data[offset + c] as number));

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const xd = map.ax * u + map.bx;
      const yd = map.ay * v + map.by;
      const sx = o.xx * xd + o.xy * yd + o.x0;
      const sy = o.yx * xd + o.yy * yd + o.y0;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = at(x0, y0);
      const i10 = at(x0 + 1, y0);
      const i01 = at(x0, y0 + 1);
      const i11 = at(x0 + 1, y0 + 1);
      const mix = (c: number) =>
        channel(i00, c) * w00 + channel(i10, c) * w10 + channel(i01, c) * w01 + channel(i11, c) * w11;
      visit(v * outW + u, mix(0), mix(1), mix(2));
    }
  }
}

/**
 * Samples `map` over the display frame into a CHW float plane at `out[offset ...]`
 * (`3 * outW * outH` values, RGB, normalised).
 */
export function sampleToCHW(
  image: PixelImage,
  rotation: Rotation,
  out: Float32Array,
  offset: number,
  outW: number,
  outH: number,
  map: SamplingMap,
  { norm, border }: SampleOptions,
): void {
  const plane = outW * outH;
  const [m0, m1, m2] = norm.mean;
  const [i0, i1, i2] = [1 / norm.std[0], 1 / norm.std[1], 1 / norm.std[2]];
  sampleRaw(image, rotation, outW, outH, map, border, (index, r, g, b) => {
    const o = offset + index;
    out[o] = (r - m0) * i0;
    out[o + plane] = (g - m1) * i1;
    out[o + 2 * plane] = (b - m2) * i2;
  });
}

/** Grayscale (BT.601 luma) stretch of the whole display frame onto `outW` x `outH`, scaled to 0..1 (VballNet). */
export function sampleGray(
  image: PixelImage,
  rotation: Rotation,
  out: Float32Array,
  offset: number,
  outW: number,
  outH: number,
): void {
  const display = displaySize(image, rotation);
  const map = mapResize(display.width, display.height, outW, outH);
  sampleRaw(image, rotation, outW, outH, map, 'replicate', (index, r, g, b) => {
    out[offset + index] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  });
}
