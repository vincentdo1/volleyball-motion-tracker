/**
 * Online multi-person tracker: ByteTrack's two-pass association (high-score detections first, then low-score ones
 * against the tracks still unmatched), OC-SORT's observation-centric re-update (ORU) and momentum (OCM), expanded
 * IoU rounds in the first pass (Deep-EIoU idea, reimplemented) and an OKS term when both sides have a skeleton.
 * Every time constant is in seconds and every Kalman step uses the real PTS difference, so ids do not depend on the
 * frame rate. Ids are handed out at birth; `confirmHits` / `confirmWindowS` only decide whether a young track
 * survives, the offline pass drops the short ones.
 */

import type { TrackerParams } from '@/contracts/params';
import type { OnlineTracker, RawPerson, TrackedPerson } from '@/contracts/pipeline';
import { type Box, iou, oksPair, type Pose } from '../geometry';
import { solveAssignment } from './assignment';
import { BoxFilter } from './box-filter';
import { carryPose, directionCost, expandedIou, hasUsablePose, type Motion, poseAwareCost } from './cost';

const US_PER_S = 1_000_000;
/** The second (low-score) pass matches on plain IoU and is stricter than the first: its detections are unreliable. */
const LOW_PASS_COST_MAX = 0.5;
/** A leftover detection overlapping a detection matched this frame by this much is a second box on that person. */
const BIRTH_OVERLAP_IOU = 0.5;
/** Look-back for a track's heading (OCM), in seconds. */
const HEADING_LOOKBACK_S = 0.3;
/** Smoothing of the estimated time between updates. */
const DT_SMOOTHING = 0.1;

interface Detection {
  readonly index: number;
  readonly person: RawPerson;
  readonly pose: boolean;
}

interface Observation {
  readonly ptsUs: number;
  readonly cx: number;
  readonly cy: number;
}

type Status = 'tentative' | 'tracked';

function lerpBox(a: Box, b: Box, t: number): Box {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

class Track {
  status: Status;
  /** Consecutive updates without a matching detection. */
  misses = 0;
  private filter: BoxFilter;
  /** Filter state right after the last detection, restored by ORU. */
  private anchor: BoxFilter;
  private filterUs: number;
  lastBox: Box;
  lastUs: number;
  private lastPose: Pose | null = null;
  private hitsUs: number[] = [];
  private history: Observation[] = [];
  predictedBox: Box;
  predictedPose: Pose | null = null;

  constructor(
    readonly id: number,
    person: RawPerson,
    ptsUs: number,
    confirmed: boolean,
  ) {
    this.status = confirmed ? 'tracked' : 'tentative';
    this.filter = BoxFilter.fromBox(person.box);
    this.anchor = this.filter.clone();
    this.filterUs = ptsUs;
    this.lastBox = person.box;
    this.lastUs = ptsUs;
    this.predictedBox = person.box;
    this.hitsUs.push(ptsUs);
    this.remember(person, hasUsablePose(person.keypoints), ptsUs);
  }

  get firstHitUs(): number {
    return this.hitsUs[0] as number;
  }

  predictTo(ptsUs: number) {
    this.filter.predict((ptsUs - this.filterUs) / US_PER_S, this.misses > 0);
    this.filterUs = ptsUs;
    this.predictedBox = this.filter.box();
    this.predictedPose = this.lastPose ? carryPose(this.lastPose, this.lastBox, this.predictedBox) : null;
  }

  /** Heading over the recent observations, in pixels (null while there is not enough history). */
  heading(): Motion | null {
    const last = this.history[this.history.length - 1] as Observation;
    const first = this.history[0] as Observation;
    if (first === last) return null;
    return { dx: last.cx - first.cx, dy: last.cy - first.cy };
  }

  observe(
    person: RawPerson,
    pose: boolean,
    ptsUs: number,
    typicalDtS: number,
    confirmSpanS: number,
    confirmHits: number,
  ) {
    if (this.misses > 0) this.reupdate(person.box, ptsUs, typicalDtS);
    else this.filter.update(person.box);
    this.anchor = this.filter.clone();
    this.filterUs = ptsUs;
    this.misses = 0;
    this.remember(person, pose, ptsUs);
    this.hitsUs.push(ptsUs);
    if (this.status === 'tentative') {
      this.hitsUs = this.hitsUs.filter((t) => ptsUs - t <= confirmSpanS * US_PER_S);
      if (this.hitsUs.length >= confirmHits) this.status = 'tracked';
    }
  }

  /**
   * OC-SORT ORU: after a gap the state restarts from the last real observation and replays virtual observations
   * interpolated towards the new detection, so the velocity estimate is not polluted by the coasting prediction.
   */
  private reupdate(box: Box, ptsUs: number, typicalDtS: number) {
    const gapS = (ptsUs - this.lastUs) / US_PER_S;
    const steps = Math.max(1, Math.round(gapS / typicalDtS));
    const filter = this.anchor.clone();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      filter.predict(gapS / steps, false);
      filter.update(lerpBox(this.lastBox, box, t));
    }
    this.filter = filter;
  }

  private remember(person: RawPerson, pose: boolean, ptsUs: number) {
    this.lastBox = person.box;
    this.lastUs = ptsUs;
    if (pose) this.lastPose = person;
    this.history.push({ ptsUs, cx: (person.box[0] + person.box[2]) / 2, cy: (person.box[1] + person.box[3]) / 2 });
    while (this.history.length > 1 && ptsUs - (this.history[0] as Observation).ptsUs > HEADING_LOOKBACK_S * US_PER_S)
      this.history.shift();
  }
}

export function createOnlineTracker(params: TrackerParams): OnlineTracker {
  let tracks: Track[] = [];
  let nextId = 1;
  let lastUs: number | null = null;
  /** Time between updates (smoothed); until two frames have been seen, as if the confirm window held its hits. */
  let typicalDtS = params.confirmWindowS / params.confirmHits;
  let seenDt = false;

  const confirmSpanS = () => Math.max(params.confirmWindowS, params.confirmHits * typicalDtS);
  const rounds = params.eiouExpansions.length > 0 ? params.eiouExpansions : [1];

  function cost(track: Track, d: Detection, expansion: number): number {
    const box = d.person.box;
    const eiou = expandedIou(track.predictedBox, box, expansion);
    // A coasting track's predicted skeleton is too uncertain to say who is who: only the boxes speak then.
    const oks = track.misses === 0 && track.predictedPose && d.pose ? oksPair(d.person, track.predictedPose) : null;
    const base = poseAwareCost(eiou, oks, params.costWeights);
    if (params.ocmWeight <= 0) return base;
    const step = {
      dx: (box[0] + box[2]) / 2 - (track.lastBox[0] + track.lastBox[2]) / 2,
      dy: (box[1] + box[3]) / 2 - (track.lastBox[1] + track.lastBox[3]) / 2,
    };
    return base + params.ocmWeight * directionCost(track.heading(), step, box[3] - box[1]);
  }

  /** Optimal one-to-one matching of `pool` against `dets`; returns the matched pairs. */
  function associate(pool: readonly Track[], dets: readonly Detection[], expansion: number, maxCost: number) {
    if (pool.length === 0 || dets.length === 0) return [];
    const matrix = pool.map((t) => dets.map((d) => cost(t, d, expansion)));
    return solveAssignment(matrix, maxCost).map(([i, j]) => [pool[i] as Track, dets[j] as Detection] as const);
  }

  function update(ptsUs: number, persons: readonly RawPerson[]): readonly TrackedPerson[] {
    if (lastUs !== null && ptsUs > lastUs) {
      const dtS = (ptsUs - lastUs) / US_PER_S;
      typicalDtS = seenDt ? typicalDtS + DT_SMOOTHING * (dtS - typicalDtS) : dtS;
      seenDt = true;
    }
    lastUs = ptsUs;
    for (const t of tracks) t.predictTo(ptsUs);

    const ids = new Int32Array(persons.length).fill(-1);
    const matchedTracks = new Set<Track>();
    const matchedDets = new Set<Detection>();
    const spanS = confirmSpanS();
    const apply = (pairs: readonly (readonly [Track, Detection])[]) => {
      for (const [track, det] of pairs) {
        track.observe(det.person, det.pose, ptsUs, typicalDtS, spanS, params.confirmHits);
        ids[det.index] = track.id;
        matchedTracks.add(track);
        matchedDets.add(det);
      }
    };

    const high: Detection[] = [];
    const low: Detection[] = [];
    persons.forEach((person, index) => {
      const det = { index, person, pose: hasUsablePose(person.keypoints) };
      if (person.score >= params.highScore) high.push(det);
      else if (person.score >= params.lowScore) low.push(det);
    });
    const free = <T>(items: readonly T[], used: Set<T>) => items.filter((x) => !used.has(x));

    // Pass 1: confirmed tracks (including lost ones) against high-score detections, growing the boxes each round.
    const confirmed = tracks.filter((t) => t.status === 'tracked');
    for (const expansion of rounds) {
      apply(associate(free(confirmed, matchedTracks), free(high, matchedDets), expansion, params.matchCostMax));
    }
    // Young tracks take what the confirmed ones left.
    const young = tracks.filter((t) => t.status === 'tentative');
    apply(associate(young, free(high, matchedDets), rounds[0] as number, params.matchCostMax));
    // Pass 2: tracks that were seen last time against the low-score detections, on plain IoU.
    const recent = tracks.filter((t) => t.misses === 0 && !matchedTracks.has(t));
    apply(associate(recent, low, 1, LOW_PASS_COST_MAX));

    for (const det of free(high, matchedDets)) {
      if (det.person.score < params.newTrackScore) continue;
      if ([...matchedDets].some((m) => iou(m.person.box, det.person.box) >= BIRTH_OVERLAP_IOU)) continue;
      const track = new Track(nextId++, det.person, ptsUs, params.confirmHits <= 1);
      track.predictTo(ptsUs);
      tracks.push(track);
      ids[det.index] = track.id;
    }

    for (const t of tracks) if (!matchedTracks.has(t) && t.lastUs !== ptsUs) t.misses++;
    tracks = tracks.filter((t) => {
      const unseenS = (ptsUs - t.lastUs) / US_PER_S;
      return unseenS <= (t.status === 'tracked' ? params.lostTtlS : spanS);
    });
    return persons.map((p, i) => ({ ...p, trackId: ids[i] as number }));
  }

  return {
    update,
    reset() {
      tracks = [];
      nextId = 1;
      lastUs = null;
      typicalDtS = params.confirmWindowS / params.confirmHits;
      seenDt = false;
    },
  };
}
