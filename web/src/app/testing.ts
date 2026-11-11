import { BallSource, BallVisibility, type PackedFrameBatch } from '@/contracts/posetrack';
import { packFrames } from '@/contracts/posetrack-codec';
import type { EngineEvent, EngineEventOf, EngineEventType } from '@/contracts/protocol';
import { syntheticScene } from '@/render/synthetic';
import type { FlushScheduler } from './results/chunk-queue';

/** A short synthetic clip with four players, for tests that feed the session store the way the engine does. */
export const testScene = syntheticScene({
  width: 1280,
  height: 720,
  fps: 30,
  frameCount: 24,
  players: 4,
  variety: true,
});

/** The packed batch of frames `from` to `to` (exclusive) of `testScene`, as the engine streams them. */
export function batchOf(from: number, to: number, scene: typeof testScene = testScene): PackedFrameBatch {
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

/** An engine reduced to its event stream: tests emit what the real one would, in any order. */
export class StubEngine {
  private readonly listeners = new Map<EngineEventType, Set<(event: never) => void>>();

  on<T extends EngineEventType>(type: T, listener: (event: EngineEventOf<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return () => set.delete(listener as (event: never) => void);
  }

  emit(event: EngineEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event as never);
  }
}

/** A scheduler the test drives: `run()` is the next animation frame. */
export function manualScheduler(): { schedule: FlushScheduler; run: () => void; readonly waiting: boolean } {
  let next: (() => void) | null = null;
  return {
    schedule(flush) {
      next = flush;
      return () => {
        if (next === flush) next = null;
      };
    },
    run() {
      const flush = next;
      next = null;
      flush?.();
    },
    get waiting() {
      return next !== null;
    },
  };
}
