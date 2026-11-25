import { describe, expect, it } from 'vitest';
import type { ClipMetadata } from '@/contracts/posetrack';
import type { ProgressInfo } from '@/contracts/protocol';
import { createFrameSource } from '@/render';
import { useSessionStore } from '../stores/session';
import { batchOf, testScene } from '../testing';
import { EtaSmoother, formatEta } from './eta';
import { BallLane, computeLanes, LaneLevel } from './lanes';
import { StreamingResults } from './streaming';

const scene = testScene;

describe('StreamingResults', () => {
  it('serves only the frames received so far and fills the lanes incrementally', () => {
    const stream = new StreamingResults(scene.frames);
    expect(stream.frameAt(3).players).toHaveLength(0);
    stream.append(batchOf(0, 8));
    expect(stream.processedFrames).toBe(8);
    expect(stream.frameAt(3).players.length).toBeGreaterThan(0);
    expect(stream.frameAt(12).players).toHaveLength(0);
    expect(stream.frameAt(12).ball).toBeNull();
    expect(stream.lanes.players.get(1)?.[3]).toBe(LaneLevel.Full);
    expect(stream.lanes.players.get(1)?.[12]).toBe(LaneLevel.Absent);
    expect(stream.lanes.ball[3]).toBe(BallLane.Visible);
  });

  it('reports progress from the furthest frame, so a run resumed partway shows its true position', () => {
    const stream = new StreamingResults(scene.frames);
    stream.append(batchOf(12, 16));
    expect(stream.processedFrames).toBe(16);
    stream.append(batchOf(16, 20));
    expect(stream.processedFrames).toBe(20);
  });

  it('draws the same players as the final result for a processed frame', () => {
    const stream = new StreamingResults(scene.frames);
    stream.append(batchOf(0, 24));
    const final = createFrameSource(scene);
    for (const i of [0, 7, 15, 23]) {
      expect(stream.frameAt(i).players.map((p) => p.trackId)).toEqual(final.frameAt(i).players.map((p) => p.trackId));
    }
  });

  it('computeLanes over a final result matches the streamed lanes', () => {
    const stream = new StreamingResults(scene.frames);
    stream.append(batchOf(0, 24));
    const computed = computeLanes(createFrameSource(scene), 24);
    for (const [id, lane] of stream.lanes.players)
      expect(Array.from(computed.players.get(id) ?? [])).toEqual(Array.from(lane));
  });
});

describe('EtaSmoother', () => {
  it('stays hidden for the first two seconds', () => {
    const eta = new EtaSmoother();
    expect(eta.update(0, 0, 100)).toBeNull();
    expect(eta.update(1500, 15, 100)).toBeNull();
    expect(eta.update(2500, 25, 100)).not.toBeNull();
  });

  it('never rises by more than 30% in one update', () => {
    const eta = new EtaSmoother();
    eta.update(0, 0, 1000);
    eta.update(1000, 100, 1000);
    const first = eta.update(2500, 250, 1000) as number;
    const slow = eta.update(12_500, 260, 1000) as number; // a stall: raw ETA explodes
    expect(slow).toBeLessThanOrEqual(first * 1.3 + 1e-9);
  });

  it('formats seconds and minutes', () => {
    expect(formatEta(null)).toBe('');
    expect(formatEta(12.4)).toBe('~12 s left');
    expect(formatEta(65)).toBe('~1 min 5 s left');
  });
});

describe('session chunks and progress (M2-18)', () => {
  const session = () => useSessionStore.getState();
  const begin = () => {
    session().clear();
    session().beginClip('clip.mp4', {} as ClipMetadata, scene.frames);
  };
  const progress = (framesDone: number, stage: ProgressInfo['stage'] = 'processing'): ProgressInfo => ({
    stage,
    doneUs: 0,
    totalUs: 0,
    framesDone,
    framesTotal: 24,
    fps: 10,
    mediaRate: 1,
    etaS: null,
  });

  it('takes the progress from the chunks delivered, not from the engine counter (it runs ahead of them)', () => {
    begin();
    session().setProgress(progress(20), 3);
    expect(session().processedFrames).toBe(0);
    expect(session().etaS).toBe(3);
    session().addChunk(batchOf(0, 8), 0);
    expect(session().processedFrames).toBe(8);
    session().setProgress(progress(24), 1);
    expect(session().processedFrames).toBe(8);
  });

  it('starts the pill from the frames a resumed run had analysed, and keeps what it holds', () => {
    begin();
    session().addChunk(batchOf(0, 8), 0);
    session().runStarted(false, 16);
    expect(session().processedFrames).toBe(16);
    expect(session().lanes?.players.size).toBeGreaterThan(0);
    session().runStarted(false, 99);
    expect(session().processedFrames).toBe(24);
    session().runStarted(false, 4);
    expect(session().processedFrames).toBe(24);
  });

  it('applies a chunk once per seq and fills lanes from replayed chunks', () => {
    begin();
    session().addChunk(batchOf(0, 8), 0);
    const revision = session().revision;
    session().addChunk(batchOf(0, 8), 0);
    expect(session().revision).toBe(revision);
    session().addChunk(batchOf(8, 16), 1);
    expect(session().processedFrames).toBe(16);
    expect(session().lanes?.players.size).toBeGreaterThan(0);
  });

  it('drops the streamed results, seqs and progress when a fresh run starts', () => {
    begin();
    session().addChunk(batchOf(0, 16), 0);
    session().setProgress(progress(16), 2);
    const before = session();
    session().runStarted(true, 0);
    expect(session().processedFrames).toBe(0);
    expect(session().progress).toBeNull();
    expect(session().source).not.toBe(before.source);
    expect(session().lanes?.players.size).toBe(0);
    const revision = session().revision;
    session().addChunk(batchOf(0, 8), 0);
    expect(session().revision).toBe(revision + 1);
    expect(session().processedFrames).toBe(8);
    expect(session().lanes?.players.size).toBeGreaterThan(0);
  });

  it('applies a batch of chunks in one update', () => {
    begin();
    let updates = 0;
    const off = useSessionStore.subscribe(() => updates++);
    session().addChunks([
      { batch: batchOf(0, 8), seq: 0 },
      { batch: batchOf(8, 16), seq: 1 },
      { batch: batchOf(16, 24), seq: 2 },
      { batch: batchOf(0, 8), seq: 0 },
    ]);
    off();
    expect(updates).toBe(1);
    expect(session().processedFrames).toBe(24);
  });

  it('never lowers the processed frames when an older chunk arrives after progress', () => {
    begin();
    session().addChunk(batchOf(8, 16), 1);
    session().addChunk(batchOf(0, 8), 0);
    expect(session().processedFrames).toBe(16);
  });

  it('ignores a late chunk after the final result without error, and a later run builds a new stream (F8)', () => {
    begin();
    session().addChunk(batchOf(0, 8), 0);
    session().setFinal({
      header: {} as never,
      frames: scene.frames,
      tracks: scene.tracks,
      ball: scene.ball,
    });
    const after = session();
    expect(() => session().addChunk(batchOf(8, 16), 1)).not.toThrow();
    expect(() => session().addChunks([{ batch: batchOf(0, 8), seq: 0 }])).not.toThrow();
    expect(session().revision).toBe(after.revision);
    expect(session().source).toBe(after.source);
    expect(session().processedFrames).toBe(after.processedFrames);
    // the seqs of the finished run are gone: a new stream starts empty and takes seq 0 again
    session().runStarted(true, 0);
    session().addChunk(batchOf(0, 8), 0);
    expect(session().final).toBeNull();
    expect(session().processedFrames).toBe(8);
  });
});
