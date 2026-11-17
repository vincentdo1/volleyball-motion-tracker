import { indexAtOrBefore } from '@/contracts/frame-table';
import type { BallColumns, FrameTableColumns, PackedFrameBatch } from '@/contracts/posetrack';
import { unpackPersons } from '@/contracts/posetrack-codec';
import type { RenderFrame, RenderPlayer } from '@/contracts/renderer';
import { ballAt, type FrameSource, toRenderPlayer } from '@/render';
import { BallLane, type LaneData, laneLevelOf } from './lanes';

const BALL_TRAIL_S = 0.5;

interface FrameEntry {
  readonly players: readonly RenderPlayer[];
}

/**
 * Results as they stream in from the engine (raw, unsmoothed). It is a `FrameSource`, so the player draws
 * partial results while processing continues, and it fills the timeline lanes incrementally. Frames the engine
 * has not reached yet are absent (no overlay), never guessed.
 */
export class StreamingResults implements FrameSource {
  private readonly frames: FrameTableColumns;
  private readonly entries: (FrameEntry | undefined)[];
  private readonly ball: BallColumns;
  private readonly playerLanes = new Map<number, Uint8Array>();
  private readonly ballLane: Uint8Array;
  private processed = 0;
  private lastProcessedPts = -1;

  constructor(frames: FrameTableColumns) {
    this.frames = frames;
    const n = frames.ptsUs.length;
    this.entries = new Array<FrameEntry | undefined>(n).fill(undefined);
    this.ballLane = new Uint8Array(n);
    this.ball = {
      ptsUs: frames.ptsUs,
      xy: new Float32Array(2 * n).fill(Number.NaN),
      radius: new Float32Array(n).fill(Number.NaN),
      confidence: new Float32Array(n),
      visibility: new Uint8Array(n),
      source: new Uint8Array(n),
    };
  }

  /** How far the engine has got: one past the last frame received (a resumed run starts partway through the clip). */
  get processedFrames(): number {
    return this.processed;
  }

  get lanes(): LaneData {
    return { players: this.playerLanes, ball: this.ballLane };
  }

  append(batch: PackedFrameBatch): void {
    for (let k = 0; k < batch.count; k++) {
      const pts = batch.ptsUs[k] as number;
      const i = indexAtOrBefore(this.frames.ptsUs, pts);
      if (i < 0 || this.frames.ptsUs[i] !== pts) continue;
      const players = unpackPersons(batch, k).flatMap((person) =>
        person.trackId < 0
          ? []
          : [
              toRenderPlayer(
                { trackId: person.trackId, label: `P${person.trackId}`, colorSlot: person.trackId - 1 },
                person.box,
                person.boxScore,
                person.keypoints,
                person.kpFlags,
                person.sampleFlags,
                null,
              ),
            ],
      );
      this.processed = Math.max(this.processed, i + 1);
      this.entries[i] = { players };
      this.lastProcessedPts = Math.max(this.lastProcessedPts, pts);
      for (const p of players) {
        let lane = this.playerLanes.get(p.trackId);
        if (!lane) {
          lane = new Uint8Array(this.frames.ptsUs.length);
          this.playerLanes.set(p.trackId, lane);
        }
        lane[i] = laneLevelOf(p);
      }
      const bx = batch.ball[k * 4] as number;
      const visibility = batch.ballVisibility[k] as number;
      if (visibility !== 0 && !Number.isNaN(bx)) {
        this.ball.xy[2 * i] = bx;
        this.ball.xy[2 * i + 1] = batch.ball[k * 4 + 1] as number;
        this.ball.radius[i] = batch.ball[k * 4 + 2] as number;
        this.ball.confidence[i] = batch.ball[k * 4 + 3] as number;
        this.ball.visibility[i] = visibility;
        this.ballLane[i] = visibility === 2 ? BallLane.Inferred : BallLane.Visible;
      }
    }
  }

  frameAt(frameIndex: number): RenderFrame {
    const pts = this.frames.ptsUs[frameIndex];
    if (pts === undefined) throw new RangeError(`frame index out of range: ${frameIndex}`);
    return {
      ptsUs: pts,
      frameIndex,
      players: this.entries[frameIndex]?.players ?? [],
      ball: this.entries[frameIndex] ? ballAt(this.ball, this.frames, frameIndex, BALL_TRAIL_S * 1e6) : null,
    };
  }
}
