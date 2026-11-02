import { HALPE26_NUM_KEYPOINTS, PERSON_KP_VALUES } from '@/contracts/halpe26';
import type { BallVisibilityCode, FinalResult } from '@/contracts/posetrack';
import type { RenderBall, RenderFrame, RenderPlayer } from '@/contracts/renderer';

/** Ball positions kept for the trail: this much media time back. */
const TRAIL_S = 0.5;

/**
 * Renderer input for a frame, read from the final columns. Frames are requested in increasing PTS order (export
 * decodes sequentially), so each track keeps a cursor instead of searching.
 */
export class RenderFrames {
  private readonly cursors: number[];
  private ballCursor = 0;

  constructor(private readonly result: FinalResult) {
    this.cursors = result.tracks.map(() => 0);
  }

  frame(ptsUs: number, frameIndex: number): RenderFrame {
    const players: RenderPlayer[] = [];
    this.result.tracks.forEach((track, t) => {
      let at = this.cursors[t] as number;
      while (at < track.ptsUs.length && (track.ptsUs[at] as number) < ptsUs) at++;
      this.cursors[t] = at;
      if (at >= track.ptsUs.length || track.ptsUs[at] !== ptsUs) return;
      const box = track.box.subarray(at * 4, at * 4 + 4);
      const hasBox = !Number.isNaN(box[0] as number);
      players.push({
        trackId: track.id,
        label: track.label,
        colorSlot: track.colorSlot,
        box: hasBox ? [box[0] as number, box[1] as number, box[2] as number, box[3] as number] : null,
        boxScore: track.boxScore[at] as number,
        keypoints: track.kp.subarray(at * PERSON_KP_VALUES, (at + 1) * PERSON_KP_VALUES),
        kpFlags: track.kpFlags.subarray(at * HALPE26_NUM_KEYPOINTS, (at + 1) * HALPE26_NUM_KEYPOINTS),
        sampleFlags: track.sampleFlags[at] as number,
        refBoneLengths: null,
      });
    });
    return { ptsUs, frameIndex, players, ball: this.ball(ptsUs) };
  }

  private ball(ptsUs: number): RenderBall | null {
    const ball = this.result.ball;
    if (!ball) return null;
    let at = this.ballCursor;
    while (at < ball.ptsUs.length && (ball.ptsUs[at] as number) < ptsUs) at++;
    this.ballCursor = at;
    if (at >= ball.ptsUs.length || ball.ptsUs[at] !== ptsUs) return null;
    const x = ball.xy[at * 2] as number;
    const y = ball.xy[at * 2 + 1] as number;
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    const trail: number[] = [];
    for (let i = at - 1; i >= 0 && ptsUs - (ball.ptsUs[i] as number) <= TRAIL_S * 1e6; i--) {
      const tx = ball.xy[i * 2] as number;
      if (!Number.isNaN(tx)) trail.unshift(tx, ball.xy[i * 2 + 1] as number);
    }
    return {
      x,
      y,
      radius: ball.radius[at] as number,
      confidence: ball.confidence[at] as number,
      visibility: ball.visibility[at] as BallVisibilityCode,
      trail: trail.length > 0 ? Float32Array.from(trail) : null,
    };
  }
}
