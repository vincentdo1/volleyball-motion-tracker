import type {
  Canvas2DContext,
  RenderFrame,
  RenderOptions,
  RenderStats,
  SkeletonLevel,
  SkeletonRenderer,
  ViewTransform,
} from '@/contracts/renderer';
import { findDuplicates } from './assess';
import { paintBall, paintBallTrail } from './ball';
import { LabelPlacer, paintChip } from './chips';
import { HaloQueue } from './halo';
import { type PreparedPlayer, preparePlayer } from './prepare';
import { type PaintContext, type PlayerRole, paintMarker, paintSkeleton } from './skeleton';
import { frameStyle } from './style';

function emptyLevels(): Record<SkeletonLevel, number> {
  return { full: 0, partial: 0, torso: 0, marker: 0, hidden: 0 };
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

class Canvas2DSkeletonRenderer implements SkeletonRenderer {
  private readonly halos = new HaloQueue();
  private readonly labels = new LabelPlacer();

  draw(ctx: Canvas2DContext, frame: RenderFrame, view: ViewTransform, options: RenderOptions): RenderStats {
    const started = now();
    const levels = emptyLevels();
    const hidden = new Set(options.hiddenTrackIds);
    const duplicates = findDuplicates(frame.players);

    const prepared: PreparedPlayer[] = [];
    frame.players.forEach((player, i) => {
      if (hidden.has(player.trackId) || duplicates.has(i)) {
        levels.hidden++;
        return;
      }
      prepared.push(preparePlayer(player, view));
    });
    // far players first (smaller apparent height), the focus player last so it overlaps everyone
    const focusId = options.focusTrackId;
    const hasFocus = focusId !== null && prepared.some((p) => p.player.trackId === focusId);
    const roleOf = (p: PreparedPlayer): PlayerRole =>
      !hasFocus ? 'plain' : p.player.trackId === focusId ? 'focus' : 'context';
    prepared.sort(
      (a, b) =>
        Number(roleOf(a) === 'focus') - Number(roleOf(b) === 'focus') ||
        a.height - b.height ||
        a.player.trackId - b.player.trackId,
    );

    const style = frameStyle(options);
    const glowing = style.glowAmount > 0.02;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pc: PaintContext = { ctx, style, options, dpr: view.dpr, halos: glowing ? this.halos : null };

    if (options.showBall && options.showTrails && frame.ball) paintBallTrail(ctx, frame.ball, view);
    for (const p of prepared) {
      levels[p.assessment.level]++;
      if (p.assessment.level === 'marker') paintMarker(pc, p, roleOf(p));
      else paintSkeleton(pc, p, roleOf(p));
    }
    this.halos.paint(ctx, style.glowAmount);
    if (options.showBall && frame.ball) paintBall(ctx, frame.ball, view);

    if (options.showChips) {
      this.labels.reset();
      const chipOrder = [...prepared].sort(
        (a, b) =>
          Number(roleOf(b) === 'focus') - Number(roleOf(a) === 'focus') ||
          b.height - a.height ||
          a.player.trackId - b.player.trackId,
      );
      for (const p of chipOrder)
        paintChip(ctx, this.labels, p, roleOf(p), view.dpr, view.canvasWidth, view.canvasHeight);
    }
    ctx.restore();

    return { drawMs: now() - started, players: frame.players.length, levels };
  }

  dispose(): void {
    this.halos.clear();
  }
}

export function createSkeletonRenderer(): SkeletonRenderer {
  return new Canvas2DSkeletonRenderer();
}
