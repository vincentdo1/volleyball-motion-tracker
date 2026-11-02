import { IDENTITY_PALETTE } from '@/contracts/renderer';
import { hexToRgb, oklabDistance, type Rgb } from './color';

const PALETTE_RGB: readonly Rgb[] = IDENTITY_PALETTE.map(hexToRgb);

export const PALETTE_SIZE = PALETTE_RGB.length;

/** Identity colour of a slot. Slots >= 8 reuse `slot % 8`; `isReusedSlot` tells the renderer to add a second cue. */
export function slotColor(slot: number): Rgb {
  return PALETTE_RGB[((slot % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE] as Rgb;
}

export function isReusedSlot(slot: number): boolean {
  return slot >= PALETTE_SIZE;
}

export interface SlotTrack {
  readonly id: number;
  readonly firstPtsUs: number;
  readonly lastPtsUs: number;
}

/**
 * Deterministic slot assignment (05 §2.4). Tracks are processed in birth order (ties by id). Each takes the free slot
 * that maximises the minimum OKLab distance to the slots of tracks it overlaps in time; ties go to the lowest slot.
 * When more than 8 tracks overlap, the least-used slot among the overlapping tracks is reused (lowest index on ties),
 * so reused hues stay as far apart in time and palette position as possible. A slot never changes once assigned.
 */
export function assignColorSlots(tracks: readonly SlotTrack[]): Map<number, number> {
  const ordered = [...tracks].sort((a, b) => a.firstPtsUs - b.firstPtsUs || a.id - b.id);
  const slots = new Map<number, number>();
  const placed: SlotTrack[] = [];
  for (const track of ordered) {
    const overlapping = placed.filter((p) => p.firstPtsUs <= track.lastPtsUs && track.firstPtsUs <= p.lastPtsUs);
    const used = new Map<number, number>();
    for (const p of overlapping) {
      const slot = (slots.get(p.id) as number) % PALETTE_SIZE;
      used.set(slot, (used.get(slot) ?? 0) + 1);
    }
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let slot = 0; slot < PALETTE_SIZE; slot++) {
      if (used.has(slot)) continue;
      let score = Number.POSITIVE_INFINITY;
      for (const other of used.keys()) {
        score = Math.min(score, oklabDistance(PALETTE_RGB[slot] as Rgb, PALETTE_RGB[other] as Rgb));
      }
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = slot;
      }
    }
    if (bestScore === Number.NEGATIVE_INFINITY) {
      // every hue is taken by an overlapping track: reuse the least-used one and flag it as reused (slot + 8)
      let least = 0;
      for (let slot = 1; slot < PALETTE_SIZE; slot++) {
        if ((used.get(slot) ?? 0) < (used.get(least) ?? 0)) least = slot;
      }
      best = least + PALETTE_SIZE;
    }
    slots.set(track.id, best);
    placed.push(track);
  }
  return slots;
}
