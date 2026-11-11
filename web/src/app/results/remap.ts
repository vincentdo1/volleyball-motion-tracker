import type { RenderPlayer } from '@/contracts/renderer';
import type { FrameSource } from '@/render';

type Rect = readonly [number, number, number, number];

/** Frames sampled per player; a dozen spread over the time on screen is enough to tell people apart. */
const SAMPLES = 12;
/** A match needs boxes that really overlap: a player standing near another one is not the same person. */
const MIN_IOU = 0.15;

/** The player's box, else the box around its finite keypoints; null when it has neither. */
function rectOf(player: RenderPlayer): Rect | null {
  if (player.box) return player.box;
  const kp = player.keypoints;
  if (!kp) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < kp.length; i += 3) {
    const x = kp[i] as number;
    const y = kp[i + 1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

function iou(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) {
    // two boxes with no area still match when they coincide (a marker drawn from a keypoint)
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] ? 1 : 0;
  }
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

function spread(frames: readonly number[], count: number): number[] {
  if (frames.length <= count) return [...frames];
  return Array.from({ length: count }, (_, k) => frames[Math.floor((k * (frames.length - 1)) / (count - 1))] as number);
}

/**
 * Maps player ids of the streamed view to the ids of the finalized result (which may renumber its tracks), by where
 * each player stands: at a dozen frames spread over the time the streamed player is on screen, the result's player
 * whose box overlaps it best gets a vote, and the id that wins a clear majority of the samples is the match. Players
 * stand on screen together, so timing alone cannot tell them apart. A pick without such a majority is left out.
 * `lanes` says in which frames each streamed player is present.
 */
export function remapTrackIds(
  ids: readonly number[],
  from: FrameSource,
  to: FrameSource,
  lanes: ReadonlyMap<number, Uint8Array>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const id of new Set(ids)) {
    const lane = lanes.get(id);
    if (!lane) continue;
    const present: number[] = [];
    for (let i = 0; i < lane.length; i++) if (lane[i] !== 0) present.push(i);
    const votes = new Map<number, number>();
    let counted = 0;
    for (const frame of spread(present, SAMPLES)) {
      const source = from.frameAt(frame).players.find((p) => p.trackId === id);
      const rect = source ? rectOf(source) : null;
      if (!rect) continue;
      counted++;
      let best = -1;
      let bestIou = MIN_IOU;
      for (const candidate of to.frameAt(frame).players) {
        const other = rectOf(candidate);
        const overlap = other ? iou(rect, other) : 0;
        if (overlap > bestIou) {
          bestIou = overlap;
          best = candidate.trackId;
        }
      }
      if (best >= 0) votes.set(best, (votes.get(best) ?? 0) + 1);
    }
    for (const [candidate, count] of votes) {
      if (count * 2 > counted) map.set(id, candidate);
    }
  }
  return map;
}
