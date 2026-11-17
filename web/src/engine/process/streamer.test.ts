import { describe, expect, it } from 'vitest';
import { BallSource, type PackedFrameBatch } from '@/contracts/posetrack';
import type { FrameRecord } from './batch-packer';
import { Streamer } from './streamer';

const STEP = 33_333;
const record = (i: number): FrameRecord => ({
  ptsUs: i * STEP,
  durationUs: STEP,
  flags: 1,
  persons: [],
  ballModel: [],
  ballDetector: [],
});

function setup(ballHoldUs: number) {
  const batches: PackedFrameBatch[] = [];
  const streamer = new Streamer({ visibilityThreshold: 0.3, ballHoldUs }, async (b) => {
    batches.push(b);
  });
  return { batches, streamer };
}

describe('Streamer', () => {
  it('releases a batch once it spans 0.5 s and starts the next one on the first frame past it', async () => {
    const { batches, streamer } = setup(0);
    for (let i = 0; i < 40; i++) {
      streamer.push(record(i));
      await streamer.drain();
    }
    expect(batches.map((b) => b.count)).toEqual([16, 16]);
    expect(batches[1]?.ptsUs[0]).toBe(16 * STEP);
    await streamer.drain(true);
    expect(batches.map((b) => b.count)).toEqual([16, 16, 8]);
  });

  it('cuts at the 10 s chunk window boundary', async () => {
    const { batches, streamer } = setup(0);
    for (let i = 296; i < 306; i++) streamer.push(record(i));
    await streamer.drain(true);
    expect(batches.length).toBe(2);
    expect((batches[0]?.ptsUs.at(-1) ?? 0) < 10_000_000).toBe(true);
    expect((batches[1]?.ptsUs[0] ?? 0) >= 10_000_000).toBe(true);
  });

  it('holds frames until their ball results arrive, then fills them in', async () => {
    const { batches, streamer } = setup(1_000_000);
    for (let i = 0; i < 30; i++) {
      streamer.push(record(i));
      await streamer.drain();
    }
    expect(batches.length).toBe(0);
    streamer.attachBall([
      { ptsUs: 5 * STEP, candidates: [{ x: 1, y: 2, radius: 3, confidence: 0.9, source: BallSource.VBALLNET }] },
    ]);
    streamer.attachBall([{ ptsUs: 29 * STEP, candidates: [] }]);
    await streamer.drain();
    expect(batches.length).toBe(1);
    expect(batches[0]?.ball[5 * 4]).toBe(1);
  });

  it('stops waiting for the ball model after the hold expires', async () => {
    const { batches, streamer } = setup(1_000_000);
    for (let i = 0; i < 60; i++) {
      streamer.push(record(i));
      await streamer.drain();
    }
    expect(batches.length).toBeGreaterThan(0);
  });
});

describe('Streamer ball results out of order', () => {
  it('applies a result that arrives before its frame is queued', async () => {
    const { batches, streamer } = setup(1_000_000);
    streamer.attachBall([
      { ptsUs: 2 * STEP, candidates: [{ x: 7, y: 8, radius: 1, confidence: 0.9, source: BallSource.VBALLNET }] },
    ]);
    for (let i = 0; i < 20; i++) streamer.push(record(i));
    await streamer.drain(true);
    expect(batches[0]?.ball[2 * 4]).toBe(7);
  });
});
