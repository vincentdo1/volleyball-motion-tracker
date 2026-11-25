import type {
  Canvas2DContext,
  RenderFrame,
  RenderOptions,
  RenderStats,
  SkeletonLevel,
  SkeletonRenderer,
  ViewTransform,
} from '@/contracts/renderer';
import {
  type AngleLabel,
  HITTING_ARM_WINDOW_S,
  hittingArm,
  measureAngles,
  paintAngleArcs,
  paintAngleLabels,
} from './angles';
import { findDuplicates } from './assess';
import { paintBall, paintBallTrail } from './ball';
import { LabelPlacer, paintChip } from './chips';
import { buildFocusWindow, trailSeconds } from './focus';
import { GHOST_REACH_S, type GhostSet, paintGhosts, selectGhosts } from './ghosts';
import { HaloQueue } from './halo';
import { type PreparedPlayer, preparePlayer } from './prepare';
import { type PaintContext, type PlayerRole, paintMarker, paintSkeleton, widthFor } from './skeleton';
import { frameStyle } from './style';
import { paintComTrail, paintWristTrails } from './trails';
import { paintVelocityLegend, type VelocityColors, velocityColors } from './velocity';

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

    const angleLabels: AngleLabel[] = [];
    let ghostStatus: 'off' | 'drawn' | 'still' = 'off';
    let legend: VelocityColors | null = null;
    if (options.showBall && options.showTrails && frame.ball) paintBallTrail(ctx, frame.ball, view);
    for (const p of prepared) {
      levels[p.assessment.level]++;
      const role = roleOf(p);
      if (p.assessment.level === 'marker') {
        paintMarker(pc, p, role);
        continue;
      }
      const isFocus = role === 'focus';
      const wantTrails = isFocus && options.showFocusTrails !== false;
      const wantAngles = isFocus && options.showAngles === true;
      const trailS = trailSeconds(options);
      const wantGhosts = isFocus && options.showGhosts === true;
      const wantVelocity = isFocus && options.velocityColor === true;
      const back = Math.max(
        wantTrails ? trailS : 0,
        wantAngles ? HITTING_ARM_WINDOW_S : 0,
        wantGhosts ? GHOST_REACH_S : 0,
        wantVelocity ? 0.1 : 0,
      );
      const win =
        wantTrails || wantAngles || wantGhosts || wantVelocity
          ? buildFocusWindow(frame.history, p, frame.ptsUs, back, 0.1)
          : null;
      const tp = win && {
        ctx,
        view,
        width: widthFor(pc, p, role),
        color: p.color,
        sideMode: options.colorMode === 'side',
        bright: style.bright,
      };
      if (win && tp && wantGhosts) {
        const set: GhostSet = selectGhosts(win, options.reducedMotion === true);
        ghostStatus = set.status;
        paintGhosts({ ...tp, reduced: options.reducedMotion === true }, set);
      }
      if (win && tp && wantTrails) paintComTrail(tp, win, trailS);
      const velocity = win && wantVelocity ? velocityColors(win) : null;
      legend = velocity ?? legend;
      paintSkeleton(velocity ? { ...pc, velocity } : pc, p, role);
      if (win && tp && wantTrails) paintWristTrails(tp, win, trailS);
      if (wantAngles) {
        const angles = measureAngles(p, hittingArm(win, p));
        angleLabels.push(...paintAngleArcs(ctx, p, angles, widthFor(pc, p, role), view.dpr));
      }
    }
    this.halos.paint(ctx, style.glowAmount);
    if (options.showBall && frame.ball) paintBall(ctx, frame.ball, view);

    this.labels.reset();
    if (options.showChips) {
      const chipOrder = [...prepared].sort(
        (a, b) =>
          Number(roleOf(b) === 'focus') - Number(roleOf(a) === 'focus') ||
          b.height - a.height ||
          a.player.trackId - b.player.trackId,
      );
      for (const p of chipOrder)
        paintChip(ctx, this.labels, p, roleOf(p), view.dpr, view.canvasWidth, view.canvasHeight);
    }
    if (legend) paintVelocityLegend(ctx, this.labels, (legend as VelocityColors).velMax, view);
    if (angleLabels.length > 0) {
      paintAngleLabels(ctx, this.labels, angleLabels, view.dpr, view.canvasWidth, view.canvasHeight);
    }
    ctx.restore();

    return { drawMs: now() - started, players: frame.players.length, levels, focus: { ghosts: ghostStatus } };
  }

  dispose(): void {
    this.halos.clear();
  }
}

export function createSkeletonRenderer(): SkeletonRenderer {
  return new Canvas2DSkeletonRenderer();
}
