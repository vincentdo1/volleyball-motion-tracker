/**
 * Tracklets: the per-id sample sequences of the online tracker, as `TrackColumns` (typed arrays, PTS ascending).
 * Helpers to collect them from the raw batches and to build new ones from selected samples.
 */
import { HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { PackedFrameBatch, TrackColumns } from '@/contracts/posetrack';

const US_PER_S = 1_000_000;

/** A sample of a tracklet, addressed by position. */
export interface SampleRef {
  readonly track: TrackColumns;
  readonly index: number;
}

export function sampleCount(track: TrackColumns): number {
  return track.ptsUs.length;
}

export function firstUs(track: TrackColumns): number {
  return track.ptsUs[0] as number;
}

export function lastUs(track: TrackColumns): number {
  return track.ptsUs[track.ptsUs.length - 1] as number;
}

export function durationS(track: TrackColumns): number {
  return (lastUs(track) - firstUs(track)) / US_PER_S;
}

export function boxHeight(track: TrackColumns, index: number): number {
  return (track.box[index * 4 + 3] as number) - (track.box[index * 4 + 1] as number);
}

export function boxCentre(track: TrackColumns, index: number): { cx: number; cy: number } {
  const b = index * 4;
  return {
    cx: ((track.box[b] as number) + (track.box[b + 2] as number)) / 2,
    cy: ((track.box[b + 1] as number) + (track.box[b + 3] as number)) / 2,
  };
}

export function emptyTrack(id: number, n: number): TrackColumns {
  return {
    id,
    label: `P${id}`,
    colorSlot: Math.max(0, id - 1),
    ptsUs: new Float64Array(n),
    box: new Float32Array(4 * n),
    boxScore: new Float32Array(n),
    kp: new Float32Array(PERSON_KP_VALUES * n),
    kpFlags: new Uint8Array(HALPE26_NUM_KEYPOINTS * n),
    sampleFlags: new Uint8Array(n),
  };
}

/** A tracklet made of the given samples, which must be in strictly increasing PTS order. */
export function fromSamples(id: number, samples: readonly SampleRef[]): TrackColumns {
  const track = emptyTrack(id, samples.length);
  samples.forEach(({ track: src, index: i }, k) => {
    track.ptsUs[k] = src.ptsUs[i] as number;
    track.box.set(src.box.subarray(i * 4, i * 4 + 4), k * 4);
    track.boxScore[k] = src.boxScore[i] as number;
    track.kp.set(src.kp.subarray(i * PERSON_KP_VALUES, (i + 1) * PERSON_KP_VALUES), k * PERSON_KP_VALUES);
    track.kpFlags.set(
      src.kpFlags.subarray(i * HALPE26_NUM_KEYPOINTS, (i + 1) * HALPE26_NUM_KEYPOINTS),
      k * HALPE26_NUM_KEYPOINTS,
    );
    track.sampleFlags[k] = src.sampleFlags[i] as number;
  });
  return track;
}

export function allSamples(track: TrackColumns): SampleRef[] {
  return Array.from({ length: sampleCount(track) }, (_, index) => ({ track, index }));
}

interface PersonRef {
  readonly batch: PackedFrameBatch;
  readonly frame: number;
  readonly person: number;
}

/** Groups the persons of the raw batches by online track id (unassigned persons, id < 0, are left out). */
export function collectTracklets(batches: readonly PackedFrameBatch[]): TrackColumns[] {
  const byId = new Map<number, PersonRef[]>();
  for (const batch of batches) {
    for (let frame = 0; frame < batch.count; frame++) {
      for (
        let person = batch.personOffsets[frame] as number;
        person < (batch.personOffsets[frame + 1] as number);
        person++
      ) {
        const id = batch.trackIds[person] as number;
        if (id < 0) continue;
        const list = byId.get(id) ?? [];
        list.push({ batch, frame, person });
        byId.set(id, list);
      }
    }
  }
  return [...byId.entries()].map(([id, refs]) => {
    const track = emptyTrack(id, refs.length);
    refs.forEach(({ batch, frame, person }, k) => {
      track.ptsUs[k] = batch.ptsUs[frame] as number;
      track.box.set(batch.boxes.subarray(person * 4, person * 4 + 4), k * 4);
      track.boxScore[k] = batch.boxScores[person] as number;
      track.kp.set(
        batch.keypoints.subarray(person * PERSON_KP_VALUES, (person + 1) * PERSON_KP_VALUES),
        k * PERSON_KP_VALUES,
      );
      track.kpFlags.set(
        batch.kpFlags.subarray(person * HALPE26_NUM_KEYPOINTS, (person + 1) * HALPE26_NUM_KEYPOINTS),
        k * HALPE26_NUM_KEYPOINTS,
      );
      track.sampleFlags[k] = batch.sampleFlags[person] as number;
    });
    return track;
  });
}
