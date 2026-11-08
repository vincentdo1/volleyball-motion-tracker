import { type PointerEvent, useEffect, useRef, useState } from 'react';
import type { FrameTableColumns } from '@/contracts/posetrack';
import { containTransform, type RenderOptions, type SkeletonRenderer } from '@/contracts/renderer';
import { createSkeletonRenderer, type FrameSource } from '@/render';
import { useViewStore } from '../stores/view';
import { PlayerController } from './controller';

export interface VideoStageProps {
  /** Object URL or fixture URL of the clip. */
  readonly src: string;
  readonly frames: FrameTableColumns;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Overlay data; may be null before any result exists and may change while processing streams in. */
  readonly source: FrameSource | null;
  readonly options: RenderOptions;
  /** Called with the controller once the video is attached, and with null on teardown. */
  readonly onController: (controller: PlayerController | null) => void;
  /** Click or tap on a player's box (or empty space: null). */
  readonly onPickPlayer?: (trackId: number | null) => void;
  readonly label: string;
}

/** The video with its overlay canvas on top, sized to the same content box (object-fit: contain). */
export function VideoStage(props: VideoStageProps) {
  const { src, frames, displayWidth, displayHeight, source, options, onController, onPickPlayer, label } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const live = useRef({ source, options });
  live.current = { source, options };
  const [controller, setController] = useState<PlayerController | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!video || !canvas || !stage) return;
    const renderer: SkeletonRenderer = createSkeletonRenderer();
    const next = new PlayerController({
      video,
      canvas,
      frames,
      displayWidth,
      displayHeight,
      renderer,
      getSource: () => live.current.source,
      getOptions: () => live.current.options,
      onStats: (stats) => {
        const still = stats.focus?.ghosts === 'still';
        if (useViewStore.getState().ghostsStill !== still) useViewStore.getState().setGhostsStill(still);
      },
    });
    const fitOverlay = () => {
      const box = stage.getBoundingClientRect();
      next.resize(box.width, box.height, window.devicePixelRatio || 1);
    };
    fitOverlay();
    const observer = new ResizeObserver(fitOverlay);
    observer.observe(stage);
    window.addEventListener('resize', fitOverlay);
    setController(next);
    onController(next);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitOverlay);
      onController(null);
      setController(null);
      next.dispose();
      renderer.dispose();
    };
  }, [frames, displayWidth, displayHeight, onController]);

  // the overlay follows the data and options; the video itself is never touched
  // biome-ignore lint/correctness/useExhaustiveDependencies: source and options are the triggers, redraw reads them from the ref
  useEffect(() => {
    controller?.redraw();
  }, [controller, source, options]);

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    const current = live.current.source;
    if (!onPickPlayer || !stage || !controller || !current) return;
    const rect = stage.getBoundingClientRect();
    const view = containTransform(displayWidth, displayHeight, rect.width, rect.height, 1);
    const x = (event.clientX - rect.left - view.offsetX) / view.scale;
    const y = (event.clientY - rect.top - view.offsetY) / view.scale;
    const hit = current
      .frameAt(controller.getSnapshot().frameIndex)
      .players.filter((p) => p.box && x >= p.box[0] && x <= p.box[2] && y >= p.box[1] && y <= p.box[3])
      .sort((a, b) => area(a.box) - area(b.box))[0];
    onPickPlayer(hit?.trackId ?? null);
  };

  return (
    <div
      ref={stageRef}
      onPointerUp={onPointerUp}
      className="relative size-full touch-manipulation overflow-hidden bg-stage"
      data-testid="video-stage"
    >
      {/* biome-ignore lint/a11y/useMediaCaption: match footage has no dialogue to caption */}
      <video
        ref={videoRef}
        src={src}
        aria-label={label}
        playsInline
        preload="auto"
        disablePictureInPicture
        className="absolute inset-0 size-full object-contain"
      />
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 size-full" />
    </div>
  );
}

function area(box: readonly [number, number, number, number] | null): number {
  return box ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
}
