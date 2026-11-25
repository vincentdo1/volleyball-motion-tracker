import { describe, expect, it } from 'vitest';
import { linkRun } from '../harness/linker.ts';
import { evaluateTracking } from '../harness/tracking.ts';
import { applyOps, type LabelledClip, stableOnly, toTrackFrames } from '../harness/tracks.ts';
import type { Box } from '../harness/types.ts';

const SIZE = { width: 1920, height: 1080 };
const box = (x: number, y = 500): Box => [x, y, x + 50, y + 120];

describe('linkRun', () => {
  it('keeps one id per person through crossing-free motion and a detection dropout', () => {
    const frames = Array.from({ length: 30 }, (_, t) => {
      const boxes = [box(300 + 4 * t), box(900 - 4 * t)];
      return t >= 10 && t < 14 ? boxes.slice(1) : boxes;
    });
    const { frames: linked, flags } = linkRun(frames, SIZE);
    const ids = new Set(linked.flat().map((p) => p.id));
    expect(ids.size).toBe(2);
    expect(flags.some((f) => f.reason === 'gap')).toBe(true);
  });

  it('stitches a person whose detections vanish for half a second and come back nearby', () => {
    const frames = Array.from({ length: 40 }, (_, t) => (t >= 15 && t < 30 ? [] : [box(500 + t)]));
    const { frames: linked } = linkRun(frames, SIZE, {
      maxGapFrames: 2,
      minIou: 0.3,
      maxCentreDistance: 0.35,
      heightRatio: 1.5,
      weakIou: 0.5,
      ambiguityRatio: 0.7,
      maxStitchGapFrames: 20,
      stitchDistancePerFrame: 0.02,
      borderMargin: 0.04,
    });
    expect(new Set(linked.flat().map((p) => p.id)).size).toBe(1);
  });

  it('flags a mid-image birth for review and not one at the image border', () => {
    const { flags } = linkRun([[box(500)], [box(500), box(1000)], [box(500), box(1000), box(0)]], SIZE);
    const births = flags.filter((f) => f.reason === 'birth');
    expect(births.map((f) => f.frame)).toEqual([1]);
  });
});

function labelled(): LabelledClip {
  const frames = Array.from({ length: 10 }, (_, t) => ({
    ptsUs: t * 33_333,
    file: `f${t}.png`,
    persons: [
      { id: 1, box: box(100) },
      { id: t < 5 ? 2 : 3, box: box(400) },
    ],
    ignore: [],
  }));
  return { video: 'x.mp4', width: 1920, height: 1080, frames };
}

describe('applyOps', () => {
  const labels = { clips: { run: labelled() } };

  it('merges an id into another and renumbers by first appearance', () => {
    const merged = applyOps(labels, [{ op: 'merge', clip: 'run', from: 3, to: 2 }]);
    expect(new Set(merged.clips.run?.frames.flatMap((f) => f.persons.map((p) => p.id)))).toEqual(new Set([1, 2]));
  });

  it('splits an id from a PTS onward and keeps earlier frames', () => {
    const split = applyOps(labels, [{ op: 'split', clip: 'run', id: 1, fromPtsUs: 5 * 33_333, to: 9 }]);
    const ids = split.clips.run?.frames.map((f) => f.persons[0]?.id);
    expect(ids).toEqual([1, 1, 1, 1, 1, 3, 3, 3, 3, 3]);
  });

  it('drops an id into the ignore regions', () => {
    const dropped = applyOps(labels, [{ op: 'drop', clip: 'run', id: 3 }]);
    const frame = dropped.clips.run?.frames[7];
    expect(frame?.persons).toHaveLength(1);
    expect(frame?.ignore).toEqual([box(400)]);
  });

  it('refuses an operation that gives two persons of one frame the same id', () => {
    expect(() => applyOps(labels, [{ op: 'merge', clip: 'run', from: 2, to: 1 }])).toThrow(/used twice/);
  });

  it('does not mutate its input', () => {
    applyOps(labels, [{ op: 'drop', clip: 'run', id: 1 }]);
    expect(labels.clips.run.frames[0]?.persons).toHaveLength(2);
  });

  it('scores a tracker that reproduces the labels as perfect, and an id-swapping one as not', () => {
    const clip = labels.clips.run;
    const truth = toTrackFrames(clip);
    expect(evaluateTracking(truth, truth)).toMatchObject({ idf1: 1, idSwitches: 0 });
    const swapped = truth.map((frame, t) => ({
      ...frame,
      persons: frame.persons.map((p) => ({ ...p, id: t < 5 ? p.id : 5 - p.id })),
    }));
    expect(evaluateTracking(truth, swapped).idSwitches).toBeGreaterThan(0);
  });
});

describe('stableOnly', () => {
  it('turns short identities into ignore regions', () => {
    const stable = stableOnly(labelled(), 0.9);
    expect(stable.frames[0]?.persons.map((p) => p.id)).toEqual([1]);
    expect(stable.frames[0]?.ignore).toEqual([box(400)]);
  });
});
