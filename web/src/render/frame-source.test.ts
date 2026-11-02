import { describe, expect, it } from 'vitest';
import { createFrameSource } from './frame-source';
import { syntheticScene } from './synthetic';

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
