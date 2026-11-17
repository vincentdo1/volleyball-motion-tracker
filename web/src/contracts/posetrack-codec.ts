/** Conversions between the columnar in-memory result and the PoseTrack v1 JSON document, plus semantic checks. */
import { indexAtOrBefore, isStrictlyIncreasing } from './frame-table';
import { HALPE26_KEYPOINTS, HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from './halpe26';
import {
  type BallColumns,
  type BallJson,
  type BallSourceCode,
  BallVisibility,
  type BallVisibilityCode,
  type FinalResult,
  KeypointFlag,
  type PackedFrameBatch,
  POSETRACK_FORMAT,
  type PoseTrackDocument,
  type TrackColumns,
  type TrackJson,
} from './posetrack';

/** Pixel values are written with 2 decimals, scores with 4. */
const PX_DIGITS = 2;
const SCORE_DIGITS = 4;

function rounded(value: number | undefined, digits: number): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function toNumber(value: number | null | undefined): number {
  return value ?? Number.NaN;
}

function encodeTrack(t: TrackColumns): TrackJson {
  const n = t.ptsUs.length;
  const kp: (number | null)[] = new Array<number | null>(n * PERSON_KP_VALUES);
  for (let i = 0; i < n * HALPE26_NUM_KEYPOINTS; i++) {
    kp[3 * i] = rounded(t.kp[3 * i], PX_DIGITS);
    kp[3 * i + 1] = rounded(t.kp[3 * i + 1], PX_DIGITS);
    kp[3 * i + 2] = rounded(t.kp[3 * i + 2], SCORE_DIGITS);
  }
  return {
    id: t.id,
    kind: 'person',
    label: t.label,
    colorSlot: t.colorSlot,
    firstPtsUs: t.ptsUs[0] ?? 0,
    lastPtsUs: t.ptsUs[n - 1] ?? 0,
    samples: {
      ptsUs: Array.from(t.ptsUs),
      box: Array.from(t.box, (v) => rounded(v, PX_DIGITS)),
      boxScore: Array.from(t.boxScore, (v) => rounded(v, SCORE_DIGITS) ?? 0),
      kp,
      kpFlags: Array.from(t.kpFlags),
      sampleFlags: Array.from(t.sampleFlags),
    },
  };
}

function encodeBall(b: BallColumns): BallJson {
  return {
    samples: {
      ptsUs: Array.from(b.ptsUs),
      xy: Array.from(b.xy, (v) => rounded(v, PX_DIGITS)),
      radius: Array.from(b.radius, (v) => rounded(v, PX_DIGITS)),
      confidence: Array.from(b.confidence, (v) => rounded(v, SCORE_DIGITS) ?? 0),
      visibility: Array.from(b.visibility) as BallVisibilityCode[],
      source: Array.from(b.source) as BallSourceCode[],
    },
  };
}

export function encodePoseTrack(result: FinalResult): PoseTrackDocument {
  return {
    ...result.header,
    frames: {
      ptsUs: Array.from(result.frames.ptsUs),
      durationUs: Array.from(result.frames.durationUs),
      flags: Array.from(result.frames.flags),
    },
    tracks: result.tracks.map(encodeTrack),
    ball: result.ball ? encodeBall(result.ball) : null,
  };
}

function decodeTrack(t: TrackJson): TrackColumns {
  return {
    id: t.id,
    label: t.label,
    colorSlot: t.colorSlot,
    ptsUs: Float64Array.from(t.samples.ptsUs),
    box: Float32Array.from(t.samples.box, toNumber),
    boxScore: Float32Array.from(t.samples.boxScore),
    kp: Float32Array.from(t.samples.kp, toNumber),
    kpFlags: Uint8Array.from(t.samples.kpFlags),
    sampleFlags: Uint8Array.from(t.samples.sampleFlags),
  };
}

function decodeBall(b: BallJson): BallColumns {
  return {
    ptsUs: Float64Array.from(b.samples.ptsUs),
    xy: Float32Array.from(b.samples.xy, toNumber),
    radius: Float32Array.from(b.samples.radius, toNumber),
    confidence: Float32Array.from(b.samples.confidence),
    visibility: Uint8Array.from(b.samples.visibility),
    source: Uint8Array.from(b.samples.source),
  };
}

export function decodePoseTrack(doc: PoseTrackDocument): FinalResult {
  const { frames, tracks, ball, ...header } = doc;
  return {
    header,
    frames: {
      ptsUs: Float64Array.from(frames.ptsUs),
      durationUs: Float64Array.from(frames.durationUs),
      flags: Uint8Array.from(frames.flags),
    },
    tracks: tracks.map(decodeTrack),
    ball: ball ? decodeBall(ball) : null,
  };
}

function inTable(table: readonly number[], pts: number): boolean {
  const i = indexAtOrBefore(table, pts);
  return i >= 0 && table[i] === pts;
}

/**
 * Rules JSON Schema cannot express: column lengths, PTS ordering and membership in the frame table, flag/null
 * consistency. Returns human-readable problems (empty = valid). Run after schema validation.
 */
export function validatePoseTrackSemantics(doc: PoseTrackDocument): string[] {
  const errors: string[] = [];
  const f = doc.frames;
  if (doc.format !== POSETRACK_FORMAT) errors.push(`format must be ${POSETRACK_FORMAT}`);
  if (f.durationUs.length !== f.ptsUs.length || f.flags.length !== f.ptsUs.length) {
    errors.push('frames: ptsUs, durationUs and flags must have the same length');
  }
  if (!isStrictlyIncreasing(f.ptsUs)) errors.push('frames.ptsUs must be strictly increasing');
  if (doc.clip.frameCount !== f.ptsUs.length) errors.push('clip.frameCount must equal the frame-table length');
  if (f.ptsUs.length > 0 && f.ptsUs[0] !== doc.clip.firstPtsUs)
    errors.push('clip.firstPtsUs must equal frames.ptsUs[0]');
  if (doc.coordinateSpace.width !== doc.clip.displayWidth || doc.coordinateSpace.height !== doc.clip.displayHeight) {
    errors.push('coordinateSpace must match the clip display size');
  }
  if (doc.skeleton.keypoints.join() !== HALPE26_KEYPOINTS.join()) errors.push('skeleton.keypoints must be Halpe26');

  const ids = new Set<number>();
  for (const t of doc.tracks) {
    const where = `track ${t.id}`;
    if (ids.has(t.id)) errors.push(`${where}: duplicate id`);
    ids.add(t.id);
    const s = t.samples;
    const n = s.ptsUs.length;
    if (s.box.length !== 4 * n) errors.push(`${where}: box must have 4 values per sample`);
    if (s.boxScore.length !== n) errors.push(`${where}: boxScore must have 1 value per sample`);
    if (s.kp.length !== PERSON_KP_VALUES * n)
      errors.push(`${where}: kp must have ${PERSON_KP_VALUES} values per sample`);
    if (s.kpFlags.length !== HALPE26_NUM_KEYPOINTS * n) errors.push(`${where}: kpFlags must have 26 values per sample`);
    if (s.sampleFlags.length !== n) errors.push(`${where}: sampleFlags must have 1 value per sample`);
    if (!isStrictlyIncreasing(s.ptsUs)) errors.push(`${where}: ptsUs must be strictly increasing`);
    if (s.ptsUs.some((p) => !inTable(f.ptsUs, p))) errors.push(`${where}: every ptsUs must be in the frame table`);
    if (n > 0 && (t.firstPtsUs !== s.ptsUs[0] || t.lastPtsUs !== s.ptsUs[n - 1])) {
      errors.push(`${where}: firstPtsUs/lastPtsUs must match the samples`);
    }
    for (let j = 0; j < Math.min(s.kpFlags.length, n * HALPE26_NUM_KEYPOINTS); j++) {
      const missing = ((s.kpFlags[j] ?? 0) & KeypointFlag.MISSING) !== 0;
      const isNull = s.kp[3 * j] === null || s.kp[3 * j + 1] === null;
      if (missing !== isNull) {
        errors.push(`${where}: joint value ${j} must be null exactly when flagged MISSING`);
        break;
      }
    }
  }

  if (doc.ball) {
    const s = doc.ball.samples;
    const n = s.ptsUs.length;
    if (s.xy.length !== 2 * n || s.radius.length !== n || s.confidence.length !== n) {
      errors.push('ball: xy must have 2 values and radius/confidence 1 value per sample');
    }
    if (s.visibility.length !== n || s.source.length !== n)
      errors.push('ball: visibility/source must have 1 value per sample');
    if (!isStrictlyIncreasing(s.ptsUs)) errors.push('ball: ptsUs must be strictly increasing');
    if (s.ptsUs.some((p) => !inTable(f.ptsUs, p))) errors.push('ball: every ptsUs must be in the frame table');
    for (let i = 0; i < n; i++) {
      const none = s.visibility[i] === BallVisibility.NONE;
      const isNull = s.xy[2 * i] === null || s.xy[2 * i + 1] === null;
      if (none !== isNull) {
        errors.push(`ball: sample ${i} must have null xy exactly when visibility is NONE`);
        break;
      }
    }
  }
  return errors;
}

export interface PackPersonInput {
  readonly trackId: number;
  readonly box: ArrayLike<number>;
  readonly boxScore: number;
  readonly keypoints: ArrayLike<number>;
  readonly kpFlags?: ArrayLike<number>;
  readonly sampleFlags?: number;
}

export interface PackFrameInput {
  readonly ptsUs: number;
  readonly durationUs: number;
  readonly flags: number;
  readonly persons: readonly PackPersonInput[];
  readonly ball: {
    readonly x: number;
    readonly y: number;
    readonly radius: number;
    readonly confidence: number;
    readonly visibility: BallVisibilityCode;
    readonly source: BallSourceCode;
  } | null;
}

/** Packs consecutive frames into one transferable batch. */
export function packFrames(frames: readonly PackFrameInput[]): PackedFrameBatch {
  const count = frames.length;
  const total = frames.reduce((sum, fr) => sum + fr.persons.length, 0);
  const batch: PackedFrameBatch = {
    stage: 'raw',
    count,
    ptsUs: new Float64Array(count),
    durationUs: new Float64Array(count),
    frameFlags: new Uint8Array(count),
    personOffsets: new Uint32Array(count + 1),
    trackIds: new Int32Array(total),
    boxes: new Float32Array(total * 4),
    boxScores: new Float32Array(total),
    keypoints: new Float32Array(total * PERSON_KP_VALUES),
    kpFlags: new Uint8Array(total * HALPE26_NUM_KEYPOINTS),
    sampleFlags: new Uint8Array(total),
    ball: new Float32Array(count * 4).fill(Number.NaN),
    ballVisibility: new Uint8Array(count),
    ballSource: new Uint8Array(count),
  };
  let p = 0;
  frames.forEach((fr, i) => {
    batch.ptsUs[i] = fr.ptsUs;
    batch.durationUs[i] = fr.durationUs;
    batch.frameFlags[i] = fr.flags;
    batch.personOffsets[i] = p;
    for (const person of fr.persons) {
      batch.trackIds[p] = person.trackId;
      batch.boxes.set(Array.from(person.box).slice(0, 4), p * 4);
      batch.boxScores[p] = person.boxScore;
      batch.keypoints.set(Array.from(person.keypoints).slice(0, PERSON_KP_VALUES), p * PERSON_KP_VALUES);
      if (person.kpFlags) batch.kpFlags.set(Array.from(person.kpFlags).slice(0, 26), p * HALPE26_NUM_KEYPOINTS);
      batch.sampleFlags[p] = person.sampleFlags ?? 0;
      p++;
    }
    if (fr.ball) {
      batch.ball.set([fr.ball.x, fr.ball.y, fr.ball.radius, fr.ball.confidence], i * 4);
      batch.ballVisibility[i] = fr.ball.visibility;
      batch.ballSource[i] = fr.ball.source;
    }
  });
  batch.personOffsets[count] = p;
  return batch;
}

export interface UnpackedPerson {
  readonly trackId: number;
  readonly box: Float32Array;
  readonly boxScore: number;
  readonly keypoints: Float32Array;
  readonly kpFlags: Uint8Array;
  readonly sampleFlags: number;
}

/** Persons of frame `index` as views into the batch (no copies). */
export function unpackPersons(batch: PackedFrameBatch, index: number): UnpackedPerson[] {
  const start = batch.personOffsets[index];
  const end = batch.personOffsets[index + 1];
  if (start === undefined || end === undefined) throw new RangeError(`frame index out of range: ${index}`);
  const out: UnpackedPerson[] = [];
  for (let p = start; p < end; p++) {
    out.push({
      trackId: batch.trackIds[p] ?? -1,
      box: batch.boxes.subarray(p * 4, p * 4 + 4),
      boxScore: batch.boxScores[p] ?? 0,
      keypoints: batch.keypoints.subarray(p * PERSON_KP_VALUES, (p + 1) * PERSON_KP_VALUES),
      kpFlags: batch.kpFlags.subarray(p * HALPE26_NUM_KEYPOINTS, (p + 1) * HALPE26_NUM_KEYPOINTS),
      sampleFlags: batch.sampleFlags[p] ?? 0,
    });
  }
  return out;
}

export function validatePackedFrameBatch(batch: PackedFrameBatch): string[] {
  const errors: string[] = [];
  const n = batch.count;
  const total = batch.personOffsets[n] ?? -1;
  if (batch.ptsUs.length !== n || batch.durationUs.length !== n || batch.frameFlags.length !== n) {
    errors.push('per-frame arrays must have count entries');
  }
  if (batch.personOffsets.length !== n + 1 || batch.personOffsets[0] !== 0)
    errors.push('personOffsets must start at 0');
  for (let i = 0; i < n; i++) {
    if ((batch.personOffsets[i + 1] ?? 0) < (batch.personOffsets[i] ?? 0))
      errors.push('personOffsets must not decrease');
  }
  if (batch.trackIds.length !== total || batch.boxScores.length !== total || batch.sampleFlags.length !== total) {
    errors.push('per-person arrays must have personOffsets[count] entries');
  }
  if (batch.boxes.length !== total * 4) errors.push('boxes must have 4 values per person');
  if (batch.keypoints.length !== total * PERSON_KP_VALUES) errors.push('keypoints must have 78 values per person');
  if (batch.kpFlags.length !== total * HALPE26_NUM_KEYPOINTS) errors.push('kpFlags must have 26 values per person');
  if (batch.ball.length !== n * 4 || batch.ballVisibility.length !== n || batch.ballSource.length !== n) {
    errors.push('ball arrays must have 4 values (ball) / 1 value per frame');
  }
  if (!isStrictlyIncreasing(batch.ptsUs)) errors.push('ptsUs must be strictly increasing');
  return errors;
}
