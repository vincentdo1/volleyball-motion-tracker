import type { TrackerParams } from '@/contracts/params';
import type { OnlineTracker, RawPerson, TrackedPerson } from '@/contracts/pipeline';
import { SampleFlag } from '@/contracts/posetrack';
import { unpackPersons } from '@/contracts/posetrack-codec';
import { decodeBatches } from '../store/chunk-codec';
import type { Manifest, SessionStore } from '../store/session-store';

/** Extra media time replayed beyond the tracker's own memory, so track confirmation is warm too. */
const REPLAY_MARGIN_S = 0.5;

function sameBox(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
}

/**
 * Online tracker for a resumed run. A fresh tracker would number people from 1 again, so the stored frames of the
 * last `lostTtlS` are replayed into it and the ids it hands out are mapped back to the stored ones; people who
 * appear afterwards get ids above every stored id.
 */
export function resumeTracker(tracker: OnlineTracker, replayed: ReplayResult): OnlineTracker {
  const toStored = new Map(replayed.idMap);
  let nextId = replayed.maxStoredId + 1;
  return {
    update(ptsUs: number, persons: readonly RawPerson[]): readonly TrackedPerson[] {
      return tracker.update(ptsUs, persons).map((person) => {
        let id = toStored.get(person.trackId);
        if (id === undefined) {
          id = nextId++;
          toStored.set(person.trackId, id);
        }
        return { ...person, trackId: id };
      });
    },
    reset() {
      tracker.reset();
      toStored.clear();
    },
  };
}

export interface ReplayResult {
  /** Id the fresh tracker assigned -> id stored in the chunks. */
  readonly idMap: ReadonlyMap<number, number>;
  readonly maxStoredId: number;
}

/** Feeds the tail of the stored frames (the last `lostTtlS` + margin) into a fresh tracker. */
export async function replayStoredFrames(
  tracker: OnlineTracker,
  store: SessionStore,
  manifest: Manifest,
  params: Pick<TrackerParams, 'lostTtlS' | 'confirmWindowS'>,
): Promise<ReplayResult> {
  const last = [...manifest.chunks].sort((a, b) => a.startUs - b.startUs).at(-1);
  const idMap = new Map<number, number>();
  if (!last) return { idMap, maxStoredId: 0 };
  const batches = decodeBatches(await store.readChunk(last.startUs));
  const cutoffUs = last.endUs - (params.lostTtlS + params.confirmWindowS + REPLAY_MARGIN_S) * 1e6;
  let maxStoredId = 0;
  for (const batch of batches) {
    for (let i = 0; i < batch.count; i++) {
      const stored = unpackPersons(batch, i);
      for (const p of stored) maxStoredId = Math.max(maxStoredId, p.trackId);
      const ptsUs = batch.ptsUs[i] as number;
      if (ptsUs < cutoffUs) continue;
      const persons: RawPerson[] = stored.map((p) => ({
        box: [p.box[0] as number, p.box[1] as number, p.box[2] as number, p.box[3] as number],
        score: p.boxScore,
        keypoints: Float32Array.from(p.keypoints),
        origin:
          (p.sampleFlags & SampleFlag.BOX_PROPAGATED) !== 0
            ? 'propagated'
            : (p.sampleFlags & SampleFlag.LOW_SCORE_DETECTION) !== 0
              ? 'detector-low'
              : 'detector',
      }));
      const tracked = tracker.update(ptsUs, persons);
      for (const person of tracked) {
        const match = stored.find((p) => sameBox(p.box, person.box));
        if (match) idMap.set(person.trackId, match.trackId);
      }
    }
  }
  return { idMap, maxStoredId };
}
