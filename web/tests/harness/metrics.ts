/**
 * Scoring against the fused teacher: a TypeScript port of the bake-off `metrics.mjs` (06_bakeoff §1.3). COCO-17 joints
 * only, because every candidate model has them. Pure functions, no I/O.
 */
import { at } from './access.ts';
import { boxArea, boxDiagonal, boxHeight, COCO_JOINTS, iou, sigma, TORSO } from './geometry.ts';
import type { Box, Keypoint, PredictedPerson, Target, TeacherFrame } from './types.ts';

export interface ScoringOptions {
  /** A joint counts as visible at or above this score. */
  visThr: number;
  /** A teacher person needs this many RTMPose-x joints to be a ground-truth person. */
  minGtKps: number;
  /** Both teachers must agree at least this OKS term for a joint to be "certain". */
  agreeKs: number;
  /** A prediction can match a GT person at this OKS ... */
  matchOks: number;
  /** ... or at this box IoU. */
  matchIou: number;
  /** An unmatched prediction overlapping a teacher box this much is not a likely false positive. */
  fpIou: number;
  /** Teacher boxes below this score are not ignore regions. */
  lowScore: number;
  /** Detectors that must support a teacher person (2 gives the "consensus" ground truth). */
  minSupport: number;
}

export const DEFAULT_OPTIONS: ScoringOptions = {
  visThr: 0.3,
  minGtKps: 8,
  agreeKs: 0.5,
  matchOks: 0.1,
  matchIou: 0.5,
  fpIou: 0.3,
  lowScore: 0.1,
  minSupport: 1,
};

/** Keypoint visibility in targets: 1 certain, 0 absent, -1 uncertain (only one teacher sees it). */
export interface GtPerson {
  box: Box;
  /** Fused target. */
  kps: Keypoint[];
  kpsR: Keypoint[];
  kpsV: Keypoint[];
  /** Joints used to match predictions to this person (RTMPose-x visible joints). */
  match: Keypoint[];
  support: readonly string[];
}

export interface FrameGt {
  gt: GtPerson[];
  /** Teacher persons that are not GT: predictions on them are neither hits nor false positives. */
  ignore: Box[];
  /** Low-score teacher boxes: same meaning. */
  low: Box[];
}

export function buildGt(frame: TeacherFrame, options: ScoringOptions = DEFAULT_OPTIONS): FrameGt {
  const gt: GtPerson[] = [];
  const ignore: Box[] = [];
  for (const person of frame.persons) {
    const kpsRAll = person.kpsR;
    const visibleR = kpsRAll.slice(0, COCO_JOINTS).filter((kp) => kp[2] >= options.visThr).length;
    if (visibleR < options.minGtKps || person.support.length < options.minSupport) {
      ignore.push(person.box);
      continue;
    }
    const area = boxArea(person.box) * 0.53;
    const kps: Keypoint[] = [];
    const kpsR: Keypoint[] = [];
    const kpsV: Keypoint[] = [];
    const match: Keypoint[] = [];
    for (let k = 0; k < COCO_JOINTS; k++) {
      const r = at(kpsRAll, k);
      const v = person.kpsV ? at(person.kpsV, k) : null;
      const rOk = r[2] >= options.visThr;
      const vSeen = v !== null && v[2] >= options.visThr ? v : null;
      kpsR.push([r[0], r[1], rOk ? 1 : 0]);
      kpsV.push(v ? [v[0], v[1], vSeen ? 1 : 0] : [0, 0, 0]);
      const agree =
        rOk &&
        vSeen !== null &&
        Math.exp(-((r[0] - vSeen[0]) ** 2 + (r[1] - vSeen[1]) ** 2) / (2 * area * (2 * sigma(k)) ** 2)) >=
          options.agreeKs;
      let fused: Keypoint;
      if (agree && vSeen) fused = [(r[0] + vSeen[0]) / 2, (r[1] + vSeen[1]) / 2, 1];
      else if (rOk) fused = [r[0], r[1], -1];
      else if (vSeen) fused = [vSeen[0], vSeen[1], -1];
      else fused = [r[0], r[1], 0];
      kps.push(fused);
      match.push(rOk ? [agree ? fused[0] : r[0], agree ? fused[1] : r[1], 1] : [0, 0, 0]);
    }
    gt.push({ box: person.box, kps, kpsR, kpsV, match, support: person.support });
  }
  const low = (frame.lowBoxes ?? []).filter((b) => b.score >= options.lowScore).map((b) => b.box);
  return { gt, ignore, low };
}

/** OKS of a prediction against target keypoints (certain joints only); area is the GT box area times 0.53. */
export function oks(target: readonly Keypoint[], gtBox: Box, prediction: readonly Keypoint[]): number {
  const area = boxArea(gtBox) * 0.53;
  let sum = 0;
  let count = 0;
  for (let k = 0; k < COCO_JOINTS; k++) {
    const t = at(target, k);
    if (t[2] !== 1) continue;
    const p = at(prediction, k);
    const s = 2 * sigma(k);
    sum += Math.exp(-((t[0] - p[0]) ** 2 + (t[1] - p[1]) ** 2) / (2 * area * s * s));
    count++;
  }
  return count ? sum / count : 0;
}

export interface MatchedPerson {
  predictionIndex: number;
  oks: number;
  iou: number;
}

export interface FrameMatching {
  /** GT index -> matched prediction. */
  matchedGt: Map<number, MatchedPerson>;
  matchedPredictions: Set<number>;
}

/** Greedy one-to-one matching by OKS on the teacher's matching joints; a pair needs OKS >= matchOks or IoU >= matchIou. */
export function matchFrame(
  gt: readonly GtPerson[],
  predictions: readonly PredictedPerson[],
  options: ScoringOptions = DEFAULT_OPTIONS,
): FrameMatching {
  const pairs: { oks: number; iou: number; gi: number; pi: number }[] = [];
  gt.forEach((g, gi) => {
    predictions.forEach((p, pi) => {
      const o = oks(g.match, g.box, p.kps);
      const u = iou(g.box, p.box);
      if (o >= options.matchOks || u >= options.matchIou) pairs.push({ oks: o, iou: u, gi, pi });
    });
  });
  pairs.sort((a, b) => b.oks - a.oks || b.iou - a.iou);
  const matchedGt = new Map<number, MatchedPerson>();
  const matchedPredictions = new Set<number>();
  for (const pair of pairs) {
    if (matchedGt.has(pair.gi) || matchedPredictions.has(pair.pi)) continue;
    matchedGt.set(pair.gi, { predictionIndex: pair.pi, oks: pair.oks, iou: pair.iou });
    matchedPredictions.add(pair.pi);
  }
  return { matchedGt, matchedPredictions };
}

/** Detection recall: GT persons matched one-to-one by IoU >= 0.5. */
export function boxHits(gt: readonly GtPerson[], predictions: readonly PredictedPerson[]): number {
  const pairs: { iou: number; gi: number; pi: number }[] = [];
  gt.forEach((g, gi) => {
    predictions.forEach((p, pi) => {
      const u = iou(g.box, p.box);
      if (u >= 0.5) pairs.push({ iou: u, gi, pi });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);
  const gUsed = new Set<number>();
  const pUsed = new Set<number>();
  for (const { gi, pi } of pairs) {
    if (!gUsed.has(gi) && !pUsed.has(pi)) {
      gUsed.add(gi);
      pUsed.add(pi);
    }
  }
  return gUsed.size;
}

/** [joints scored, within 0.1 of the GT box diagonal, within 0.05]. */
type JointCounts = [number, number, number];
type JointGroupName = 'all' | 'torso' | 'arms' | 'legs' | 'head' | 'wrists';

export interface Accumulator {
  frames: number;
  gt: number;
  hit50: number;
  hit75: number;
  boxHit: number;
  matched: number;
  oksSum: number;
  preds: number;
  unmatched: number;
  likelyFp: number;
  joints: Record<JointGroupName, JointCounts>;
  /** Every certain joint of every GT person, including those of unmatched persons (which count as misses). */
  jointsAllGt: JointCounts;
  scoreSum: number;
  scoreCount: number;
}

export function newAccumulator(): Accumulator {
  return {
    frames: 0,
    gt: 0,
    hit50: 0,
    hit75: 0,
    boxHit: 0,
    matched: 0,
    oksSum: 0,
    preds: 0,
    unmatched: 0,
    likelyFp: 0,
    joints: {
      all: [0, 0, 0],
      torso: [0, 0, 0],
      arms: [0, 0, 0],
      legs: [0, 0, 0],
      head: [0, 0, 0],
      wrists: [0, 0, 0],
    },
    jointsAllGt: [0, 0, 0],
    scoreSum: 0,
    scoreCount: 0,
  };
}

function groupOf(joint: number): Exclude<JointGroupName, 'all' | 'wrists'> {
  if (joint <= 4) return 'head';
  if (TORSO.includes(joint)) return 'torso';
  return joint <= 10 ? 'arms' : 'legs';
}

function targetKeypoints(person: GtPerson, target: Target): readonly Keypoint[] {
  return target === 'R' ? person.kpsR : target === 'V' ? person.kpsV : person.kps;
}

/** Adds one frame to `acc` and returns the GT-to-prediction matching (jitter needs it). */
export function scoreFrame(
  acc: Accumulator,
  frame: FrameGt,
  predictions: readonly PredictedPerson[],
  options: ScoringOptions = DEFAULT_OPTIONS,
  target: Target = 'fused',
): Map<number, MatchedPerson> {
  const { gt, ignore, low } = frame;
  const { matchedGt, matchedPredictions } = matchFrame(gt, predictions, options);
  acc.frames++;
  acc.gt += gt.length;
  acc.preds += predictions.length;
  acc.boxHit += boxHits(gt, predictions);
  gt.forEach((g, gi) => {
    const targetKps = targetKeypoints(g, target);
    const match = matchedGt.get(gi);
    const prediction = match ? at(predictions, match.predictionIndex) : null;
    if (prediction) {
      const o = oks(targetKps, g.box, prediction.kps);
      acc.matched++;
      acc.oksSum += o;
      if (o >= 0.5) acc.hit50++;
      if (o >= 0.75) acc.hit75++;
    }
    const diagonal = boxDiagonal(g.box);
    for (let k = 0; k < COCO_JOINTS; k++) {
      const t = at(targetKps, k);
      if (t[2] !== 1) continue;
      acc.jointsAllGt[0]++;
      if (!prediction) continue;
      const p = at(prediction.kps, k);
      const distance = Math.hypot(p[0] - t[0], p[1] - t[1]);
      const within10 = distance <= 0.1 * diagonal ? 1 : 0;
      const within05 = distance <= 0.05 * diagonal ? 1 : 0;
      acc.jointsAllGt[1] += within10;
      acc.jointsAllGt[2] += within05;
      const groups: JointGroupName[] = ['all', groupOf(k)];
      if (k === 9 || k === 10) groups.push('wrists');
      for (const group of groups) {
        const counts = acc.joints[group];
        counts[0]++;
        counts[1] += within10;
        counts[2] += within05;
      }
      acc.scoreSum += p[2];
      acc.scoreCount++;
    }
  });
  predictions.forEach((p, pi) => {
    if (matchedPredictions.has(pi)) return;
    acc.unmatched++;
    const plausible = [...ignore, ...low].some((b) => iou(b, p.box) >= options.fpIou);
    if (!plausible) acc.likelyFp++;
  });
  return matchedGt;
}

export interface Summary {
  frames: number;
  gtPersons: number;
  recall50: number | null;
  recall75: number | null;
  boxRecall: number | null;
  meanOksMatched: number | null;
  pck10: number | null;
  pck05: number | null;
  pck10All: number | null;
  pck05All: number | null;
  pck10Wrists: number | null;
  pck05Wrists: number | null;
  pck05Torso: number | null;
  pck05Arms: number | null;
  pck05Legs: number | null;
  meanKpScore: number | null;
  predsPerFrame: number | null;
  unmatchedPerFrame: number | null;
  likelyFpPerFrame: number | null;
  likelyFp: number;
}

/** Three-decimal ratio as printed in the bake-off tables; null when the denominator is zero. */
export const ratio = (numerator: number, denominator: number): number | null =>
  denominator ? Number((numerator / denominator).toFixed(3)) : null;

export function summarize(acc: Accumulator): Summary {
  const { joints } = acc;
  return {
    frames: acc.frames,
    gtPersons: acc.gt,
    recall50: ratio(acc.hit50, acc.gt),
    recall75: ratio(acc.hit75, acc.gt),
    boxRecall: ratio(acc.boxHit, acc.gt),
    meanOksMatched: ratio(acc.oksSum, acc.matched),
    pck10: ratio(joints.all[1], joints.all[0]),
    pck05: ratio(joints.all[2], joints.all[0]),
    pck10All: ratio(acc.jointsAllGt[1], acc.jointsAllGt[0]),
    pck05All: ratio(acc.jointsAllGt[2], acc.jointsAllGt[0]),
    pck10Wrists: ratio(joints.wrists[1], joints.wrists[0]),
    pck05Wrists: ratio(joints.wrists[2], joints.wrists[0]),
    pck05Torso: ratio(joints.torso[2], joints.torso[0]),
    pck05Arms: ratio(joints.arms[2], joints.arms[0]),
    pck05Legs: ratio(joints.legs[2], joints.legs[0]),
    meanKpScore: ratio(acc.scoreSum, acc.scoreCount),
    predsPerFrame: ratio(acc.preds, acc.frames),
    unmatchedPerFrame: ratio(acc.unmatched, acc.frames),
    likelyFpPerFrame: ratio(acc.likelyFp, acc.frames),
    likelyFp: acc.likelyFp,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Temporal jitter on the consecutive runs

/** Links GT persons frame to frame by greedy IoU >= 0.3 and returns one track id per GT person per frame. */
export function linkTracks(frames: readonly FrameGt[]): number[][] {
  let next = 0;
  const ids: number[][] = [];
  frames.forEach((frame, t) => {
    const current = frame.gt.map(() => -1);
    const previous = t > 0 ? at(frames, t - 1).gt : [];
    const previousIds = t > 0 ? at(ids, t - 1) : [];
    const pairs: { iou: number; i: number; j: number }[] = [];
    frame.gt.forEach((g, i) => {
      previous.forEach((h, j) => {
        const u = iou(g.box, h.box);
        if (u >= 0.3) pairs.push({ iou: u, i, j });
      });
    });
    pairs.sort((a, b) => b.iou - a.iou);
    const usedCurrent = new Set<number>();
    const usedPrevious = new Set<number>();
    for (const { i, j } of pairs) {
      if (usedCurrent.has(i) || usedPrevious.has(j)) continue;
      usedCurrent.add(i);
      usedPrevious.add(j);
      current[i] = at(previousIds, j);
    }
    for (let i = 0; i < current.length; i++) if (at(current, i) < 0) current[i] = next++;
    ids.push(current);
  });
  return ids;
}

export interface JitterFrame {
  gt: FrameGt;
  predictions: readonly PredictedPerson[];
  matchedGt: Map<number, MatchedPerson>;
}

interface JitterSums {
  n: number;
  pred: number;
  gt: number;
  err: number;
}

export interface JitterAccumulator {
  torso: JitterSums;
  all: JitterSums;
  triplets: number;
  brokenTriplets: number;
}

export const newJitterAccumulator = (): JitterAccumulator => ({
  torso: { n: 0, pred: 0, gt: 0, err: 0 },
  all: { n: 0, pred: 0, gt: 0, err: 0 },
  triplets: 0,
  brokenTriplets: 0,
});

/**
 * Second differences (acceleration) of predictions and of the teacher over consecutive frames, normalised by the GT
 * box height, on joints that are certain and matched in all three frames of a triplet.
 */
export function accumulateJitter(
  sequence: readonly JitterFrame[],
  ids: readonly number[][],
  acc: JitterAccumulator,
): void {
  for (let t = 1; t + 1 < sequence.length; t++) {
    const prevIds = at(ids, t - 1);
    const nextIds = at(ids, t + 1);
    at(ids, t).forEach((id, gi) => {
      const a = prevIds.indexOf(id);
      const c = nextIds.indexOf(id);
      if (a < 0 || c < 0) return;
      const [before, now, after] = [at(sequence, t - 1), at(sequence, t), at(sequence, t + 1)];
      const ga = at(before.gt.gt, a);
      const gb = at(now.gt.gt, gi);
      const gc = at(after.gt.gt, c);
      const ma = before.matchedGt.get(a);
      const mb = now.matchedGt.get(gi);
      const mc = after.matchedGt.get(c);
      if (!ma || !mb || !mc) {
        acc.brokenTriplets++;
        return;
      }
      const pa = at(before.predictions, ma.predictionIndex).kps;
      const pb = at(now.predictions, mb.predictionIndex).kps;
      const pc = at(after.predictions, mc.predictionIndex).kps;
      const height = boxHeight(gb.box);
      for (let k = 0; k < COCO_JOINTS; k++) {
        const [ta, tb, tc] = [at(ga.kps, k), at(gb.kps, k), at(gc.kps, k)];
        if (ta[2] !== 1 || tb[2] !== 1 || tc[2] !== 1) continue;
        const [qa, qb, qc] = [at(pa, k), at(pb, k), at(pc, k)];
        const ax = qc[0] - 2 * qb[0] + qa[0];
        const ay = qc[1] - 2 * qb[1] + qa[1];
        const gx = tc[0] - 2 * tb[0] + ta[0];
        const gy = tc[1] - 2 * tb[1] + ta[1];
        const predicted = Math.hypot(ax, ay) / height;
        const teacher = Math.hypot(gx, gy) / height;
        const error = Math.hypot(ax - gx, ay - gy) / height;
        for (const sums of TORSO.includes(k) ? [acc.torso, acc.all] : [acc.all]) {
          sums.n++;
          sums.pred += predicted;
          sums.gt += teacher;
          sums.err += error;
        }
      }
      acc.triplets++;
    });
  }
}

export interface JitterSummary {
  torso: JitterGroupSummary | null;
  all: JitterGroupSummary | null;
  triplets: number;
  brokenTriplets: number;
  /** Share of triplets whose three persons were all matched. */
  continuity: number | null;
}

export interface JitterGroupSummary {
  n: number;
  predAccelPct: number;
  teacherAccelPct: number;
  accelErrPct: number;
}

const pct = (sum: number, n: number): number => Number(((100 * sum) / n).toFixed(3));

export function summarizeJitter(acc: JitterAccumulator): JitterSummary {
  const group = (s: JitterSums): JitterGroupSummary | null =>
    s.n
      ? { n: s.n, predAccelPct: pct(s.pred, s.n), teacherAccelPct: pct(s.gt, s.n), accelErrPct: pct(s.err, s.n) }
      : null;
  const total = acc.triplets + acc.brokenTriplets;
  return {
    torso: group(acc.torso),
    all: group(acc.all),
    triplets: acc.triplets,
    brokenTriplets: acc.brokenTriplets,
    continuity: total ? Number((acc.triplets / total).toFixed(3)) : null,
  };
}
