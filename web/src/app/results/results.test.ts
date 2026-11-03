import { describe, expect, it } from 'vitest';
import { BallSource, BallVisibility } from '@/contracts/posetrack';
import { packFrames } from '@/contracts/posetrack-codec';
import { createFrameSource } from '@/render';
import { syntheticScene } from '@/render/synthetic';
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
