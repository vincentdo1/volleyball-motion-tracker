import { HALPE26_SKELETON } from '@/contracts/halpe26';
import {
  CASING_COLOR,
  type Canvas2DContext,
  IDENTITY_PALETTE,
  type RenderFrame,
  type RenderOptions,
  type RenderStats,
  type SkeletonLevel,
  type SkeletonRenderer,
  type ViewTransform,
} from '@/contracts/renderer';

const KEYPOINT_MIN_SCORE = 0.3;

/**
 * Minimal `SkeletonRenderer` for the export worker until the UI's renderer is wired in (`renderer-loader.ts`):
 * identity-coloured bones and joints with a dark casing, and the ball with its trail.
 */
export function createBasicRenderer(): SkeletonRenderer {
  return {
    draw(ctx: Canvas2DContext, frame: RenderFrame, view: ViewTransform, options: RenderOptions): RenderStats {
      const started = performance.now();
      const levels: Record<SkeletonLevel, number> = { full: 0, partial: 0, torso: 0, marker: 0, hidden: 0 };
      const at = (x: number, y: number): [number, number] => [
        (x * view.scale + view.offsetX) * view.dpr,
        (y * view.scale + view.offsetY) * view.dpr,
      ];
      ctx.lineCap = 'round';
      for (const player of frame.players) {
        if (options.hiddenTrackIds.includes(player.trackId)) {
          levels.hidden++;
          continue;
        }
        const color = IDENTITY_PALETTE[player.colorSlot % IDENTITY_PALETTE.length] as string;
        const kp = player.keypoints;
        if (!kp) {
          levels.marker++;
          continue;
        }
        levels.full++;
        for (const pass of [
          { color: CASING_COLOR, width: 5 },
          { color, width: 2.5 },
        ]) {
          ctx.strokeStyle = pass.color;
          ctx.lineWidth = pass.width * view.dpr;
          ctx.beginPath();
          for (const [a, b] of HALPE26_SKELETON) {
            const ok = (kp[a * 3 + 2] ?? 0) >= KEYPOINT_MIN_SCORE && (kp[b * 3 + 2] ?? 0) >= KEYPOINT_MIN_SCORE;
            if (!ok || Number.isNaN(kp[a * 3] ?? Number.NaN) || Number.isNaN(kp[b * 3] ?? Number.NaN)) continue;
            ctx.moveTo(...at(kp[a * 3] as number, kp[a * 3 + 1] as number));
            ctx.lineTo(...at(kp[b * 3] as number, kp[b * 3 + 1] as number));
          }
          ctx.stroke();
        }
      }
      if (options.showBall && frame.ball) {
        const [x, y] = at(frame.ball.x, frame.ball.y);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = CASING_COLOR;
        ctx.lineWidth = 2 * view.dpr;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, frame.ball.radius * view.scale) * view.dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return { drawMs: performance.now() - started, players: frame.players.length, levels };
    },
    dispose() {},
  };
}
