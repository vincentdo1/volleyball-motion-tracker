import { describe, expect, it } from 'vitest';
import { HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { TrackColumns } from '@/contracts/posetrack';
import { BONE_STYLES } from '../../src/render/bones';
import { computeRefBoneLengths } from '../../src/render/frame-source';
import { writePose } from '../../src/render/synthetic';

/**
 * Codex review B1, checked independently of the builder's tests: the renderer's reference bone lengths (which gate
 * which bones are drawn and normalise the speed colours) come from a time window, so the same motion gives the same
 * reference at any sampling rate, and on irregular timestamps. A player grows from 100 to 220 px over 4 s (walking
 * towards the camera); the reference at a given time must follow the size at that time, not depend on the sample count.
 */
const BONE = BONE_STYLES.findIndex((b) => b.def.name === 'left_shin');
const DURATION_S = 4;
let stepMode = false;
const size = (t: number) => (stepMode ? (t < 1.0 ? 100 : 200) : 100 + 30 * t); // box height in px

function track(ptsUs: number[]): TrackColumns {
  const n = ptsUs.length;
  const kp = new Float32Array(n * PERSON_KP_VALUES);
  const kpFlags = new Uint8Array(n * HALPE26_NUM_KEYPOINTS);
  const box = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const h = size((ptsUs[i] as number) / 1e6);
    const b = [400, 100, 400 + h / 2.3, 100 + h] as const;
    box.set(b, i * 4);
    writePose(kp, i * PERSON_KP_VALUES, kpFlags, i * HALPE26_NUM_KEYPOINTS, { box: b, swing: 0, score: 0.9 });
  }
  return {
    id: 1,
    label: 'P1',
    colorSlot: 0,
    ptsUs: Float64Array.from(ptsUs),
    box,
    boxScore: new Float32Array(n).fill(0.9),
    kp,
    kpFlags,
    sampleFlags: new Uint8Array(n),
  };
}

const regular = (fps: number) =>
  Array.from({ length: Math.round(DURATION_S * fps) }, (_, i) => Math.round((i * 1e6) / fps));

/** Irregular timestamps: a seeded jitter of up to 40 % of the mean step, and optionally a 10x dense burst between 1.5 and 2.0 s. */
function irregular(withBurst: boolean): number[] {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const out: number[] = [];
  let t = 0;
  while (t < DURATION_S * 1e6) {
    out.push(Math.round(t));
    const burst = withBurst && t >= 1.5e6 && t < 2.0e6;
    t += (burst ? 1e6 / 240 : 1e6 / 24) * (0.8 + 0.4 * rnd());
  }
  return out;
}

/** The reference of the sample nearest to `atUs`. */
function refAt(ptsUs: number[], atUs: number): number {
  const ref = computeRefBoneLengths(track(ptsUs));
  let best = 0;
  for (let i = 1; i < ptsUs.length; i++)
    if (Math.abs((ptsUs[i] as number) - atUs) < Math.abs((ptsUs[best] as number) - atUs)) best = i;
  return ref[best * BONE_STYLES.length + BONE] as number;
}

describe('reference bone lengths are a function of time, not of the sample count (review B1)', () => {
  for (const atS of [1.0, 2.0, 3.0]) {
    it(`give the same reference at ${atS} s at 15, 24, 25, 30, 50, 60 and 120 fps and on irregular timestamps`, () => {
      const atUs = atS * 1e6;
      const reference = refAt(regular(30), atUs);
      expect(reference).toBeGreaterThan(0);
      for (const fps of [15, 24, 25, 50, 60, 120]) {
        expect(refAt(regular(fps), atUs), `${fps} fps`).toBeCloseTo(reference, 0);
      }
      // jittered timestamps: within 3 %
      const jittered = refAt(irregular(false), atUs);
      expect(Math.abs(jittered - reference) / reference, 'jittered PTS').toBeLessThan(0.03);
      // a 10x denser half second inside the window: the window is in time, the median inside it still counts samples,
      // so the reference leans towards the dense stretch (the review suggested time weighting for extreme VFR); bounded
      const bursty = refAt(irregular(true), atUs);
      expect(Math.abs(bursty - reference) / reference, 'bursty PTS').toBeLessThan(0.08);
    });
  }

  it('a step in size at 1.0 s: the reference 0.2 s later is the new size at every rate (a +-15-sample window is not)', () => {
    // a count-based +-15 window covers +-1 s at 15 fps (mostly the old size) but +-0.125 s at 120 fps (all new size)
    stepMode = true;
    try {
      const refs = [15, 24, 30, 60, 120].map((fps) => refAt(regular(fps), 1.2e6));
      for (const r of refs) expect(r).toBeCloseTo(refs[0] as number, 0);
      const before = refAt(regular(30), 0.5e6);
      expect(refs[0], 'the new size, about twice the old').toBeGreaterThan((before as number) * 1.8);
    } finally {
      stepMode = false;
    }
  });

  it('follows the size at the time: later in the clip the reference is larger', () => {
    const pts = regular(60);
    expect(refAt(pts, 3e6)).toBeGreaterThan(refAt(pts, 1e6) * 1.4);
  });
});
