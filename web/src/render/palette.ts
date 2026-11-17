import { IDENTITY_PALETTE } from '@/contracts/renderer';
import { hexToRgb, mix, oklabDistance, type Rgb, rgba, WHITE } from './color';

const PALETTE_RGB: readonly Rgb[] = IDENTITY_PALETTE.map(hexToRgb);
const BLACK: Rgb = [0, 0, 0];

export const PALETTE_SIZE = PALETTE_RGB.length;

/**
 * Looks per hue: slot / 8 picks the variant. 0 is the plain hue; every reuse changes the colour itself, not only the
 * ring: 1 is a darker shade, 2 a lighter tint, 3 a deep shade (each also carries the second ring). The first reuse
 * (slot 8..15, the 9th player) is the one a viewer meets most, so it must not look like the plain hue: it did when it
 * only added a ring (gtu P1 and P9 were both cyan). 8 hues x 4 variants = 32 looks before one repeats exactly; the
 * variants of one hue stay at least MIN_VARIANT_DISTANCE apart in OKLab.
 */
export const VARIANT_COUNT = 4;
export const MIN_VARIANT_DISTANCE = 0.06;
const DARKER_SHADE = 0.4;
const LIGHTER_TINT = 0.6;
const DEEP_SHADE = 0.65;

/** Which variant of its hue a slot draws with (0 = plain). */
export function colorVariant(slot: number): number {
  return Math.floor(Math.max(0, slot) / PALETTE_SIZE) % VARIANT_COUNT;
}

/** Identity colour of a slot: the hue is `slot % 8`, repeats are told apart by `colorVariant` (tint, shade) and a ring. */
export function slotColor(slot: number): Rgb {
  const hue = PALETTE_RGB[((slot % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE] as Rgb;
  switch (colorVariant(slot)) {
    case 1:
      return mix(hue, BLACK, DARKER_SHADE);
    case 2:
      return mix(hue, WHITE, LIGHTER_TINT);
    case 3:
      return mix(hue, BLACK, DEEP_SHADE);
    default:
      return hue;
  }
}

/** The slot colour as a CSS string, for the DOM (player list, lanes). */
export function slotCss(slot: number): string {
  return rgba(slotColor(slot), 1);
}

/** Reused hues carry a second cue (a ring), so colour is never the only way to tell two players apart. */
export function isReusedSlot(slot: number): boolean {
  return slot >= PALETTE_SIZE;
}

export interface SlotTrack {
  readonly id: number;
  readonly firstPtsUs: number;
  readonly lastPtsUs: number;
}

/**
 * Every hue is held by an overlapping track: take the hue with the fewest held variants and its lowest free variant.
 * Only when all VARIANT_COUNT looks of every hue are held does an exact slot repeat (the least-held one, lowest slot).
 */
function reuseSlot(held: ReadonlyMap<number, number>): number {
  let bestHue = 0;
  let bestVariant = VARIANT_COUNT;
  let bestCount = Number.POSITIVE_INFINITY;
  for (let hue = 0; hue < PALETTE_SIZE; hue++) {
    let count = 0;
    let free = VARIANT_COUNT;
    for (let v = VARIANT_COUNT - 1; v >= 0; v--) {
      if (held.has(hue + v * PALETTE_SIZE)) count++;
      else free = v;
    }
    if (free < VARIANT_COUNT && count < bestCount) {
      bestCount = count;
      bestHue = hue;
      bestVariant = free;
    }
  }
  if (bestVariant < VARIANT_COUNT) return bestHue + bestVariant * PALETTE_SIZE;
  let fallback = 0;
  let fewest = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < PALETTE_SIZE * VARIANT_COUNT; slot++) {
    const n = held.get(slot) ?? 0;
    if (n < fewest) {
      fewest = n;
      fallback = slot;
    }
  }
  return fallback;
}

/**
 * Deterministic slot assignment (05 §2.4). Tracks are processed in birth order (ties by id). Each takes the free slot
 * that maximises the minimum OKLab distance to the slots of tracks it overlaps in time; ties go to the lowest slot.
 * When more than 8 tracks overlap, the hue with the fewest variants held by overlapping tracks (lowest index on ties)
 * gets its lowest variant no overlapping track holds, so two tracks on screen together never share a look while fewer
 * than 33 tracks overlap. A slot never changes once assigned.
 */
export function assignColorSlots(tracks: readonly SlotTrack[]): Map<number, number> {
  const ordered = [...tracks].sort((a, b) => a.firstPtsUs - b.firstPtsUs || a.id - b.id);
  const slots = new Map<number, number>();
  const placed: SlotTrack[] = [];
  for (const track of ordered) {
    const overlapping = placed.filter((p) => p.firstPtsUs <= track.lastPtsUs && track.firstPtsUs <= p.lastPtsUs);
    const used = new Map<number, number>();
    const heldSlots = new Map<number, number>(); // exact slot -> overlapping holders
    for (const p of overlapping) {
      const exact = slots.get(p.id) as number;
      const slot = exact % PALETTE_SIZE;
      used.set(slot, (used.get(slot) ?? 0) + 1);
      heldSlots.set(exact, (heldSlots.get(exact) ?? 0) + 1);
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
    if (bestScore === Number.NEGATIVE_INFINITY) best = reuseSlot(heldSlots);
    slots.set(track.id, best);
    placed.push(track);
  }
  return slots;
}
