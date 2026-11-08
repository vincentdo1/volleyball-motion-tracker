import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS } from '@/contracts/renderer';
import { createFrameSource } from '@/render';
import { syntheticScene } from '@/render/synthetic';
import { motionScene } from '@/render/testing';
import { disposeMounted, mount } from '../player/harness';
import { renderFramePng } from './png';

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';

afterEach(disposeMounted);

async function pixels(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

describe('renderFramePng', () => {
  it('exports the shown frame at the clip size, with skeletons only when asked', async () => {
    const { info, video } = await mount(CLIP);
    const scene = syntheticScene({
      width: info.clip.displayWidth,
      height: info.clip.displayHeight,
      frames: info.frameTable,
      players: 3,
    });
    const source = createFrameSource(scene);
    const base = {
      video,
      source,
      frameIndex: 0,
      options: DEFAULT_RENDER_OPTIONS,
      displayWidth: info.clip.displayWidth,
      displayHeight: info.clip.displayHeight,
    };
    const plain = await renderFramePng({ ...base, overlay: false });
    const withOverlay = await renderFramePng({ ...base, overlay: true });
    expect(plain.type).toBe('image/png');
    const a = await pixels(plain);
    const b = await pixels(withOverlay);
    expect([a.width, a.height]).toEqual([info.clip.displayWidth, info.clip.displayHeight]);
    let differing = 0;
    for (let i = 0; i < a.data.length; i += 4)
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1]) differing++;
    expect(differing).toBeGreaterThan(200);
  });

  it('keeps the focus-player layers (trails, angles, ghosts, speed colours) in the exported frame', async () => {
    const { info, video } = await mount(CLIP);
    const swing = (t: number) => [440 + 200 * Math.sin(t * 9), 330 - 180 * Math.cos(t * 9)] as const;
    const source = createFrameSource(
      motionScene({ fps: 30, seconds: 3, body: (t) => [300 * t, 0], joints: { 10: swing } }),
    );
    const base = {
      video,
      source,
      frameIndex: 60,
      displayWidth: info.clip.displayWidth,
      displayHeight: info.clip.displayHeight,
      overlay: true,
    };
    const plainOptions = { ...DEFAULT_RENDER_OPTIONS, focusTrackId: 1, showFocusTrails: false };
    const plain = await pixels(await renderFramePng({ ...base, options: plainOptions }));
    for (const extra of [
      { showFocusTrails: true },
      { showAngles: true },
      { showGhosts: true },
      { velocityColor: true },
    ]) {
      const layered = await pixels(await renderFramePng({ ...base, options: { ...plainOptions, ...extra } }));
      let differing = 0;
      for (let i = 0; i < plain.data.length; i += 4)
        if (plain.data[i] !== layered.data[i] || plain.data[i + 1] !== layered.data[i + 1]) differing++;
      expect(differing, JSON.stringify(extra)).toBeGreaterThan(60);
    }
  });
});
