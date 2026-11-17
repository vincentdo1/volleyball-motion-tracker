import { describe, expect, it } from 'vitest';
import { INITIAL_TRACKER_PARAMS } from '@/contracts/params';
import type { OnlineTracker, RawPerson, TrackedPerson } from '@/contracts/pipeline';
import { packFrames } from '@/contracts/posetrack-codec';
import { encodeBatch } from '../store/chunk-codec';
import type { Manifest, SessionStore } from '../store/session-store';
import { replayStoredFrames, resumeTracker } from './tracker-resume';

/** Hands out ids in order of first sight, keyed by box x0 (a stand-in for appearance). */
function fakeTracker(): OnlineTracker {
  const ids = new Map<number, number>();
  return {
    update: (_pts, persons): readonly TrackedPerson[] =>
      persons.map((p) => {
        const key = Math.round(p.box[0] / 100);
        if (!ids.has(key)) ids.set(key, ids.size + 1);
        return { ...p, trackId: ids.get(key) as number };
      }),
    reset: () => ids.clear(),
  };
}

const person = (x0: number): RawPerson => ({
  box: [x0, 0, x0 + 10, 10],
  score: 0.9,
  keypoints: new Float32Array(78),
  origin: 'detector',
});

function storeWith(bytes: Uint8Array): SessionStore {
  return { readChunk: async () => bytes } as unknown as SessionStore;
}

describe('resumeTracker', () => {
  it('keeps stored ids for people already tracked and numbers newcomers above them', async () => {
    // Stored: ids 5 and 9 at x 100 and 300 (the original run saw other people before, so ids are not 1..n).
    const frames = [0, 1, 2].map((i) => ({
      ptsUs: 9_000_000 + i * 33_333,
      durationUs: 33_333,
      flags: 3,
      persons: [
        { trackId: 5, box: [100, 0, 110, 10], boxScore: 0.9, keypoints: new Array(78).fill(0) },
        { trackId: 9, box: [300, 0, 310, 10], boxScore: 0.9, keypoints: new Array(78).fill(0) },
      ],
      ball: null,
    }));
    const manifest = { chunks: [{ startUs: 0, endUs: 10_000_000, frames: 3, bytes: 0 }] } as unknown as Manifest;
    const fresh = fakeTracker();
    const replayed = await replayStoredFrames(
      fresh,
      storeWith(encodeBatch(packFrames(frames))),
      manifest,
      INITIAL_TRACKER_PARAMS,
    );
    expect(replayed.maxStoredId).toBe(9);
    const tracker = resumeTracker(fresh, replayed);
    const out = tracker.update(10_000_000, [person(300), person(100), person(500)]);
    expect(out.map((p) => p.trackId)).toEqual([9, 5, 10]);
    expect(tracker.update(10_033_333, [person(500)])[0]?.trackId).toBe(10);
  });

  it('only replays the stored tail', async () => {
    const frames = [0, 1].map((i) => ({
      ptsUs: i === 0 ? 1_000_000 : 9_900_000,
      durationUs: 33_333,
      flags: 3,
      persons: [
        { trackId: 1 + i, box: [100 * (i + 1), 0, 110 * (i + 1), 10], boxScore: 0.9, keypoints: new Array(78).fill(0) },
      ],
      ball: null,
    }));
    const manifest = { chunks: [{ startUs: 0, endUs: 10_000_000, frames: 2, bytes: 0 }] } as unknown as Manifest;
    const replayed = await replayStoredFrames(
      fakeTracker(),
      storeWith(encodeBatch(packFrames(frames))),
      manifest,
      INITIAL_TRACKER_PARAMS,
    );
    expect([...replayed.idMap.values()]).toEqual([2]);
    expect(replayed.maxStoredId).toBe(2);
  });
});
