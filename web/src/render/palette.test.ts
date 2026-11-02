import { describe, expect, it } from 'vitest';
import { assignColorSlots, isReusedSlot, PALETTE_SIZE, slotColor } from './palette';

const track = (id: number, first: number, last: number) => ({ id, firstPtsUs: first, lastPtsUs: last });

describe('assignColorSlots', () => {
  it('is deterministic and independent of input order', () => {
    const tracks = [track(3, 200, 900), track(1, 0, 1000), track(2, 100, 500)];
    const a = assignColorSlots(tracks);
    const b = assignColorSlots([...tracks].reverse());
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('gives overlapping tracks distinct hues and lets disjoint tracks share', () => {
    const slots = assignColorSlots([track(1, 0, 100), track(2, 50, 200), track(3, 300, 400)]);
    expect(slots.get(1)).not.toBe(slots.get(2));
    expect(slots.get(3)).toBe(slots.get(1));
  });

  it('reuses hues with a flag only beyond eight simultaneous tracks', () => {
    const tracks = Array.from({ length: 12 }, (_, i) => track(i + 1, 0, 1000));
    const slots = assignColorSlots(tracks);
    const values = [...slots.values()];
    expect(values.slice(0, PALETTE_SIZE).every((s) => !isReusedSlot(s))).toBe(true);
    expect(new Set(values.slice(0, PALETTE_SIZE)).size).toBe(PALETTE_SIZE);
    expect(values.slice(PALETTE_SIZE).every(isReusedSlot)).toBe(true);
    expect(slotColor(values[8] as number)).toEqual(slotColor((values[8] as number) % PALETTE_SIZE));
  });
});
