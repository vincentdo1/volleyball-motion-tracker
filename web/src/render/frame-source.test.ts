import { describe, expect, it } from 'vitest';
import { HALPE26_INDEX, HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { TrackColumns } from '@/contracts/posetrack';
import type { RenderPlayer } from '@/contracts/renderer';
import { assessPose } from './assess';
import { BONE_STYLES } from './bones';
import {
  computeRefBoneLengths,
  createFrameSource,
  createPoseHistory,
  REF_WINDOW_US,
  windowBounds,
} from './frame-source';
import { syntheticFrameTable, syntheticScene, writePose } from './synthetic';

const scene = syntheticScene({ width: 1280, height: 720, fps: 30, frameCount: 60, players: 3 });

describe('createFrameSource', () => {
  const source = createFrameSource(scene);

  it('returns every player at the exact PTS of the frame', () => {
    const frame = source.frameAt(10);
    expect(frame.frameIndex).toBe(10);
    expect(frame.ptsUs).toBe(scene.frames.ptsUs[10]);
    expect(frame.players.map((p) => p.trackId)).toEqual([1, 2, 3]);
    expect(frame.players[0]?.keypoints?.length).toBe(78);
    expect(frame.players[0]?.refBoneLengths?.length).toBe(19);
  });

  it('omits a track that has no sample at the frame (no interpolation between samples)', () => {
    const t = scene.tracks[0];
    if (!t) throw new Error('missing track');
    const sparse = { ...t, ptsUs: t.ptsUs.map((v) => v + 1) };
    const frame = createFrameSource({ ...scene, tracks: [sparse] }).frameAt(5);
    expect(frame.players).toHaveLength(0);
  });

  it('builds a short, contiguous ball trail ending at the current ball', () => {
    const ball = source.frameAt(40).ball;
    expect(ball).not.toBeNull();
    const trail = ball?.trail;
    expect(trail?.length).toBe(2 * 16);
    expect(trail?.[trail.length - 2]).toBe(ball?.x);
  });

  it('stops the trail at a lost ball', () => {
    const lost = { ...scene.ball, visibility: scene.ball.visibility.slice() };
    lost.visibility[38] = 0;
    const trail = createFrameSource({ ...scene, ball: lost }).frameAt(40).ball?.trail;
    expect(trail?.length).toBe(2 * 2);
  });

  it('shortens the trail on request', () => {
    const trail = createFrameSource(scene, { ballTrailSeconds: 0.2 }).frameAt(40).ball?.trail;
    expect(trail?.length).toBe(2 * 7);
  });

  it('rejects an out-of-range frame', () => {
    expect(() => source.frameAt(60)).toThrow(RangeError);
  });
});

describe('reference bone lengths', () => {
  const samples = 60;
  const frames = syntheticFrameTable(30, samples);
  const boneIndex = (name: string) => BONE_STYLES.findIndex((b) => b.def.name === name);
  const shin = boneIndex('left_shin');

  /** One track walking towards the camera: its box (and so every bone) triples in height over the clip. */
  function approachingTrack(): TrackColumns {
    const kp = new Float32Array(samples * PERSON_KP_VALUES);
    const kpFlags = new Uint8Array(samples * HALPE26_NUM_KEYPOINTS);
    const box = new Float32Array(samples * 4);
    for (let i = 0; i < samples; i++) {
      const h = 100 + (200 * i) / (samples - 1);
      const b = [400, 100, 400 + h / 2.3, 100 + h] as const;
      box.set(b, i * 4);
      writePose(kp, i * PERSON_KP_VALUES, kpFlags, i * HALPE26_NUM_KEYPOINTS, { box: b, swing: 0, score: 0.9 });
    }
    return {
      id: 1,
      label: 'P1',
      colorSlot: 0,
      ptsUs: frames.ptsUs.slice(0, samples),
      box,
      boxScore: new Float32Array(samples).fill(0.9),
      kp,
      kpFlags,
      sampleFlags: new Uint8Array(samples),
    };
  }

  const shinLength = (track: TrackColumns, sample: number) => {
    const o = sample * PERSON_KP_VALUES;
    const a = HALPE26_INDEX.left_knee * 3;
    const b = HALPE26_INDEX.left_ankle * 3;
    return Math.hypot(
      (track.kp[o + a] as number) - (track.kp[o + b] as number),
      (track.kp[o + a + 1] as number) - (track.kp[o + b + 1] as number),
    );
  };

  it('follows a player whose apparent scale changes instead of using one clip-wide length', () => {
    const track = approachingTrack();
    const source = createFrameSource({ frames, tracks: [track], ball: null });
    for (const sample of [0, samples - 1]) {
      const ref = source.frameAt(sample).players[0]?.refBoneLengths?.[shin] as number;
      expect(ref / shinLength(track, sample)).toBeGreaterThan(0.75);
      expect(ref / shinLength(track, sample)).toBeLessThan(1.3);
      expect(assessPose(source.frameAt(sample).players[0] as RenderPlayer).level).toBe('full');
    }
  });

  it('still rejects a bone that jumps for a few frames', () => {
    const track = approachingTrack();
    const o = 30 * PERSON_KP_VALUES + HALPE26_INDEX.left_ankle * 3;
    track.kp[o + 1] = (track.kp[o + 1] as number) + 300;
    const player = createFrameSource({ frames, tracks: [track], ball: null }).frameAt(30).players[0];
    expect(assessPose(player as RenderPlayer).boneOk[shin]).toBe(false);
  });
});

/** A time window, not a sample count (review finding B1): the same motion gives the same references at any frame rate. */
describe('reference window in presentation time', () => {
  const durationS = 3;
  const left = BONE_STYLES.findIndex((b) => b.def.name === 'left_shin');

  /**
   * One 3 s track sampled at `fps` (or at the given PTS): every bone is `spacing(t)` px long, drawn between two joints
   * of full confidence.
   */
  function track(ptsUs: Float64Array, spacing: (tSeconds: number) => number): TrackColumns {
    const n = ptsUs.length;
    const kp = new Float32Array(n * PERSON_KP_VALUES);
    const kpFlags = new Uint8Array(n * HALPE26_NUM_KEYPOINTS);
    const box = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const h = spacing((ptsUs[i] as number) / 1e6);
      const b = [400, 100, 400 + h / 2.3, 100 + h] as const;
      box.set(b, i * 4);
      writePose(kp, i * PERSON_KP_VALUES, kpFlags, i * HALPE26_NUM_KEYPOINTS, { box: b, swing: 0, score: 0.9 });
    }
    return {
      id: 1,
      label: 'P1',
      colorSlot: 0,
      ptsUs,
      box,
      boxScore: new Float32Array(n).fill(0.9),
      kp,
      kpFlags,
      sampleFlags: new Uint8Array(n),
    };
  }

  const regular = (fps: number) =>
    Float64Array.from({ length: Math.round(durationS * fps) }, (_, i) => Math.round((i * 1e6) / fps));
  const at = (ptsUs: Float64Array, value: number) => ptsUs.indexOf(value);

  it('gives the same reference at 15, 30 and 60 fps (the probe of the review: spacing 3x during 1.0-1.4 s)', () => {
    const burst = (t: number) => (t >= 1.0 && t <= 1.4 ? 300 : 100);
    const refs = [15, 30, 60].map((fps) => {
      const pts = regular(fps);
      const ref = computeRefBoneLengths(track(pts, burst));
      return ref[at(pts, 1_200_000) * BONE_STYLES.length + left] as number;
    });
    // 0.4 s of the 1.0 s window is the burst: the median stays with the usual spacing, whatever the sample count.
    const first = refs[0] as number;
    expect(refs[1]).toBeCloseTo(first, 3);
    expect(refs[2]).toBeCloseTo(first, 3);
    // (the shin is 0.25 of the box height here, hence 100 x its template ratio)
    const reference = computeRefBoneLengths(track(regular(30), () => 100))[left] as number;
    expect(first).toBeCloseTo(reference, 3);
  });

  it('follows a burst that fills most of the window, at any rate', () => {
    const burst = (t: number) => (t >= 0.9 && t <= 1.6 ? 300 : 100);
    const refs = [15, 30, 60].map((fps) => {
      const pts = regular(fps);
      const ref = computeRefBoneLengths(track(pts, burst));
      return ref[at(pts, 1_200_000) * BONE_STYLES.length + left] as number;
    });
    const wide = computeRefBoneLengths(track(regular(30), () => 300))[left] as number;
    for (const ref of refs) expect(ref).toBeCloseTo(wide, 3);
  });

  it('selects irregular timestamps by their PTS, not their count', () => {
    // Dense bursts, long gaps and a dropped stretch, with the bone length changing from sample to sample.
    const pts: number[] = [];
    for (let t = 0; t < 600_000; t += 8_000) pts.push(t);
    for (let t = 600_000; t < 1_900_000; t += 190_000) pts.push(t);
    for (let t = 1_900_000; t < 2_400_000; t += 33_333) pts.push(Math.round(t));
    const ptsUs = Float64Array.from(pts);
    const spacing = (t: number) => 80 + ((t * 977) % 90);
    const t = track(ptsUs, spacing);
    const ref = computeRefBoneLengths(t);
    for (const s of [0, 20, 76, 80, 83, pts.length - 1]) {
      const near: number[] = [];
      for (let n = 0; n < pts.length; n++) {
        if (Math.abs((pts[n] as number) - (pts[s] as number)) <= REF_WINDOW_US) {
          const o = n * PERSON_KP_VALUES;
          const a = HALPE26_INDEX.left_knee * 3;
          const b = HALPE26_INDEX.left_ankle * 3;
          near.push(
            Math.hypot(
              (t.kp[o + a] as number) - (t.kp[o + b] as number),
              (t.kp[o + a + 1] as number) - (t.kp[o + b + 1] as number),
            ),
          );
        }
      }
      near.sort((x, y) => x - y);
      const mid = near.length >> 1;
      const expected =
        near.length % 2 ? (near[mid] as number) : ((near[mid - 1] as number) + (near[mid] as number)) / 2;
      expect(ref[s * BONE_STYLES.length + left]).toBeCloseTo(expected, 3);
    }
  });

  it('bounds the window at +-0.5 s of PTS, bounds included, for the references and the wrist-speed heights alike', () => {
    for (const fps of [15, 30, 60]) {
      const pts = regular(fps);
      const { from, to } = windowBounds(pts);
      const s = at(pts, 1_200_000);
      const first = pts[from[s] as number] as number;
      const last = pts[(to[s] as number) - 1] as number;
      expect(first).toBeGreaterThanOrEqual(700_000);
      expect(last).toBeLessThanOrEqual(1_700_000);
      expect(pts[(from[s] as number) - 1] as number).toBeLessThan(700_000);
      expect(pts[to[s] as number] as number).toBeGreaterThan(1_700_000);
    }
    const irregular = Float64Array.from([0, 100_000, 600_000, 600_001, 1_100_000, 5_000_000]);
    const { from, to } = windowBounds(irregular);
    expect(Array.from(from)).toEqual([0, 0, 1, 2, 2, 5]);
    expect(Array.from(to)).toEqual([2, 3, 5, 5, 5, 6]);
  });

  it('normalises the wrist speed by the same time window (the clip-wide p95 agrees across rates, within sampling noise)', () => {
    // The body grows 100 -> 400 px in two seconds while the wrists swing: the height neighbourhood matters.
    const p95 = (fps: number) => {
      const pts = regular(fps);
      const n = pts.length;
      const kp = new Float32Array(n * PERSON_KP_VALUES);
      const kpFlags = new Uint8Array(n * HALPE26_NUM_KEYPOINTS);
      const box = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const t = (pts[i] as number) / 1e6;
        const h = 100 + 150 * t;
        const b = [400, 100, 400 + h / 2.3, 100 + h] as const;
        box.set(b, i * 4);
        writePose(kp, i * PERSON_KP_VALUES, kpFlags, i * HALPE26_NUM_KEYPOINTS, {
          box: b,
          swing: (t * 2) % 1,
          score: 0.9,
        });
      }
      const columns: TrackColumns = {
        id: 1,
        label: 'P1',
        colorSlot: 0,
        ptsUs: pts,
        box,
        boxScore: new Float32Array(n).fill(0.9),
        kp,
        kpFlags,
        sampleFlags: new Uint8Array(n),
      };
      return createPoseHistory([columns], computeRefBoneLengths).wristSpeedP95(1) as number;
    };
    const slow = p95(30);
    expect(slow).toBeGreaterThan(0);
    expect(Math.abs(p95(60) / slow - 1)).toBeLessThan(0.08);
    expect(Math.abs(p95(15) / slow - 1)).toBeLessThan(0.12);
  });
});
