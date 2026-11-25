/**
 * Tracking metrics against identity labels: IDF1 / IDP / IDR (global identity assignment, Ristani et al. 2016) and
 * CLEAR-MoT identity switches and fragmentations. Frames are keyed by PTS in integer microseconds, never by index.
 */
import { at } from './access.ts';
import { assign } from './assignment.ts';
import { iou } from './geometry.ts';
import type { Box } from './types.ts';

export interface TrackedPerson {
  id: number;
  box: Box;
}

export interface TrackFrame {
  ptsUs: number;
  persons: readonly TrackedPerson[];
  /** Labelled-away regions (teacher persons that are not ground truth): unmatched predictions there cost nothing. */
  ignore?: readonly Box[];
}

export interface TrackingOptions {
  /** A prediction matches a ground-truth person at this IoU. */
  iouThreshold: number;
  /** An unmatched prediction overlapping an ignore region this much is dropped. */
  ignoreIou: number;
}

export const DEFAULT_TRACKING_OPTIONS: TrackingOptions = { iouThreshold: 0.5, ignoreIou: 0.3 };

export interface IdSwitch {
  ptsUs: number;
  gtId: number;
  from: number;
  to: number;
}

export interface TrackingResult {
  frames: number;
  durationSeconds: number;
  gtDetections: number;
  predDetections: number;
  idtp: number;
  idfp: number;
  idfn: number;
  idf1: number;
  idp: number;
  idr: number;
  idSwitches: number;
  idSwitchesPerMinute: number;
  switches: IdSwitch[];
  /** Times a ground-truth identity went from matched to unmatched and back. */
  fragmentations: number;
  /** Ground-truth detections matched to some prediction (CLEAR-MoT, identity ignored). */
  matches: number;
}

const safeDivide = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** Drops predictions that overlap no GT person but sit in a labelled-away region. */
function withoutIgnored(
  gt: readonly TrackedPerson[],
  pred: readonly TrackedPerson[],
  ignore: readonly Box[],
  options: TrackingOptions,
): TrackedPerson[] {
  return pred.filter((p) => {
    if (gt.some((g) => iou(g.box, p.box) >= options.iouThreshold)) return true;
    return !ignore.some((region) => iou(region, p.box) >= options.ignoreIou);
  });
}

function pairKey(gtId: number, predId: number): string {
  return `${gtId}:${predId}`;
}

/** Per frame CLEAR-MoT matching: previous pairs are kept while still overlapping, the rest is assigned by IoU. */
function matchFrame(
  gt: readonly TrackedPerson[],
  pred: readonly TrackedPerson[],
  previous: ReadonlyMap<number, number>,
  options: TrackingOptions,
): Map<number, number> {
  const matched = new Map<number, number>();
  const usedPred = new Set<number>();
  for (const g of gt) {
    const wanted = previous.get(g.id);
    const p = wanted === undefined ? undefined : pred.find((candidate) => candidate.id === wanted);
    if (p && iou(g.box, p.box) >= options.iouThreshold) {
      matched.set(g.id, p.id);
      usedPred.add(p.id);
    }
  }
  const freeGt = gt.filter((g) => !matched.has(g.id));
  const freePred = pred.filter((p) => !usedPred.has(p.id));
  if (freeGt.length && freePred.length) {
    const cost = freeGt.map((g) =>
      freePred.map((p) => {
        const overlap = iou(g.box, p.box);
        return overlap >= options.iouThreshold ? 1 - overlap : 2;
      }),
    );
    assign(cost).forEach((col, row) => {
      const g = at(freeGt, row);
      const p = col >= 0 ? at(freePred, col) : undefined;
      if (p && at(at(cost, row), col) < 2) matched.set(g.id, p.id);
    });
  }
  return matched;
}

/** Overlap-frame counts for every (gt id, pred id) pair, the weights of the global identity assignment. */
function identityOverlap(
  frames: readonly { gt: readonly TrackedPerson[]; pred: readonly TrackedPerson[] }[],
  options: TrackingOptions,
): Map<string, number> {
  const overlap = new Map<string, number>();
  for (const { gt, pred } of frames) {
    for (const g of gt) {
      for (const p of pred) {
        if (iou(g.box, p.box) >= options.iouThreshold) {
          const key = pairKey(g.id, p.id);
          overlap.set(key, (overlap.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return overlap;
}

export function evaluateTracking(
  groundTruth: readonly TrackFrame[],
  predictions: readonly TrackFrame[],
  options: TrackingOptions = DEFAULT_TRACKING_OPTIONS,
): TrackingResult {
  const predByPts = new Map(predictions.map((frame) => [frame.ptsUs, frame]));
  const sorted = [...groundTruth].sort((a, b) => a.ptsUs - b.ptsUs);
  const frames = sorted.map((frame) => ({
    ptsUs: frame.ptsUs,
    gt: frame.persons,
    pred: withoutIgnored(frame.persons, predByPts.get(frame.ptsUs)?.persons ?? [], frame.ignore ?? [], options),
  }));

  const gtIds = [...new Set(frames.flatMap((f) => f.gt.map((p) => p.id)))];
  const predIds = [...new Set(frames.flatMap((f) => f.pred.map((p) => p.id)))];
  const overlap = identityOverlap(frames, options);
  const weights = gtIds.map((g) => predIds.map((p) => overlap.get(pairKey(g, p)) ?? 0));
  const idtp = assign(weights.map((row) => row.map((w) => -w))).reduce(
    (sum, col, row) => sum + (col >= 0 ? at(at(weights, row), col) : 0),
    0,
  );
  const gtDetections = frames.reduce((n, f) => n + f.gt.length, 0);
  const predDetections = frames.reduce((n, f) => n + f.pred.length, 0);

  let previous = new Map<number, number>();
  const lastMatched = new Map<number, number>();
  const wasMatched = new Map<number, boolean>();
  const switches: IdSwitch[] = [];
  let fragmentations = 0;
  let matches = 0;
  for (const frame of frames) {
    const matched = matchFrame(frame.gt, frame.pred, previous, options);
    for (const g of frame.gt) {
      const predId = matched.get(g.id);
      if (predId === undefined) {
        wasMatched.set(g.id, false);
        continue;
      }
      matches++;
      const last = lastMatched.get(g.id);
      if (last !== undefined && last !== predId) {
        switches.push({ ptsUs: frame.ptsUs, gtId: g.id, from: last, to: predId });
      }
      if (wasMatched.get(g.id) === false && last !== undefined) fragmentations++;
      lastMatched.set(g.id, predId);
      wasMatched.set(g.id, true);
    }
    previous = matched;
  }

  const first = sorted[0]?.ptsUs ?? 0;
  const last = sorted[sorted.length - 1]?.ptsUs ?? 0;
  const frameStepUs = sorted.length > 1 ? (last - first) / (sorted.length - 1) : 0;
  const durationSeconds = (last - first + frameStepUs) / 1_000_000;
  const idfp = predDetections - idtp;
  const idfn = gtDetections - idtp;
  return {
    frames: frames.length,
    durationSeconds,
    gtDetections,
    predDetections,
    idtp,
    idfp,
    idfn,
    idf1: safeDivide(2 * idtp, 2 * idtp + idfp + idfn),
    idp: safeDivide(idtp, predDetections),
    idr: safeDivide(idtp, gtDetections),
    idSwitches: switches.length,
    idSwitchesPerMinute: safeDivide(switches.length, durationSeconds / 60),
    switches,
    fragmentations,
    matches,
  };
}
