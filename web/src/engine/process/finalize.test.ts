import { describe, expect, it } from 'vitest';
import { syntheticScene } from '@/render/synthetic';
import { withColorSlots } from './finalize';

/** Slots are assigned once at finalize; everything downstream (results view, overlays, exports) reads them. */
describe('withColorSlots', () => {
  const scene = syntheticScene({ width: 1920, height: 1080, players: 10, fps: 30, frameCount: 60 });

  it('gives tracks that overlap in time distinct slots, with variants past the eight hues', () => {
    const tracks = withColorSlots(scene.tracks.map((t) => ({ ...t, colorSlot: 0 })));
    const slots = tracks.map((t) => t.colorSlot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots.some((slot) => slot >= 8)).toBe(true);
  });

  it('changes nothing but the slot', () => {
    const tracks = withColorSlots(scene.tracks);
    tracks.forEach((t, i) => {
      const { colorSlot: _a, ...rest } = t;
      const { colorSlot: _b, ...before } = scene.tracks[i] as (typeof scene.tracks)[number];
      expect(rest).toEqual(before);
    });
  });

  it('is deterministic, so a resumed or re-exported result gets the same colours', () => {
    expect(withColorSlots(scene.tracks).map((t) => t.colorSlot)).toEqual(
      withColorSlots(withColorSlots(scene.tracks)).map((t) => t.colorSlot),
    );
  });
});
