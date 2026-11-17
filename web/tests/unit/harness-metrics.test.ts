import { describe, expect, it } from 'vitest';
import { at } from '../harness/access.ts';
import {
  accumulateJitter,
  buildGt,
  linkTracks,
  newAccumulator,
  newJitterAccumulator,
  oks,
  scoreFrame,
  summarize,
  summarizeJitter,
} from '../harness/metrics.ts';
import type { Box, Keypoint, PredictedPerson, TeacherFrame, TeacherPerson } from '../harness/types.ts';

/** A 100x200 person: 17 joints on a grid inside the box, all confident, shifted by (dx, dy). */
function skeleton(x0: number, y0: number, dx = 0, dy = 0): Keypoint[] {
  return Array.from(
    { length: 17 },
    (_, k): Keypoint => [x0 + 10 + (k % 5) * 20 + dx, y0 + 10 + Math.floor(k / 5) * 40 + dy, 0.9],
  );
}

const boxAt = (x0: number, y0: number): Box => [x0, y0, x0 + 100, y0 + 200];

function teacherPerson(x0: number, y0: number): TeacherPerson {
  const kps = skeleton(x0, y0);
  return { box: boxAt(x0, y0), score: 0.9, support: ['yolox_x', 'rfdetr_l', 'dfine_x'], kpsR: kps, kpsV: kps };
}

const prediction = (x0: number, y0: number, dx = 0, dy = 0): PredictedPerson => ({
  box: boxAt(x0, y0),
  score: 0.9,
  kps: skeleton(x0, y0, dx, dy),
});

const frameWith = (...persons: TeacherPerson[]): TeacherFrame => ({ persons });

describe('buildGt', () => {
  it('keeps persons with enough RTMPose joints and turns the rest into ignore regions', () => {
    const faint = { ...teacherPerson(400, 0), kpsR: skeleton(400, 0).map((kp): Keypoint => [kp[0], kp[1], 0.1]) };
    const { gt, ignore } = buildGt(frameWith(teacherPerson(0, 0), faint));
    expect(gt).toHaveLength(1);
    expect(ignore).toEqual([faint.box]);
  });

  it('marks joints where the two teachers disagree as uncertain and excludes them from scoring', () => {
    const person = teacherPerson(0, 0);
    const disagreeing = (person.kpsR as Keypoint[]).map(
      (kp, k): Keypoint => (k === 9 ? [kp[0] + 80, kp[1], kp[2]] : kp),
    );
    const { gt } = buildGt(frameWith({ ...person, kpsV: disagreeing }));
    const fused = at(gt, 0).kps;
    expect(at(fused, 9)[2]).toBe(-1);
    expect(at(fused, 8)[2]).toBe(1);
    expect(oks(fused, person.box, skeleton(0, 0))).toBeCloseTo(1, 10);
  });

  it('requires detector support when minSupport is raised', () => {
    const lonely = { ...teacherPerson(0, 0), support: ['yolox_x'] };
    const options = {
      visThr: 0.3,
      minGtKps: 8,
      agreeKs: 0.5,
      matchOks: 0.1,
      matchIou: 0.5,
      fpIou: 0.3,
      lowScore: 0.1,
      minSupport: 2,
    };
    expect(buildGt(frameWith(lonely), options).gt).toHaveLength(0);
  });
});

describe('scoreFrame', () => {
  const frame = buildGt(frameWith(teacherPerson(0, 0), teacherPerson(300, 0)));

  it('scores a perfect prediction as full recall and PCK with no false positives', () => {
    const acc = newAccumulator();
    scoreFrame(acc, frame, [prediction(0, 0), prediction(300, 0)]);
    expect(summarize(acc)).toMatchObject({ recall50: 1, recall75: 1, boxRecall: 1, pck10: 1, pck05: 1, likelyFp: 0 });
  });

  it('counts a missed person against recall and against all-GT PCK only', () => {
    const acc = newAccumulator();
    scoreFrame(acc, frame, [prediction(0, 0)]);
    expect(summarize(acc)).toMatchObject({ recall50: 0.5, pck05: 1, pck05All: 0.5 });
  });

  it('applies PCK thresholds relative to the GT box diagonal', () => {
    const diagonal = Math.hypot(100, 200);
    const near = newAccumulator();
    scoreFrame(near, frame, [prediction(0, 0, 0.04 * diagonal, 0), prediction(300, 0)]);
    expect(summarize(near).pck05).toBe(1);
    const far = newAccumulator();
    scoreFrame(far, frame, [prediction(0, 0, 0.07 * diagonal, 0), prediction(300, 0)]);
    const s = summarize(far);
    expect(s.pck10).toBe(1);
    expect(s.pck05).toBeLessThan(1);
  });

  it('treats an unmatched prediction on an ignore region as neutral and elsewhere as a likely false positive', () => {
    const withIgnore = buildGt({
      persons: [
        teacherPerson(0, 0),
        { ...teacherPerson(600, 0), kpsR: skeleton(600, 0).map((kp): Keypoint => [kp[0], kp[1], 0.1]) },
      ],
    });
    const acc = newAccumulator();
    scoreFrame(acc, withIgnore, [prediction(0, 0), prediction(600, 0), prediction(1200, 0)]);
    expect(acc).toMatchObject({ unmatched: 2, likelyFp: 1 });
  });

  it('does not match one prediction to two GT persons', () => {
    const acc = newAccumulator();
    scoreFrame(acc, frame, [prediction(0, 0)]);
    expect(acc.matched).toBe(1);
  });
});

describe('jitter', () => {
  /** One person drifting right by `step` px per frame, predictions offset by `noise(t)`. */
  function run(frames: number, noise: (t: number) => number) {
    const teacher = Array.from({ length: frames }, (_, t) => buildGt(frameWith(teacherPerson(5 * t, 0))));
    const sequence = teacher.map((gt, t) => {
      const predictions = [prediction(5 * t, 0, noise(t), 0)];
      return { gt, predictions, matchedGt: scoreFrame(newAccumulator(), gt, predictions) };
    });
    const acc = newJitterAccumulator();
    accumulateJitter(sequence, linkTracks(teacher), acc);
    return summarizeJitter(acc);
  }

  it('links the same person across frames under one id', () => {
    const frames = Array.from({ length: 4 }, (_, t) => buildGt(frameWith(teacherPerson(5 * t, 0))));
    expect(linkTracks(frames)).toEqual([[0], [0], [0], [0]]);
  });

  it('reports zero acceleration error for predictions that follow the teacher exactly', () => {
    const s = run(6, () => 0);
    expect(s.all?.accelErrPct).toBe(0);
    expect(s.continuity).toBe(1);
  });

  it('reports positive acceleration error for jittering predictions, torso included', () => {
    const s = run(6, (t) => (t % 2 === 0 ? 3 : -3));
    expect(s.torso?.accelErrPct).toBeGreaterThan(0);
    expect(s.all?.predAccelPct).toBeGreaterThan(s.all?.teacherAccelPct ?? 0);
  });
});
