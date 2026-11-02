import { DEFAULT_RENDER_OPTIONS, type RenderFrame, type SkeletonRenderer } from '@/contracts/renderer';
import type { FrameSource } from '@/render';
import { readClip } from '../mock/clip';
import { PlayerController } from './controller';

const blankSource: FrameSource = {
  frameAt: (frameIndex): RenderFrame => ({ ptsUs: 0, frameIndex, players: [], ball: null }),
};
const nullRenderer: SkeletonRenderer = {
  draw: () => ({ drawMs: 0, players: 0, levels: { full: 0, partial: 0, torso: 0, marker: 0, hidden: 0 } }),
  dispose: () => undefined,
};

export interface Draw {
  readonly frameIndex: number;
  readonly mediaTimeS: number | null;
}

const cleanups: (() => void)[] = [];

/** Browser-test cleanup: call from `afterEach`. */
export function disposeMounted(): void {
  for (const fn of cleanups.splice(0)) fn();
}

export function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

/** Browser-test harness: a real clip in a `<video>` with a controller that records every overlay draw. */
export async function mount(url: string) {
  const info = await readClip(url);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;object-fit:contain';
  video.src = url;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px';
  document.body.append(video, canvas);
  const draws: Draw[] = [];
  const waiting: ((d: Draw) => void)[] = [];
  const controller = new PlayerController({
    video,
    canvas,
    frames: info.frameTable,
    displayWidth: info.clip.displayWidth,
    displayHeight: info.clip.displayHeight,
    renderer: nullRenderer,
    getSource: () => blankSource,
    getOptions: () => DEFAULT_RENDER_OPTIONS,
    onDraw: (frameIndex, mediaTimeS) => {
      const d = { frameIndex, mediaTimeS };
      draws.push(d);
      for (const resolve of waiting.splice(0)) resolve(d);
    },
  });
  controller.resize(320, 180, 1);
  cleanups.push(() => {
    controller.dispose();
    video.remove();
    canvas.remove();
  });
  const nextDraw = () =>
    new Promise<Draw>((resolve, reject) => {
      waiting.push(resolve);
      setTimeout(() => reject(new Error('no overlay draw within 5 s')), 5000);
    });
  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) resolve();
    else video.addEventListener('loadeddata', () => resolve(), { once: true });
  });
  // let the initial frame-0 presentation land so it cannot be mistaken for the response to a seek
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { info, video, controller, nextDraw, draws };
}
