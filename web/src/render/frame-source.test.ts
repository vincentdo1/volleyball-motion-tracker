import { describe, expect, it } from 'vitest';
import { HALPE26_INDEX, HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { TrackColumns } from '@/contracts/posetrack';
import type { RenderPlayer } from '@/contracts/renderer';
import { assessPose } from './assess';
import { BONE_STYLES } from './bones';
import { createFrameSource } from './frame-source';
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
