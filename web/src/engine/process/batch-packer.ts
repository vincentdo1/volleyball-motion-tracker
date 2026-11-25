import { HALPE26_NUM_KEYPOINTS } from '@/contracts/halpe26';
import type { BallCandidate, BallFrameCandidates, TrackedPerson } from '@/contracts/pipeline';
import {
  BallSource,
  type BallSourceCode,
  BallVisibility,
  KeypointFlag,
  type PackedFrameBatch,
  SampleFlag,
} from '@/contracts/posetrack';
import { type PackFrameInput, packFrames } from '@/contracts/posetrack-codec';

/** One processed frame awaiting packing. */
export interface FrameRecord {
  readonly ptsUs: number;
  readonly durationUs: number;
  /** `FrameFlag` bits. */
  readonly flags: number;
  readonly persons: readonly TrackedPerson[];
  /** Ball-model candidates for this frame (arrive up to a ball window later). */
  ballModel: readonly BallCandidate[];
  /** COCO `sports ball` candidates from the person detector. */
  readonly ballDetector: readonly BallCandidate[];
}

function best(candidates: readonly BallCandidate[]): BallCandidate | null {
  let top: BallCandidate | null = null;
  for (const c of candidates) if (top === null || c.confidence > top.confidence) top = c;
  return top;
}

/** The ball sample a frame streams: the best ball-model blob, else the best detector ball, else none. */
export function pickBall(record: Pick<FrameRecord, 'ballModel' | 'ballDetector'>): BallCandidate | null {
  return best(record.ballModel) ?? best(record.ballDetector);
}

function sampleFlagsOf(person: TrackedPerson): number {
  let flags = 0;
  if (person.origin === 'propagated') flags |= SampleFlag.BOX_PROPAGATED;
  if (person.origin === 'detector-low') flags |= SampleFlag.LOW_SCORE_DETECTION;
  let present = false;
  for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
    if (!Number.isNaN(person.keypoints[k * 3] ?? Number.NaN)) {
      present = true;
      break;
    }
  }
  if (!present) flags |= SampleFlag.POSE_MISSING;
  return flags;
}

function kpFlagsOf(person: TrackedPerson, visibilityThreshold: number): Uint8Array {
  const flags = new Uint8Array(HALPE26_NUM_KEYPOINTS);
  for (let k = 0; k < HALPE26_NUM_KEYPOINTS; k++) {
    if (Number.isNaN(person.keypoints[k * 3] ?? Number.NaN)) flags[k] = KeypointFlag.MISSING;
    else if ((person.keypoints[k * 3 + 2] ?? 0) < visibilityThreshold) flags[k] = KeypointFlag.LOW_CONFIDENCE;
  }
  return flags;
}

function toPackFrame(record: FrameRecord, visibilityThreshold: number): PackFrameInput {
  const ball = pickBall(record);
  return {
    ptsUs: record.ptsUs,
    durationUs: record.durationUs,
    flags: record.flags,
    persons: record.persons.map((person) => ({
      trackId: person.trackId,
      box: person.box,
      boxScore: person.score,
      keypoints: person.keypoints,
      kpFlags: kpFlagsOf(person, visibilityThreshold),
      sampleFlags: sampleFlagsOf(person),
    })),
    ball: ball && {
      x: ball.x,
      y: ball.y,
      radius: ball.radius,
      confidence: ball.confidence,
      visibility: BallVisibility.VISIBLE,
      source: ball.source,
    },
  };
}

/** Raw (online-tracked) results of consecutive processed frames in the streamed/persisted layout. */
export function packBatch(records: readonly FrameRecord[], visibilityThreshold: number): PackedFrameBatch {
  return packFrames(records.map((record) => toPackFrame(record, visibilityThreshold)));
}

/** Ball samples of persisted/streamed batches as `FinalizeInput.ball` (one candidate per frame that has a ball). */
export function ballCandidatesOf(batches: readonly PackedFrameBatch[]): BallFrameCandidates[] {
  const out: BallFrameCandidates[] = [];
  for (const batch of batches) {
    for (let i = 0; i < batch.count; i++) {
      if (batch.ballVisibility[i] === BallVisibility.NONE) continue;
      const [x, y, radius, confidence] = batch.ball.subarray(i * 4, i * 4 + 4);
      out.push({
        ptsUs: batch.ptsUs[i] as number,
        candidates: [
          {
            x: x as number,
            y: y as number,
            radius: radius as number,
            confidence: confidence as number,
            source: (batch.ballSource[i] ?? BallSource.NONE) as BallSourceCode,
          },
        ],
      });
    }
  }
  return out;
}
