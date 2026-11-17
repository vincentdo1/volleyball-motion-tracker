import { useEffect, useRef } from 'react';
import { containTransform, DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import { createFrameSource, createSkeletonRenderer } from '@/render';
import { syntheticScene } from '@/render/synthetic';
import { useThemeStore } from '@/ui/theme';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const LOOP_S = 6;
/** A frame near the top of the swing, shown instead of the loop under reduced motion. */
const STILL_FRAME = 11;
/** The scene is drawn this much larger than the frame so the skeletons read at a glance. */
const ZOOM = 1.4;
const FOCUS_X = WIDTH * 0.5;
const FOCUS_Y = HEIGHT * 0.36;

/**
 * Decorative loop of the neon skeleton on a spike, drawn by the same renderer the player uses. It pauses when
 * off-screen or hidden and shows a still frame under reduced motion.
 */
export function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useThemeStore((s) => s.reducedMotion);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const source = createFrameSource(
      syntheticScene({ width: WIDTH, height: HEIGHT, fps: FPS, frameCount: FPS * LOOP_S, players: 3, seed: 21 }),
    );
    const renderer = createSkeletonRenderer();
    const options = { ...DEFAULT_RENDER_OPTIONS, focusTrackId: 1, showChips: true, bgLuma: 0.15 };
    let raf = 0;
    let visible = true;
    let start = 0;

    const paint = (frameIndex: number) => {
      const box = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(box.width * dpr);
      const h = Math.round(box.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const fit = containTransform(WIDTH, HEIGHT, box.width, box.height, dpr);
      // zoom about the focus point, keeping it at the middle of the canvas
      const scale = fit.scale * ZOOM;
      const view = {
        ...fit,
        scale,
        offsetX: box.width / 2 - FOCUS_X * scale,
        offsetY: box.height / 2 - FOCUS_Y * scale,
      };
      renderer.draw(ctx, source.frameAt(frameIndex), view, options);
    };
    const tick = (now: number) => {
      if (!start) start = now;
      paint(Math.floor(((now - start) / 1000) * FPS) % (FPS * LOOP_S));
      raf = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (reduced) paint(STILL_FRAME);
      else if (visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      run();
    });
    observer.observe(canvas);
    const resize = new ResizeObserver(() =>
      paint(reduced ? STILL_FRAME : Math.floor(((performance.now() - start) / 1000) * FPS) % (FPS * LOOP_S) || 0),
    );
    resize.observe(canvas);
    document.addEventListener('visibilitychange', run);
    run();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener('visibilitychange', run);
      renderer.dispose();
    };
  }, [reduced]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />;
}
