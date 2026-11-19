import { describe, expect, it } from 'vitest';
import { packFrames } from '@/contracts/posetrack-codec';
import { ChunkWriter, maxTrackIdOf } from './chunk-writer';
import type { Manifest, SessionStore } from './session-store';

const batch = (ptsUs: number, ids: readonly number[]) =>
  packFrames([
    {
      ptsUs,
      durationUs: 33_333,
      flags: 3,
      persons: ids.map((trackId) => ({
        trackId,
        box: [0, 0, 10, 10],
        boxScore: 0.9,
        keypoints: new Array(78).fill(0),
      })),
      ball: null,
    },
  ]);

function memoryStore(): SessionStore {
  return {
    startChunk: async () => undefined,
    appendChunk: async () => undefined,
    writeManifest: async () => undefined,
  } as unknown as SessionStore;
}

describe('ChunkWriter track-id high-water mark', () => {
  it('records the highest track id of each window in the manifest', async () => {
    const empty = { chunks: [], complete: false } as unknown as Manifest;
    const writer = new ChunkWriter(memoryStore(), empty);
    await writer.write(batch(0, [1, 3]));
    await writer.write(batch(33_333, [2]));
    await writer.write(batch(10_000_000, []));
    await writer.write(batch(20_000_000, [7]));
    expect(writer.snapshot().chunks.map((c) => c.maxTrackId)).toEqual([3, 0, 7]);
    const done = await writer.finish();
    expect(done.chunks.map((c) => c.maxTrackId)).toEqual([3, 0, 7]);
  });

  it('reads the maximum from a batch', () => {
    expect(maxTrackIdOf(batch(0, []))).toBe(0);
    expect(maxTrackIdOf(batch(0, [2, 9, 4]))).toBe(9);
  });
});
