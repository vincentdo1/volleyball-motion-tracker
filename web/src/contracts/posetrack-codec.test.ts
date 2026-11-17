import { describe, expect, it } from 'vitest';
import { makeExampleResults } from './examples/make-examples';
import { BallSource, BallVisibility, KeypointFlag } from './posetrack';
import {
  decodePoseTrack,
  encodePoseTrack,
  packFrames,
  unpackPersons,
  validatePackedFrameBatch,
  validatePoseTrackSemantics,
} from './posetrack-codec';
import { transferablesOf } from './protocol';

const examples = makeExampleResults();

describe('PoseTrack codec', () => {
  it('encode -> decode -> encode is stable and keeps missing values as NaN', () => {
    for (const result of Object.values(examples)) {
      const doc = encodePoseTrack(result);
      expect(validatePoseTrackSemantics(doc)).toEqual([]);
      const decoded = decodePoseTrack(JSON.parse(JSON.stringify(doc)));
      expect(encodePoseTrack(decoded)).toEqual(doc);
    }
    const rally = decodePoseTrack(encodePoseTrack(examples.rally as never));
    const p1 = rally.tracks[0];
    expect(p1).toBeDefined();
    // Track 1 misses its left wrist (joint 9) in samples 3 and 4.
    const o = (3 * 26 + 9) * 3;
    expect(Number.isNaN(p1?.kp[o] ?? 0)).toBe(true);
    expect((p1?.kpFlags[3 * 26 + 9] ?? 0) & KeypointFlag.MISSING).toBeTruthy();
    expect(Number.isNaN(rally.ball?.xy[18] ?? 0)).toBe(true);
  });

  it('final results transfer every column buffer', () => {
    const result = examples.rally;
    if (!result) throw new Error('missing example');
    const buffers = transferablesOf({ type: 'final', result });
    expect(buffers.length).toBe(3 + 6 * result.tracks.length + 6);
    expect(new Set(buffers).size).toBe(buffers.length);
  });
});

describe('PackedFrameBatch', () => {
  const kp = Float32Array.from({ length: 78 }, (_, i) => i);
  const batch = packFrames([
    {
      ptsUs: 0,
      durationUs: 33_333,
      flags: 3,
      persons: [
        { trackId: 1, box: [1, 2, 3, 4], boxScore: 0.9, keypoints: kp },
        { trackId: 2, box: [5, 6, 7, 8], boxScore: 0.8, keypoints: kp, sampleFlags: 2 },
      ],
      ball: {
        x: 10,
        y: 20,
        radius: 5,
        confidence: 0.7,
        visibility: BallVisibility.VISIBLE,
        source: BallSource.VBALLNET,
      },
    },
    { ptsUs: 33_333, durationUs: 33_334, flags: 3, persons: [], ball: null },
    {
      ptsUs: 66_667,
      durationUs: 33_333,
      flags: 3,
      persons: [{ trackId: -1, box: [9, 9, 19, 29], boxScore: 0.4, keypoints: kp }],
      ball: null,
    },
  ]);

  it('packs persons with prefix offsets and validates', () => {
    expect(validatePackedFrameBatch(batch)).toEqual([]);
    expect(Array.from(batch.personOffsets)).toEqual([0, 2, 2, 3]);
    const first = unpackPersons(batch, 0);
    expect(first.map((p) => p.trackId)).toEqual([1, 2]);
    expect(Array.from(first[1]?.box ?? [])).toEqual([5, 6, 7, 8]);
    expect(first[1]?.sampleFlags).toBe(2);
    expect(unpackPersons(batch, 1)).toEqual([]);
    expect(Number.isNaN(batch.ball[4])).toBe(true);
  });

  it('is transferred zero-copy', () => {
    const buffers = transferablesOf({ type: 'chunk', seq: 0, batch });
    expect(buffers.length).toBe(13);
    const copy = structuredClone(batch, { transfer: buffers });
    expect(batch.keypoints.byteLength).toBe(0);
    expect(copy.keypoints.length).toBe(3 * 78);
  });
});
