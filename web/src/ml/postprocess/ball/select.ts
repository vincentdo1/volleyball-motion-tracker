/**
 * Ball selection: from the per-frame candidate lists to at most one ball per frame. Port of the phase-one picker
 * (`_choose_ball_candidate`, `_static_candidate_bins`, `_select_ball_series` in `pipeline.py`) with every frame count
 * turned into seconds and every pixel constant into a fraction of L = max(display width, height), the 1280 px /
 * 30 fps reference it was tuned at.
 */
import type { BallParams } from '@/contracts/params';
import type { BallCandidate, BallFrameCandidates } from '@/contracts/pipeline';

const US_PER_S = 1_000_000;

/** A chosen ball. */
export interface BallPick extends BallCandidate {
  readonly ptsUs: number;
}

/** Static false positives: bins (a fixed scene feature) that a candidate occupies for a large part of the clip. */
export function staticBins(frames: readonly BallFrameCandidates[], longSide: number, params: BallParams): Set<string> {
  if (frames.length === 0) return new Set();
  const binPx = params.staticBinFrac * longSide;
  const counts = new Map<string, number>();
  for (const frame of frames) {
    const seen = new Set(frame.candidates.map((c) => binKey(c, binPx)));
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const spanS =
    ((frames[frames.length - 1] as BallFrameCandidates).ptsUs - (frames[0] as BallFrameCandidates).ptsUs) / US_PER_S;
  // Occupied time = frames occupied x the typical step between candidate frames.
  const stepS = frames.length > 1 ? spanS / (frames.length - 1) : 0;
  const minS = Math.max(params.staticMinS, params.staticMinFrac * (spanS + stepS));
  const out = new Set<string>();
  for (const [key, count] of counts) if (count * stepS >= minS) out.add(key);
  return out;
}

function binKey(c: BallCandidate, binPx: number): string {
  return `${Math.floor(c.x / binPx)},${Math.floor(c.y / binPx)}`;
}

function best(candidates: readonly BallCandidate[]): BallCandidate | null {
  let top: BallCandidate | null = null;
  for (const c of candidates) if (top === null || c.confidence > top.confidence) top = c;
  return top;
}

/** Picks a candidate by trajectory continuity, not confidence alone. */
export function chooseCandidate(
  candidates: readonly BallCandidate[],
  ptsUs: number,
  last: BallPick | null,
  prev: BallPick | null,
  longSide: number,
  params: BallParams,
): BallCandidate | null {
  if (candidates.length === 0) return null;
  const gapS = last ? (ptsUs - last.ptsUs) / US_PER_S : Number.POSITIVE_INFINITY;
  if (!last || gapS > params.lockMaxAgeS) return best(candidates);

  let predX = last.x;
  let predY = last.y;
  if (prev && last.ptsUs > prev.ptsUs) {
    const dtS = (last.ptsUs - prev.ptsUs) / US_PER_S;
    predX += ((last.x - prev.x) / dtS) * gapS;
    predY += ((last.y - prev.y) / dtS) * gapS;
  }
  const steps = Math.min(Math.max(gapS * params.gateRefFps, 1), params.gateMaxSteps);
  const gate =
    Math.max(params.gateBaseFrac * longSide, last.radius * params.gateRadiusMult) * steps ** params.gateExponent;
  let chosen: BallCandidate | null = null;
  let chosenCost = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const dist = Math.hypot(c.x - predX, c.y - predY);
    if (dist > gate) continue;
    const radiusPenalty = Math.abs(c.radius - last.radius) / Math.max(last.radius, 1);
    const cost =
      dist / Math.max(gate, 1) + params.costRadiusWeight * radiusPenalty - params.costConfWeight * c.confidence;
    if (cost < chosenCost) {
      chosen = c;
      chosenCost = cost;
    }
  }
  if (chosen) return chosen;
  // After a longer miss a fresh lock is allowed; short far-away detections are better left for interpolation.
  return gapS > params.reacquireGapS ? best(candidates) : null;
}

/** One pick (or null) per candidate frame, in time order. */
export function selectSeries(
  frames: readonly BallFrameCandidates[],
  longSide: number,
  params: BallParams,
): (BallPick | null)[] {
  const bins = staticBins(frames, longSide, params);
  const binPx = params.staticBinFrac * longSide;
  const picks: (BallPick | null)[] = [];
  let last: BallPick | null = null;
  let prev: BallPick | null = null;
  for (const frame of frames) {
    const candidates = bins.size > 0 ? frame.candidates.filter((c) => !bins.has(binKey(c, binPx))) : frame.candidates;
    const chosen = chooseCandidate(candidates, frame.ptsUs, last, prev, longSide, params);
    const pick = chosen ? { ...chosen, ptsUs: frame.ptsUs } : null;
    if (pick) {
      prev = last;
      last = pick;
    }
    picks.push(pick);
  }
  return picks;
}
