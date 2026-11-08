import { describe, expect, it } from 'vitest';
import type { ClipMetadata } from '@/contracts/posetrack';
import { BallSource, BallVisibility } from '@/contracts/posetrack';
import { packFrames } from '@/contracts/posetrack-codec';
import type { ProgressInfo } from '@/contracts/protocol';
import { createFrameSource } from '@/render';
import { syntheticScene } from '@/render/synthetic';
import { useSessionStore } from '../stores/session';
import { EtaSmoother, formatEta } from './eta';
import { BallLane, computeLanes, LaneLevel } from './lanes';
import { StreamingResults } from './streaming';

const scene = syntheticScene({ width: 1280, height: 720, fps: 30, frameCount: 24, players: 4, variety: true });

function batchOf(from: number, to: number) {
  return packFrames(
    Array.from({ length: to - from }, (_, k) => {
      const i = from + k;
      const pts = scene.frames.ptsUs[i] as number;
      return {
        ptsUs: pts,
        durationUs: scene.frames.durationUs[i] as number,
        flags: 1,
        persons: scene.tracks.flatMap((t) => {
          const s = t.ptsUs.indexOf(pts);
          return s < 0
            ? []
            : [
                {
                  trackId: t.id,
                  box: t.box.subarray(s * 4, s * 4 + 4),
                  boxScore: 0.9,
                  keypoints: t.kp.subarray(s * 78, s * 78 + 78),
                  kpFlags: t.kpFlags.subarray(s * 26, s * 26 + 26),
                },
              ];
        }),
        ball: {
          x: scene.ball.xy[i * 2] as number,
          y: scene.ball.xy[i * 2 + 1] as number,
          radius: 8,
          confidence: 0.8,
          visibility: BallVisibility.VISIBLE,
          source: BallSource.VBALLNET,
        },
      };
    }),
  );
}

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

  it('starts the pill from the frames the engine skipped on a resumed run, not from chunks received', () => {
    begin();
    session().setProgress(progress(8), null);
    expect(session().processedFrames).toBe(8);
    session().setProgress(progress(12), null);
    expect(session().processedFrames).toBe(12);
    session().setProgress(progress(3), null);
    expect(session().processedFrames).toBe(12);
  });

  it('ignores warm-up progress and clamps to the clip length', () => {
    begin();
    session().setProgress(progress(20, 'warmup'), null);
    expect(session().processedFrames).toBe(0);
    session().setProgress(progress(99), null);
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

  it('accepts sequence numbers again when a new run starts', () => {
    begin();
    session().addChunk(batchOf(0, 8), 0);
    session().beginRun();
    const revision = session().revision;
    session().addChunk(batchOf(0, 8), 0);
    expect(session().revision).toBe(revision + 1);
  });

  it('never lowers the processed frames when an older chunk arrives after progress', () => {
    begin();
    session().setProgress(progress(16), null);
    session().addChunk(batchOf(0, 8), 0);
    expect(session().processedFrames).toBe(16);
  });
});
