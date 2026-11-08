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

  it('gives overlapping players distinct slots, with variants past the eight hues', () => {
    const slots = frameSourceOf(scene)
      .frameAt(30)
      .players.map((p) => p.colorSlot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots.length).toBeGreaterThan(8);
    expect(slots.some((slot) => slot >= 8)).toBe(true);
  });

  it('draws a ball trail', () => {
    const ball = frameSourceOf(scene).frameAt(30).ball;
    expect(ball?.trail?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
