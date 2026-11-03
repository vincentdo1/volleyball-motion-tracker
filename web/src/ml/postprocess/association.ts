/**
 * Offline association of the online tracklets (the whole clip is known): duplicate merge, stitching across gaps,
 * dropping short tracks and static objects, and renumbering by first appearance. All thresholds are in seconds (`TrackerParams`).
 */
import { HALPE26_NUM_KEYPOINTS, KP_VALUES, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { TrackerParams } from '@/contracts/params';
import type { TrackColumns } from '@/contracts/posetrack';
import { boxArea, iou, oksPair, type Pose } from '../geometry';
import { solveAssignment } from '../tracking/assignment';
import { hasUsablePose } from '../tracking/cost';
import {
  allSamples,
  boxCentre,
  boxHeight,
  durationS,
  firstUs,
  fromSamples,
  lastUs,
  type SampleRef,
  sampleCount,
} from './tracklets';

const US_PER_S = 1_000_000;
/** Heading estimate window at a tracklet's ends. */
const HEADING_WINDOW_S = 0.3;
/** Time constant over which a heading is trusted when predicting across a gap (a player who left view stops). */
const HEADING_DECAY_S = 0.5;
/** Two boxes this much on top of each other on a shared frame are one person boxed twice, whatever the skeletons say. */
const DUPLICATE_BOX_IOU = 0.6;
/** Stitch tolerance on the position error, in box heights: a base plus an allowance that grows with the gap. */
const STITCH_BASE_TOLERANCE_H = 0.5;
const STITCH_TOLERANCE_PER_S_H = 1.0;

/**
 * A static object (a net post, a pole) that the detector takes for a person: its box never moves and its skeleton
 * never fits. A track is dropped when, over at least `STATIC_MIN_DURATION_S`, the box centre stays within
 * `STATIC_MAX_SPREAD_H` box heights of its mean (a standing player sways more) and the mean joint score stays under
 * `STATIC_MAX_POSE_CONFIDENCE` (players score 0.55-0.7 on the bake-off clips, posts 0.08-0.4).
 */
const STATIC_MIN_DURATION_S = 1;
const STATIC_MAX_SPREAD_H = 0.05;
const STATIC_MAX_POSE_CONFIDENCE = 0.4;

function poseOf(track: TrackColumns, index: number): Pose {
  return {
    box: [
      track.box[index * 4] as number,
      track.box[index * 4 + 1] as number,
      track.box[index * 4 + 2] as number,
      track.box[index * 4 + 3] as number,
    ],
    score: track.boxScore[index] as number,
    keypoints: track.kp.subarray(index * PERSON_KP_VALUES, (index + 1) * PERSON_KP_VALUES),
  };
}

/** Whether two tracklets are one person boxed twice: skeletons (OKS) or boxes (IoU) agree on enough shared frames. */
function areDuplicates(a: TrackColumns, b: TrackColumns, params: TrackerParams): boolean {
  let shared = 0;
  let agreeing = 0;
  let i = 0;
  let j = 0;
  while (i < sampleCount(a) && j < sampleCount(b)) {
    const ta = a.ptsUs[i] as number;
    const tb = b.ptsUs[j] as number;
    if (ta < tb) i++;
    else if (ta > tb) j++;
    else {
      shared++;
      const pa = poseOf(a, i);
      const pb = poseOf(b, j);
      const sameSkeleton =
        hasUsablePose(pa.keypoints) &&
        hasUsablePose(pb.keypoints) &&
        (boxArea(pa.box) <= boxArea(pb.box) ? oksPair(pa, pb) : oksPair(pb, pa)) > params.duplicateOks;
      if (sameSkeleton || iou(pa.box, pb.box) >= DUPLICATE_BOX_IOU) agreeing++;
      i++;
      j++;
    }
  }
  return shared > 0 && agreeing / shared >= params.duplicateOverlapFrac;
}

/** Union of two tracklets in PTS order; where both have a sample for a frame the higher-scoring box wins. */
function union(id: number, a: TrackColumns, b: TrackColumns): TrackColumns {
  const out: SampleRef[] = [];
  let i = 0;
  let j = 0;
  while (i < sampleCount(a) || j < sampleCount(b)) {
    const ta = i < sampleCount(a) ? (a.ptsUs[i] as number) : Number.POSITIVE_INFINITY;
    const tb = j < sampleCount(b) ? (b.ptsUs[j] as number) : Number.POSITIVE_INFINITY;
    if (ta < tb) out.push({ track: a, index: i++ });
    else if (tb < ta) out.push({ track: b, index: j++ });
    else {
      out.push(
        (a.boxScore[i] as number) >= (b.boxScore[j] as number) ? { track: a, index: i } : { track: b, index: j },
      );
      i++;
      j++;
    }
  }
  return fromSamples(id, out);
}

function overlapsInTime(a: TrackColumns, b: TrackColumns): boolean {
  return firstUs(a) <= lastUs(b) && firstUs(b) <= lastUs(a);
}

/** Merges tracklets that are the same person boxed twice, until none are left. */
export function mergeDuplicates(tracklets: readonly TrackColumns[], params: TrackerParams): TrackColumns[] {
  const list = [...tracklets];
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length && !merged; j++) {
        const a = list[i] as TrackColumns;
        const b = list[j] as TrackColumns;
        if (!overlapsInTime(a, b) || !areDuplicates(a, b, params)) continue;
        const keep = firstUs(a) <= firstUs(b) ? a : b;
        list[i] = union(keep.id, a, b);
        list.splice(j, 1);
        merged = true;
      }
    }
  }
  return list;
}

interface End {
  readonly cx: number;
  readonly cy: number;
  readonly h: number;
  readonly vx: number;
  readonly vy: number;
}

/** Position, height and heading (px/s) at the last (`atEnd`) or first sample of a tracklet. */
function endOf(track: TrackColumns, atEnd: boolean): End {
  const n = sampleCount(track);
  const edge = atEnd ? n - 1 : 0;
  let other = edge;
  const step = atEnd ? -1 : 1;
  const window = HEADING_WINDOW_S * US_PER_S;
  for (
    let k = edge + step;
    k >= 0 && k < n && Math.abs((track.ptsUs[k] as number) - (track.ptsUs[edge] as number)) <= window;
    k += step
  )
    other = k;
  const { cx, cy } = boxCentre(track, edge);
  const dtS = ((track.ptsUs[edge] as number) - (track.ptsUs[other] as number)) / US_PER_S;
  if (other === edge || Math.abs(dtS) < 1e-3) return { cx, cy, h: boxHeight(track, edge), vx: 0, vy: 0 };
  const o = boxCentre(track, other);
  return { cx, cy, h: boxHeight(track, edge), vx: (cx - o.cx) / dtS, vy: (cy - o.cy) / dtS };
}

/** Stitch cost in [0, 1] (above 1 is not stitchable): forward and backward prediction error over the tolerance. */
function stitchCost(a: End, b: End, gapS: number): number {
  const travel = HEADING_DECAY_S * (1 - Math.exp(-gapS / HEADING_DECAY_S));
  const h = (a.h + b.h) / 2;
  const forward = Math.hypot(a.cx + a.vx * travel - b.cx, a.cy + a.vy * travel - b.cy) / h;
  const backward = Math.hypot(b.cx - b.vx * travel - a.cx, b.cy - b.vy * travel - a.cy) / h;
  const scale = Math.abs(Math.log(a.h / b.h));
  const tolerance = STITCH_BASE_TOLERANCE_H + STITCH_TOLERANCE_PER_S_H * gapS;
  return ((forward + backward) / 2 + scale) / tolerance;
}

/** Joins tracklets of one person split by an occlusion or a missed detection (gap up to `stitchMaxGapS`). */
export function stitch(tracklets: readonly TrackColumns[], params: TrackerParams): TrackColumns[] {
  const heads = tracklets.map((t) => endOf(t, false));
  const tails = tracklets.map((t) => endOf(t, true));
  const cost = tracklets.map((a, i) =>
    tracklets.map((b, j) => {
      const gapS = (firstUs(b) - lastUs(a)) / US_PER_S;
      if (i === j || gapS <= 0 || gapS > params.stitchMaxGapS) return Number.POSITIVE_INFINITY;
      return stitchCost(tails[i] as End, heads[j] as End, gapS);
    }),
  );
  const next = new Map(solveAssignment(cost, 1));
  const hasPredecessor = new Set(next.values());
  const chains: TrackColumns[] = [];
  tracklets.forEach((first, i) => {
    if (hasPredecessor.has(i)) return;
    const samples: SampleRef[] = [];
    for (let k: number | undefined = i; k !== undefined; k = next.get(k))
      samples.push(...allSamples(tracklets[k] as TrackColumns));
    chains.push(fromSamples(first.id, samples));
  });
  return chains;
}

/** Drops tracks shorter than `minTrackDurationS` (capped at half the clip so short clips keep their tracks). */
export function dropShort(
  tracklets: readonly TrackColumns[],
  params: TrackerParams,
  clipSpanS: number,
): TrackColumns[] {
  const minS = Math.min(params.minTrackDurationS, clipSpanS / 2);
  return tracklets.filter((t) => durationS(t) >= minS);
}

/** Mean joint score over a track's samples (missing joints count as 0). */
function meanPoseConfidence(track: TrackColumns): number {
  let sum = 0;
  for (let i = 0; i < sampleCount(track); i++) {
    for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
      const score = track.kp[i * PERSON_KP_VALUES + k * KP_VALUES + 2] as number;
      if (score > 0) sum += score;
    }
  }
  return sum / (sampleCount(track) * HALPE26_NUM_KEYPOINTS);
}

/** Spread of the box centre around its mean, in median box heights. */
function centreSpreadH(track: TrackColumns): number {
  const n = sampleCount(track);
  const centres = Array.from({ length: n }, (_, i) => boxCentre(track, i));
  const mx = centres.reduce((sum, c) => sum + c.cx, 0) / n;
  const my = centres.reduce((sum, c) => sum + c.cy, 0) / n;
  const variance = centres.reduce((sum, c) => sum + (c.cx - mx) ** 2 + (c.cy - my) ** 2, 0) / n;
  const heights = Array.from({ length: n }, (_, i) => boxHeight(track, i)).sort((a, b) => a - b);
  return Math.sqrt(variance) / (heights[Math.floor(n / 2)] as number);
}

/** Drops tracks that are static objects mistaken for people (see `STATIC_MIN_DURATION_S`). */
export function dropStaticObjects(tracklets: readonly TrackColumns[]): TrackColumns[] {
  return tracklets.filter(
    (t) =>
      durationS(t) < STATIC_MIN_DURATION_S ||
      centreSpreadH(t) >= STATIC_MAX_SPREAD_H ||
      meanPoseConfidence(t) >= STATIC_MAX_POSE_CONFIDENCE,
  );
}

/** Renumbers 1..n by first appearance (ties by previous id). */
export function renumber(tracklets: readonly TrackColumns[]): TrackColumns[] {
  return [...tracklets]
    .sort((a, b) => firstUs(a) - firstUs(b) || a.id - b.id)
    .map((t, k) => ({ ...t, id: k + 1, label: `P${k + 1}`, colorSlot: k }));
}

/** The whole offline association. */
export function associate(
  tracklets: readonly TrackColumns[],
  params: TrackerParams,
  clipSpanS: number,
): TrackColumns[] {
  return renumber(dropStaticObjects(dropShort(stitch(mergeDuplicates(tracklets, params), params), params, clipSpanS)));
}
