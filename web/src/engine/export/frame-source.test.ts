import { describe, expect, it } from 'vitest';
import { syntheticScene } from '@/render/synthetic';
import { frameSourceOf } from './mp4-export';

/** The export must hand the renderer what the results view hands it (gate inputs, hues, ball trail). */
describe('export frame source', () => {
  const scene = syntheticScene({ width: 1920, height: 1080, players: 10, fps: 30, frameCount: 60 });

  it('carries reference bone lengths for the plausibility gate', () => {
    const frame = frameSourceOf(scene).frameAt(30);
    expect(frame.players.length).toBeGreaterThan(0);
    for (const player of frame.players) expect(player.refBoneLengths).not.toBeNull();
  });

  it('keeps the colour slots the result carries, so the video matches the results view', () => {
    const slotOf = new Map(scene.tracks.map((t) => [t.id, (t.colorSlot + 3) % 32]));
    const shifted = { ...scene, tracks: scene.tracks.map((t) => ({ ...t, colorSlot: slotOf.get(t.id) ?? 0 })) };
    const players = frameSourceOf(shifted).frameAt(30).players;
    expect(players.length).toBeGreaterThan(8);
    for (const p of players) expect(p.colorSlot).toBe(slotOf.get(p.trackId));
  });

  it('draws a ball trail', () => {
    const ball = frameSourceOf(scene).frameAt(30).ball;
    expect(ball?.trail?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
