import { Eye, EyeOff } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IDENTITY_PALETTE } from '@/contracts/renderer';
import { cn } from '@/ui/cn';
import { formatClock } from '../format';
import type { PlayerController } from '../player/controller';
import { usePlayerSnapshot } from '../player/hooks';
import { BallLane, type LaneData, LaneLevel } from '../results/lanes';
import { isPositionOnly, type TrackInfo } from '../results/tracks';

const LANE_H = 28;
const RULER_H = 22;
const LEVEL_ALPHA: Readonly<Record<number, number>> = {
  [LaneLevel.Marker]: 0.28,
  [LaneLevel.Torso]: 0.5,
  [LaneLevel.Partial]: 0.75,
  [LaneLevel.Full]: 1,
};

export interface TimelineProps {
  readonly controller: PlayerController | null;
  readonly ptsUs: Float64Array;
  readonly durationS: number;
  readonly lanes: LaneData | null;
  readonly revision: number;
  readonly tracks: readonly TrackInfo[];
  /** Frames analysed so far; the rest of the track shows as pending. */
  readonly processedFrames: number;
  readonly focusTrackId: number | null;
  readonly hiddenTrackIds: readonly number[];
  readonly onFocus: (trackId: number) => void;
  readonly onToggleHidden: (trackId: number) => void;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Per-player lanes in one canvas (05 §3.3): bar opacity is the skeleton level at that frame, a hatched tail marks
 * frames the engine has not reached, and the playhead is a DOM element so it never forces a canvas repaint.
 * The wrapper is a slider: arrows step one frame, Shift+arrows ten, Home/End jump to the ends.
 */
export function Timeline(props: TimelineProps) {
  const { controller, ptsUs, durationS, lanes, revision, tracks, processedFrames, focusTrackId, hiddenTrackIds } =
    props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const snap = usePlayerSnapshot(controller);
  const frames = ptsUs.length;
  const height = RULER_H + (tracks.length + 1) * LANE_H;

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` signals that lane contents changed in place
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width === 0 || frames === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const border = cssVar('--border', 'rgba(255,255,255,0.08)');
    const muted = cssVar('--text-2', '#9aa3b2');

    // ruler: second ticks, thinned so labels never collide
    ctx.fillStyle = muted;
    ctx.font = '11px "Geist Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const pxPerSecond = width / Math.max(durationS, 1e-6);
    const every = Math.max(1, Math.ceil(56 / pxPerSecond));
    for (let s = 0; s <= durationS; s += every) {
      const x = Math.round(s * pxPerSecond) + 0.5;
      ctx.fillStyle = border;
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = muted;
      ctx.fillText(`${s}s`, x + 4, RULER_H / 2 - 1);
    }

    const columnFrame = (x: number) => Math.min(frames, Math.floor((x / width) * frames));
    const pendingFromX = Math.floor((processedFrames / frames) * width);
    const paintLane = (row: number, lane: Uint8Array | undefined, color: string, ball = false) => {
      const y = RULER_H + row * LANE_H;
      ctx.fillStyle = border;
      ctx.fillRect(0, y + LANE_H - 1, width, 1);
      if (pendingFromX < width) {
        ctx.fillStyle = border;
        for (let x = Math.max(0, pendingFromX); x < width; x += 6) ctx.fillRect(x, y + LANE_H / 2 - 0.5, 3, 1);
      }
      if (!lane) return;
      ctx.fillStyle = color;
      for (let x = 0; x < width; x++) {
        const from = columnFrame(x);
        const to = Math.max(from + 1, columnFrame(x + 1));
        let level = 0;
        for (let i = from; i < to && i < frames; i++) level = Math.max(level, lane[i] as number);
        if (level === 0) continue;
        if (ball) {
          ctx.globalAlpha = level === BallLane.Visible ? 1 : 0.4;
          ctx.fillRect(x, y + LANE_H / 2 - 2, 1, 4);
        } else {
          ctx.globalAlpha = LEVEL_ALPHA[level] ?? 0.3;
          ctx.fillRect(x, y + 6, 1, LANE_H - 13);
        }
      }
      ctx.globalAlpha = 1;
    };
    tracks.forEach((t, row) => {
      paintLane(row, lanes?.players.get(t.id), IDENTITY_PALETTE[t.colorSlot % IDENTITY_PALETTE.length] ?? '#fff');
    });
    paintLane(tracks.length, lanes?.ball, '#8f7bff', true);
  }, [width, height, frames, durationS, lanes, revision, tracks, processedFrames]);

  const seekFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !controller || rect.width === 0) return;
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    controller.scrubToTime(fraction * durationS);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!controller) return;
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowLeft':
        controller.step(-big);
        break;
      case 'ArrowRight':
        controller.step(big);
        break;
      case 'PageDown':
        controller.step(-10);
        break;
      case 'PageUp':
        controller.step(10);
        break;
      case 'Home':
        controller.seekToIndex(0);
        break;
      case 'End':
        controller.seekToIndex(frames - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="flex" style={{ height }}>
      <div className="w-32 shrink-0 sm:w-40" style={{ paddingTop: RULER_H }}>
        {tracks.map((t) => {
          const hidden = hiddenTrackIds.includes(t.id);
          return (
            <div key={t.id} className="flex items-center" style={{ height: LANE_H }}>
              <button
                type="button"
                onClick={() => props.onFocus(t.id)}
                aria-pressed={focusTrackId === t.id}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-input px-2 text-left text-[13px] font-[550] [@media(pointer:coarse)]:min-h-11',
                  focusTrackId === t.id ? 'bg-surface-2 text-text' : 'text-text-2 hover:text-text',
                )}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-pill"
                  style={{ background: IDENTITY_PALETTE[t.colorSlot % IDENTITY_PALETTE.length] }}
                />
                <span className="truncate">{t.label}</span>
                {isPositionOnly(t) && (
                  <span className="truncate font-normal text-[11px] text-text-2">position only</span>
                )}
              </button>
              <button
                type="button"
                aria-label={`${hidden ? 'Show' : 'Hide'} ${t.label}`}
                aria-pressed={hidden}
                onClick={() => props.onToggleHidden(t.id)}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-input text-text-2 hover:text-text [@media(pointer:coarse)]:size-11"
              >
                {hidden ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
              </button>
            </div>
          );
        })}
        <div className="flex items-center px-2 text-[13px] font-[550] text-text-2" style={{ height: LANE_H }}>
          Ball
        </div>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, frames - 1)}
        aria-valuenow={snap.frameIndex}
        aria-valuetext={`${snap.timeS.toFixed(2)} s, frame ${snap.frameIndex + 1}`}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seekFromPointer(e)}
        className="relative min-w-0 flex-1 cursor-pointer touch-none rounded-input"
      >
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" style={{ width: '100%', height }} />
        {frames > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-text"
            style={{ left: `${((snap.frameIndex + 0.5) / frames) * 100}%` }}
          >
            <span className="absolute -top-0.5 -left-[3px] size-[7px] rotate-45 bg-text" />
          </div>
        )}
        <span className="sr-only">{formatClock(snap.timeS)}</span>
      </div>
    </div>
  );
}
