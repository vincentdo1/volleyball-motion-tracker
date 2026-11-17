import { describe, expect, it } from 'vitest';
import type { Rotation } from '@/contracts/posetrack';
import oracles from '../__fixtures__/oracles.json';
import { syntheticImage } from '../__fixtures__/synthetic';
import { displaySize, mapAffineCrop, mapResize, NORM_IMAGENET, NORM_UNIT, sampleGray, sampleToCHW } from './cpu';

const pre = oracles.preprocess;

/** Normalised values are within a few units; float32 rounding of the port stays far below this. */
const TOLERANCE = 2e-5;

function expectClose(actual: ArrayLike<number>, expected: readonly number[]) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++)
    worst = Math.max(worst, Math.abs((actual[i] as number) - (expected[i] as number)));
  expect(worst).toBeLessThan(TOLERANCE);
}

describe('CPU pre-processing vs the bake-off sampler', () => {
  for (const c of pre.cases) {
    const image = syntheticImage(c.image.seed, c.image.width, c.image.height, c.image.channels as 3 | 4);
    const rotation = c.rotation as Rotation;
    const display = displaySize(image, rotation);
    const label = `${c.image.width}x${c.image.height}x${c.image.channels} rotated ${rotation}`;

    it(`whole-frame stretch, ${label}`, () => {
      const { outW, outH } = pre.resize;
      const out = new Float32Array(3 * outW * outH);
      sampleToCHW(image, rotation, out, 0, outW, outH, mapResize(display.width, display.height, outW, outH), {
        norm: NORM_UNIT,
        border: 'replicate',
      });
      expectClose(out, c.resized);
    });

    it(`top-down crops with a black border, ${label}`, () => {
      const { outW, outH } = pre.cropOut;
      const plane = 3 * outW * outH;
      const out = new Float32Array(plane * pre.crops.length + 5);
      pre.crops.forEach((crop, i) => {
        const region = {
          cx: crop.cx * display.width,
          cy: crop.cy * display.height,
          w: crop.w * display.width,
          h: crop.h * display.height,
        };
        sampleToCHW(image, rotation, out, 5 + i * plane, outW, outH, mapAffineCrop(region, outW, outH), {
          norm: NORM_IMAGENET,
          border: 'zero',
        });
      });
      pre.crops.forEach((_, i) => {
        expectClose(out.subarray(5 + i * plane, 5 + (i + 1) * plane), c.cropped[i] as number[]);
      });
      expect(out.subarray(0, 5).every((v) => v === 0)).toBe(true);
    });

    it(`grayscale stretch, ${label}`, () => {
      const { outW, outH, stride } = pre.gray;
      const out = new Float32Array(outW * outH);
      sampleGray(image, rotation, out, 0, outW, outH);
      const sampled = Array.from({ length: c.gray.length }, (_, i) => out[i * stride] as number);
      expectClose(sampled, c.gray);
    });
  }
});

describe('CPU pre-processing properties', () => {
  it('displaySize swaps the sides for quarter turns', () => {
    const image = { width: 40, height: 30 };
    expect(displaySize(image, 0)).toEqual({ width: 40, height: 30 });
    expect(displaySize(image, 90)).toEqual({ width: 30, height: 40 });
    expect(displaySize(image, 180)).toEqual({ width: 40, height: 30 });
    expect(displaySize(image, 270)).toEqual({ width: 30, height: 40 });
  });

  it('an identity map reproduces the pixels, rotated, normalised and with the channel order kept', () => {
    // 2x1 image, red then blue; displayed rotated 90 degrees clockwise it is 1x2 with red on top.
    const image = { data: Uint8Array.of(255, 0, 0, 0, 0, 255), width: 2, height: 1, channels: 3 as const };
    const out = new Float32Array(3 * 2);
    sampleToCHW(image, 90, out, 0, 1, 2, { ax: 1, bx: 0, ay: 1, by: 0 }, { norm: NORM_UNIT, border: 'zero' });
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it('a zero border reads black outside the frame and a replicate border reads the edge', () => {
    const image = { data: Uint8Array.of(255, 255, 255), width: 1, height: 1, channels: 3 as const };
    const map = { ax: 1, bx: -3, ay: 1, by: 0 };
    const zero = new Float32Array(3);
    const edge = new Float32Array(3);
    sampleToCHW(image, 0, zero, 0, 1, 1, map, { norm: NORM_UNIT, border: 'zero' });
    sampleToCHW(image, 0, edge, 0, 1, 1, map, { norm: NORM_UNIT, border: 'replicate' });
    expect(Array.from(zero)).toEqual([0, 0, 0]);
    expect(Array.from(edge)).toEqual([1, 1, 1]);
  });

  it('ignores the alpha channel of RGBA input', () => {
    const rgb = { data: Uint8Array.of(10, 20, 30), width: 1, height: 1, channels: 3 as const };
    const rgba = { data: Uint8Array.of(10, 20, 30, 7), width: 1, height: 1, channels: 4 as const };
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    const map = { ax: 1, bx: 0, ay: 1, by: 0 };
    sampleToCHW(rgb, 0, a, 0, 1, 1, map, { norm: NORM_IMAGENET, border: 'zero' });
    sampleToCHW(rgba, 0, b, 0, 1, 1, map, { norm: NORM_IMAGENET, border: 'zero' });
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});
