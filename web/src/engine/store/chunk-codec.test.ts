import { describe, expect, it } from 'vitest';
import { BallSource, BallVisibility } from '@/contracts/posetrack';
import { packFrames } from '@/contracts/posetrack-codec';
import { decodeBatches, encodeBatch } from './chunk-codec';

function sample(startUs: number, frames: number, people: number) {
  return packFrames(
    Array.from({ length: frames }, (_, i) => ({
      ptsUs: startUs + i * 33_333,
      durationUs: 33_333,
      flags: 3,
      persons: Array.from({ length: i % (people + 1) }, (_, k) => ({
        trackId: k + 1,
        box: [k, 1, 2, 3],
        boxScore: 0.5 + k / 10,
        keypoints: Array.from({ length: 78 }, (_, j) => (j % 5 === 0 ? Number.NaN : j + k)),
        kpFlags: new Uint8Array(26).fill(k),
        sampleFlags: k,
      })),
      ball:
        i % 2 === 0
          ? { x: 1, y: 2, radius: 3, confidence: 0.4, visibility: BallVisibility.VISIBLE, source: BallSource.DETECTOR }
          : null,
    })),
  );
}

describe('chunk codec', () => {
  it('round-trips several batches in one file, including NaN and odd sizes', () => {
    const batches = [sample(0, 7, 3), sample(300_000, 1, 0), sample(400_000, 15, 5)];
    const file = new Uint8Array(batches.reduce((n, b) => n + encodeBatch(b).byteLength, 0));
    let at = 0;
    for (const batch of batches) {
      const bytes = encodeBatch(batch);
      file.set(bytes, at);
      at += bytes.byteLength;
    }
    const decoded = decodeBatches(file);
    expect(decoded.length).toBe(3);
    decoded.forEach((batch, i) => {
      const original = batches[i];
      expect(batch.count).toBe(original?.count);
      expect(Array.from(batch.keypoints)).toEqual(Array.from(original?.keypoints ?? []));
      expect(Array.from(batch.ptsUs)).toEqual(Array.from(original?.ptsUs ?? []));
      expect(Array.from(batch.ball)).toEqual(Array.from(original?.ball ?? []));
      expect(Array.from(batch.personOffsets)).toEqual(Array.from(original?.personOffsets ?? []));
    });
  });

  it('decodes from an unaligned view', () => {
    const encoded = encodeBatch(sample(0, 4, 2));
    const shifted = new Uint8Array(encoded.byteLength + 3);
    shifted.set(encoded, 3);
    expect(decodeBatches(shifted.subarray(3)).length).toBe(1);
  });

  it('rejects truncated and foreign data', () => {
    const encoded = encodeBatch(sample(0, 4, 2));
    expect(() => decodeBatches(encoded.subarray(0, encoded.byteLength - 8))).toThrow(/truncated/);
    expect(() => decodeBatches(new Uint8Array(32))).toThrow(/not a raw chunk/);
  });
});
