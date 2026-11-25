import { describe, expect, it } from 'vitest';
import { HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import oracles from './__fixtures__/oracles.json';
import { type SyntheticPerson, syntheticDetections, syntheticPersons } from './__fixtures__/synthetic';
import { type Box, bboxToCS, boxFromKeypoints, iou, nms, oksNms, oksPair, type Pose, propagate } from './geometry';

const g = oracles.geometry;

function toPose(p: SyntheticPerson): Pose {
  return { box: p.box, score: p.score, keypoints: Float32Array.from(p.kps.flat()) };
}

const detections = syntheticDetections(
  g.detections.seed,
  g.detections.clusters,
  g.detections.width,
  g.detections.height,
);
const persons = syntheticPersons(
  g.persons.seed,
  g.persons.count,
  g.persons.width,
  g.persons.height,
  g.persons.duplicateFraction,
).map(toPose);

function expectBox(actual: Box | null, expected: readonly number[] | null) {
  if (expected === null) return expect(actual).toBeNull();
  expect(actual).not.toBeNull();
  (actual as Box).forEach((v, i) => {
    expect(v).toBeCloseTo(expected[i] as number, 9);
  });
}

describe('geometry vs the bake-off reference', () => {
  it('iou', () => {
    expect(g.iou.length).toBeGreaterThan(20);
    for (const [i, j, expected] of g.iou as [number, number, number][]) {
      expect(iou(detections[i as number]?.box as Box, detections[j as number]?.box as Box)).toBeCloseTo(expected, 12);
    }
  });

  it('nms keeps the same detections in the same order', () => {
    for (const { threshold, keep } of g.nms) {
      const kept = nms(detections, threshold);
      expect(kept.map((d) => detections.indexOf(d))).toEqual(keep);
    }
  });

  it('bboxToCS', () => {
    detections.forEach((d, i) => {
      const cs = bboxToCS(d.box, 192 / 256, 1.25);
      const ref = g.bboxToCS[i] as { cx: number; cy: number; w: number; h: number };
      expect(cs.cx).toBeCloseTo(ref.cx, 9);
      expect(cs.cy).toBeCloseTo(ref.cy, 9);
      expect(cs.w).toBeCloseTo(ref.w, 9);
      expect(cs.h).toBeCloseTo(ref.h, 9);
      expect(cs.w / cs.h).toBeGreaterThanOrEqual(192 / 256 - 1e-9);
    });
  });

  it('oksPair', () => {
    expect(g.oksPair.length).toBeGreaterThan(50);
    for (const [i, j, expected] of g.oksPair as [number, number, number][]) {
      expect(oksPair(persons[i as number] as Pose, persons[j as number] as Pose)).toBeCloseTo(expected, 12);
    }
  });

  it('boxFromKeypoints', () => {
    for (const { threshold, boxes } of g.boxFromKps) {
      persons.forEach((p, i) => {
        expectBox(boxFromKeypoints(p.keypoints, threshold), boxes[i] as number[] | null);
      });
    }
  });

  it('propagate', () => {
    const input = g.propagateInput;
    const poses = syntheticPersons(input.seed, input.count, input.width, input.height, input.duplicateFraction).map(
      toPose,
    );
    const out = propagate(poses, input.frame[0] as number, input.frame[1] as number);
    expect(out).toHaveLength(g.propagate.length);
    out.forEach((o, i) => {
      const ref = g.propagate[i] as { box: number[]; score: number };
      expectBox(o.box, ref.box);
      expect(o.score).toBeCloseTo(ref.score, 9);
    });
  });
});

/** A standing person: joints on a vertical line through x, from y to y + height, all visible. */
function standing(x: number, y: number, height: number, score: number): Pose {
  const keypoints = new Float32Array(PERSON_KP_VALUES);
  for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++)
    keypoints.set([x + (k % 3), y + (height * k) / 25, 0.9], k * KP_VALUES);
  return { box: [x - height / 4, y, x + height / 4, y + height], score, keypoints };
}

describe('oksNms', () => {
  it('drops the lower-scoring one of two near-identical skeletons', () => {
    const a = standing(100, 100, 200, 0.9);
    const b = standing(101, 101, 198, 0.6);
    expect(oksNms([b, a], 0.6)).toEqual([a]);
  });

  it('keeps distinct people far apart', () => {
    const people = [standing(100, 100, 200, 0.9), standing(600, 120, 200, 0.8)];
    expect(oksNms(people, 0.6)).toHaveLength(2);
  });

  it('measures a small person against its own size, not the size of a large neighbour', () => {
    // 10 px is well inside the large person's tolerance but far outside the small one's.
    const large = standing(200, 100, 400, 0.9);
    const shifted = Float32Array.from(large.keypoints, (v, i) => (i % KP_VALUES === 0 ? v + 10 : v));
    const small: Pose = { box: [210, 300, 240, 380], score: 0.5, keypoints: shifted };
    expect(oksPair(large, small)).toBeGreaterThanOrEqual(0.6);
    expect(oksPair(small, large)).toBeLessThan(0.6);
    expect(oksNms([large, small], 0.6)).toHaveLength(2);
  });
});

describe('geometry edge cases', () => {
  it('iou of disjoint or degenerate boxes is 0', () => {
    expect(iou([0, 0, 1, 1], [2, 2, 3, 3])).toBe(0);
    expect(iou([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
  });

  it('boxFromKeypoints is null when no joint passes the threshold', () => {
    expect(boxFromKeypoints(new Float32Array(PERSON_KP_VALUES), 0.5)).toBeNull();
  });

  it('oksPair of a pose with itself is 1 and treats missing joints as misses', () => {
    const p = persons[0] as Pose;
    expect(oksPair(p, p)).toBeCloseTo(1, 12);
    const missing = Float32Array.from(p.keypoints);
    missing.fill(Number.NaN, 0, 3 * 17);
    expect(oksPair(p, { ...p, keypoints: missing })).toBe(0);
  });
});
