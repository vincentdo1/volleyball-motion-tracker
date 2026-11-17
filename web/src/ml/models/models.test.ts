import { describe, expect, it } from 'vitest';
import { PERSON_KP_VALUES } from '@/contracts/halpe26';
import { INITIAL_POSE_PARAMS } from '@/contracts/params';
import oracles from '../__fixtures__/oracles.json';
import { syntheticDetectorOutputs, syntheticImage, syntheticSimcc } from '../__fixtures__/synthetic';
import { decodeDetections, prepareDetectorInput } from './dfine';
import { bucketFor, decodeSimcc, POSE_CROP_VALUES, planPoseBatches, preparePoseInput } from './rtmpose';
import { BALL_CLIP_LENGTH, BALL_INPUT_WIDTH, BALL_PLANE, decodeBallFrame, prepareBallFrame } from './vballnet';

const dec = oracles.decoders;

describe('D-FINE decode vs the bake-off reference', () => {
  const out = syntheticDetectorOutputs(dec.detector.seed, dec.detector.batch);
  dec.items.forEach((expected, item) => {
    it(`batch item ${item}`, () => {
      const got = decodeDetections(out.logits, out.boxes, item, dec.frame.width, dec.frame.height, dec.detector);
      for (const kind of ['persons', 'balls'] as const) {
        expect(got[kind]).toHaveLength(expected[kind].length);
        got[kind].forEach((d, i) => {
          const ref = expected[kind][i] as { box: number[]; score: number };
          expect(d.score).toBeCloseTo(ref.score, 9);
          d.box.forEach((v, k) => {
            expect(v).toBeCloseTo(ref.box[k] as number, 6);
          });
        });
      }
      expect(got.persons.length).toBeGreaterThan(10);
      expect(got.balls.length).toBeGreaterThan(5);
    });
  });

  it('drops person boxes shorter than the minimum height but keeps them as ball candidates', () => {
    const logits = new Float32Array(300 * 80).fill(-10);
    const boxes = new Float32Array(300 * 4);
    logits[0] = 5;
    logits[32] = 5;
    boxes.set([0.5, 0.5, 0.01, 0.005], 0);
    const got = decodeDetections(logits, boxes, 0, 1000, 1000, dec.detector);
    expect(got.persons).toHaveLength(0);
    expect(got.balls).toHaveLength(1);
  });
});

describe('D-FINE pre-processing', () => {
  it('fills a 3 x S x S plane scaled to 0..1 for any rotation', () => {
    const image = syntheticImage(5, 40, 24, 4);
    for (const rotation of [0, 90, 180, 270] as const) {
      const input = prepareDetectorInput(image, rotation, 32);
      expect(input).toHaveLength(3 * 32 * 32);
      expect(Math.min(...input)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...input)).toBeLessThanOrEqual(1);
    }
  });
});

describe('RTMPose', () => {
  it('decodes SimCC peaks to display pixels like the reference', () => {
    const { simccX, simccY } = syntheticSimcc(dec.pose.seed, dec.pose.batch);
    const got = decodeSimcc(simccX, simccY, dec.pose.regions);
    expect(got).toHaveLength(dec.pose.count * PERSON_KP_VALUES);
    dec.pose.keypoints.forEach((kps, person) => {
      kps.forEach((v, i) => {
        expect(got[person * PERSON_KP_VALUES + i]).toBeCloseTo(v, 4);
      });
    });
  });

  it('picks the smallest warmed bucket and splits oversize frames', () => {
    const buckets = INITIAL_POSE_PARAMS.batchBuckets;
    expect([1, 2, 3, 9, 13, 25, 32].map((n) => bucketFor(n, buckets))).toEqual([1, 2, 4, 12, 16, 32, 32]);
    expect(planPoseBatches(0, INITIAL_POSE_PARAMS)).toEqual([]);
    expect(planPoseBatches(5, INITIAL_POSE_PARAMS)).toEqual([{ start: 0, count: 5, batch: 8 }]);
    expect(planPoseBatches(40, INITIAL_POSE_PARAMS)).toEqual([
      { start: 0, count: 32, batch: 32 },
      { start: 32, count: 8, batch: 8 },
    ]);
  });

  it('runs one person per call in single mode', () => {
    const single = { ...INITIAL_POSE_PARAMS, batching: 'single' as const };
    expect(planPoseBatches(3, single)).toEqual([
      { start: 0, count: 1, batch: 1 },
      { start: 1, count: 1, batch: 1 },
      { start: 2, count: 1, batch: 1 },
    ]);
  });

  it('leaves padding crops blank', () => {
    const image = syntheticImage(6, 64, 48, 3);
    const region = { cx: 32, cy: 24, w: 30, h: 40 };
    const input = preparePoseInput(image, 0, [region], 2);
    expect(input).toHaveLength(2 * POSE_CROP_VALUES);
    expect(input.subarray(POSE_CROP_VALUES).every((v) => v === 0)).toBe(true);
    expect(input.subarray(0, POSE_CROP_VALUES).some((v) => v !== 0)).toBe(true);
  });
});

describe('VballNet', () => {
  /** Heatmaps with `disks` painted into clip frame 0: (cx, cy, r, peak, radiusMap). */
  function heatmaps(disks: [number, number, number, number, number][]) {
    const out = new Float32Array(2 * BALL_CLIP_LENGTH * BALL_PLANE);
    for (const [cx, cy, r, peak, radius] of disks) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          out[y * BALL_INPUT_WIDTH + x] = x === cx && y === cy ? peak : 0.6;
          out[BALL_CLIP_LENGTH * BALL_PLANE + y * BALL_INPUT_WIDTH + x] = radius;
        }
      }
    }
    return out;
  }
  const params = { heatmapThreshold: 0.5, maxBlobsPerFrame: 3 };

  it('returns the centroid in display pixels, the peak as confidence and the radius in frame-width units', () => {
    const [ball] = decodeBallFrame(heatmaps([[256, 144, 4, 0.9, 0.005]]), 0, 1920, 1080, params);
    expect(ball).toBeDefined();
    expect(ball?.x).toBeCloseTo((256.5 * 1920) / 512 - 0.5, 6);
    expect(ball?.y).toBeCloseTo((144.5 * 1080) / 288 - 0.5, 6);
    expect(ball?.confidence).toBeCloseTo(0.9, 6);
    expect(ball?.radius).toBeCloseTo(0.005 * 1920, 3);
  });

  it('orders blobs by area, limits them, and ignores regions below the threshold', () => {
    const maps = heatmaps([
      [100, 100, 2, 0.7, 0.004],
      [300, 150, 5, 0.8, 0.006],
      [400, 200, 3, 0.95, 0.005],
      [50, 250, 1, 0.99, 0.005],
    ]);
    const found = decodeBallFrame(maps, 0, 512, 288, params);
    expect(found.map((b) => Math.round(b.x))).toEqual([300, 400, 100]);
    expect(decodeBallFrame(maps, 0, 512, 288, { heatmapThreshold: 0.97, maxBlobsPerFrame: 3 })).toHaveLength(1);
    expect(decodeBallFrame(maps, 1, 512, 288, params)).toEqual([]);
  });

  it('keeps diagonal neighbours apart and connects 4-neighbours', () => {
    const maps = new Float32Array(2 * BALL_CLIP_LENGTH * BALL_PLANE);
    for (const [x, y] of [
      [10, 10],
      [11, 11],
      [20, 20],
      [21, 20],
    ])
      maps[(y as number) * BALL_INPUT_WIDTH + (x as number)] = 0.9;
    expect(decodeBallFrame(maps, 0, 512, 288, params)).toHaveLength(3);
  });

  it('writes the BT.601 luma scaled to 0..1', () => {
    const data = new Uint8Array(64 * 36 * 3);
    for (let i = 0; i < data.length; i += 3) data.set([100, 150, 200], i);
    const out = new Float32Array(BALL_PLANE);
    prepareBallFrame({ data, width: 64, height: 36, channels: 3 }, 0, out, 0);
    const luma = (0.299 * 100 + 0.587 * 150 + 0.114 * 200) / 255;
    expect(out.every((v) => Math.abs(v - luma) < 1e-6)).toBe(true);
  });
});
