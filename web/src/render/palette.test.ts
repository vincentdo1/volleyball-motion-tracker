import { describe, expect, it } from 'vitest';
import { oklabDistance, type Rgb } from './color';
import {
  assignColorSlots,
  colorVariant,
  isReusedSlot,
  MIN_VARIANT_DISTANCE,
  PALETTE_SIZE,
  slotColor,
  VARIANT_COUNT,
} from './palette';

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
    // the 9th player is told apart from the player sharing its hue by colour, not by the ring alone
    expect(slotColor(values[8] as number)).not.toEqual(slotColor((values[8] as number) % PALETTE_SIZE));
  });
});

/** What a viewer sees of a slot: its colour and whether it carries the second ring. */
const look = (slot: number) => `${slotColor(slot).join(',')}${isReusedSlot(slot) ? ' ring' : ''}`;

describe('repeated hues', () => {
  it('tells apart every player of a crowd with a tint or shade, not only the ring', () => {
    const looks = new Set<string>();
    for (let slot = 0; slot < PALETTE_SIZE * VARIANT_COUNT; slot++) looks.add(look(slot));
    expect(looks.size).toBe(PALETTE_SIZE * VARIANT_COUNT);
    for (let hue = 0; hue < PALETTE_SIZE; hue++) {
      const variants = [0, 1, 2, 3].map((v) => slotColor(hue + v * PALETTE_SIZE));
      const [plain, dark, light, deep] = variants;
      // the first reuse (ring + shade) is already a different colour from the plain hue
      expect(dark).not.toEqual(plain);
      for (let c = 0; c < 3; c++) {
        expect(light?.[c] as number).toBeGreaterThanOrEqual(plain?.[c] as number);
        expect(dark?.[c] as number).toBeLessThanOrEqual(plain?.[c] as number);
        expect(deep?.[c] as number).toBeLessThanOrEqual(dark?.[c] as number);
      }
      for (let i = 0; i < variants.length; i++)
        for (let j = i + 1; j < variants.length; j++)
          expect(oklabDistance(variants[i] as Rgb, variants[j] as Rgb)).toBeGreaterThanOrEqual(MIN_VARIANT_DISTANCE);
    }
    expect(slotColor(PALETTE_SIZE * VARIANT_COUNT)).toEqual(slotColor(0));
    expect(colorVariant(61)).toBe(3);
  });

  it('assigns the next variant of the least-used hue when more than 16 tracks overlap', () => {
    const slots = [...assignColorSlots(Array.from({ length: 30 }, (_, i) => track(i + 1, 0, 1000))).values()];
    const looks = new Set(slots.map(look));
    expect(looks.size).toBe(30);
    expect(Math.max(...slots.map(colorVariant))).toBe(3);
  });
});

describe('assignColorSlots reuse', () => {
  it('does not repeat a slot when a plain-hue holder ends before a new track is placed (review #14)', () => {
    const tracks = [
      track(1, 0, 2_000_000),
      ...[2, 3, 4, 5, 6, 7, 8].map((id) => track(id, 0, 10_000_000)),
      track(9, 1_000_000, 10_000_000),
      track(10, 3_000_000, 10_000_000),
    ];
    const slots = assignColorSlots(tracks);
    expect(slots.get(9)).not.toBe(slots.get(10));
    expect(slots.get(9)).toBe(8);
    expect(slots.get(10)).toBe(0); // the plain look freed by track 1
    // stable and deterministic
    expect([...assignColorSlots([...tracks].reverse())].sort()).toEqual([...slots].sort());
  });

  it('repeats an exact slot only when every look is held by overlapping tracks', () => {
    const slots = assignColorSlots(Array.from({ length: 33 }, (_, i) => track(i + 1, 0, 1000)));
    expect(new Set([...slots.values()].slice(0, 32)).size).toBe(32);
    expect(slots.get(33)).toBeLessThan(PALETTE_SIZE * VARIANT_COUNT);
  });

  it('never gives two time-overlapping tracks one slot while at most 32 tracks are alive at once', () => {
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 200; round++) {
      const n = 5 + Math.floor(rand() * 60);
      const tracks = Array.from({ length: n }, (_, i) => {
        const first = Math.floor(rand() * 20_000);
        return track(i + 1, first, first + 500 + Math.floor(rand() * 8_000));
      });
      const alive = (t: number) => tracks.filter((x) => x.firstPtsUs <= t && t <= x.lastPtsUs).length;
      const maxAlive = Math.max(...tracks.map((x) => alive(x.firstPtsUs)));
      if (maxAlive > PALETTE_SIZE * VARIANT_COUNT) continue;
      const slots = assignColorSlots(tracks);
      for (const a of tracks)
        for (const b of tracks)
          if (a.id < b.id && a.firstPtsUs <= b.lastPtsUs && b.firstPtsUs <= a.lastPtsUs)
            expect(slots.get(a.id), `round ${round} tracks ${a.id}/${b.id}`).not.toBe(slots.get(b.id));
    }
  });
});
