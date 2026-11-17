import { describe, expect, it } from 'vitest';
import type { TrackedPerson } from '@/contracts/pipeline';
import { BallSource, BallVisibility, KeypointFlag, SampleFlag } from '@/contracts/posetrack';
import { ballCandidatesOf, type FrameRecord, packBatch } from './batch-packer';

function person(
  trackId: number,
  score: number,
  origin: TrackedPerson['origin'] = 'detector',
  missing = false,
): TrackedPerson {
  const keypoints = new Float32Array(78).fill(missing ? Number.NaN : 10);
  if (!missing) keypoints[2] = score;
  if (!missing) keypoints[5] = 0.1;
  return { trackId, box: [1, 2, 3, 4], score, keypoints, origin };
}

const record = (ptsUs: number, persons: TrackedPerson[], over: Partial<FrameRecord> = {}): FrameRecord => ({
  ptsUs,
  durationUs: 33_333,
  flags: 3,
  persons,
  ballModel: [],
  ballDetector: [],
  ...over,
});

describe('packBatch', () => {
  it('lays out persons with prefix offsets and per-joint flags', () => {
    const batch = packBatch(
      [record(0, [person(1, 0.9), person(2, 0.8)]), record(33_333, []), record(66_666, [person(1, 0.9)])],
      0.3,
    );
    expect(batch.count).toBe(3);
    expect([...batch.personOffsets]).toEqual([0, 2, 2, 3]);
    expect([...batch.trackIds]).toEqual([1, 2, 1]);
    expect(batch.boxes.length).toBe(12);
    expect(batch.keypoints.length).toBe(3 * 78);
    expect(batch.kpFlags[0]).toBe(0);
    expect(batch.kpFlags[1]).toBe(KeypointFlag.LOW_CONFIDENCE);
  });

  it('flags propagated, low-score and pose-less people', () => {
    const batch = packBatch([record(0, [person(1, 0.5, 'propagated'), person(2, 0.2, 'detector-low', true)])], 0.3);
    expect(batch.sampleFlags[0]).toBe(SampleFlag.BOX_PROPAGATED);
    expect(batch.sampleFlags[1]).toBe(SampleFlag.LOW_SCORE_DETECTION | SampleFlag.POSE_MISSING);
    expect(batch.kpFlags[26]).toBe(KeypointFlag.MISSING);
  });

  it('prefers the ball model over the detector ball and marks absence', () => {
    const model = { x: 5, y: 6, radius: 3, confidence: 0.7, source: BallSource.VBALLNET } as const;
    const detector = { x: 1, y: 1, radius: 2, confidence: 0.9, source: BallSource.DETECTOR } as const;
    const batch = packBatch(
      [
        record(0, [], { ballModel: [model], ballDetector: [detector] }),
        record(1, [], { ballDetector: [detector] }),
        record(2, []),
      ],
      0.3,
    );
    expect([...batch.ballSource]).toEqual([BallSource.VBALLNET, BallSource.DETECTOR, BallSource.NONE]);
    expect([...batch.ballVisibility]).toEqual([BallVisibility.VISIBLE, BallVisibility.VISIBLE, BallVisibility.NONE]);
    expect(Number.isNaN(batch.ball[8] as number)).toBe(true);
    const candidates = ballCandidatesOf([batch]);
    expect(candidates.map((c) => c.ptsUs)).toEqual([0, 1]);
    expect(candidates[0]?.candidates[0]?.x).toBe(5);
  });
});
