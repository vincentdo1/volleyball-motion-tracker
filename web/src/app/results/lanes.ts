import type { RenderPlayer } from '@/contracts/renderer';
import { assessPose, type FrameSource } from '@/render';

/** Lane cell values: how much skeleton was drawable for a player at a frame. 0 = no sample. */
export const LaneLevel = { Absent: 0, Marker: 1, Torso: 2, Partial: 3, Full: 4 } as const;
export type LaneLevelCode = (typeof LaneLevel)[keyof typeof LaneLevel];

/** Ball lane cell values. */
export const BallLane = { None: 0, Inferred: 1, Visible: 2 } as const;

export function laneLevelOf(player: RenderPlayer): LaneLevelCode {
  switch (assessPose(player).level) {
    case 'full':
      return LaneLevel.Full;
    case 'partial':
      return LaneLevel.Partial;
    case 'torso':
      return LaneLevel.Torso;
    default:
      return LaneLevel.Marker;
  }
}

export interface LaneData {
  /** Level per frame for each track id, in order of first appearance. */
  readonly players: ReadonlyMap<number, Uint8Array>;
  readonly ball: Uint8Array;
}

/** Computes every lane of a finished result by walking its frames. */
export function computeLanes(source: FrameSource, frameCount: number): LaneData {
  const players = new Map<number, Uint8Array>();
  const ball = new Uint8Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const frame = source.frameAt(i);
    for (const p of frame.players) {
      let lane = players.get(p.trackId);
      if (!lane) {
        lane = new Uint8Array(frameCount);
        players.set(p.trackId, lane);
      }
      lane[i] = laneLevelOf(p);
    }
    if (frame.ball) ball[i] = frame.ball.visibility === 2 ? BallLane.Inferred : BallLane.Visible;
  }
  return { players, ball };
}
