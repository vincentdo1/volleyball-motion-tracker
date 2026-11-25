/**
 * The MP4 overlay is drawn by the app's own renderer with the options of the request (M3 review #29): a regression to a
 * basic renderer, to dropped focus options or to a frame source without pose history must fail here.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { afterEach, describe, expect, it } from 'vitest';
import type { FinalResult } from '@/contracts/posetrack';
import { decodePoseTrack } from '@/contracts/posetrack-codec';
import {
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
  type RenderStats,
  type SkeletonRendererFactory,
} from '@/contracts/renderer';
import { createSkeletonRenderer } from '@/render';
import type { EngineHandle } from '../client';
import { createStubEngine, fixtureFile } from '../testing/stub-engine';
import { exportMp4, frameSourceOf } from './mp4-export';
import { loadRendererFactory } from './renderer-loader';

const CLIP = 'volleyball_spike_attempt_04.mp4';
const RANGE_US: [number, number] = [1_000_000, 1_500_000];
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

async function analysed(): Promise<{ api: EngineHandle; result: FinalResult }> {
  const api = createStubEngine();
  engine = api;
  await api.init({ tierOverride: 'webgpu-default' });
  await api.open(await fixtureFile(CLIP));
  const done = new Promise<void>((resolve) => api.on('state', (e) => e.state === 'done' && resolve()));
  await api.start();
  await done;
  const json = await (await api.exportResult({ kind: 'json' })).blob.text();
  return { api, result: decodePoseTrack(JSON.parse(json)) };
}

const focusOptions = (focusTrackId: number | null, hiddenTrackIds: number[] = []): RenderOptions => ({
  ...DEFAULT_RENDER_OPTIONS,
  focusTrackId,
  hiddenTrackIds,
  showFocusTrails: true,
  showGhosts: true,
  showAngles: true,
  velocityColor: true,
  // The viewer's playback preference: the file must still get full trails.
  reducedMotion: true,
});

/** The last decoded frame of an exported video, as RGBA pixels. */
async function lastFramePixels(blob: Blob): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  let last: { data: Uint8ClampedArray; width: number; height: number } | undefined;
  for await (const sample of new VideoSampleSink(track).samples()) {
    const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      sample.draw(ctx, 0, 0);
      last = {
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      };
    }
    sample.close();
  }
  input.dispose();
  if (!last) throw new Error('no frames');
  return last;
}

function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0)) + Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0));
    if (d + Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > 90) n++;
  }
  return n;
}

describe('the overlay of the MP4 export', () => {
  it('is drawn by the renderer of the app', () => {
    expect(loadRendererFactory()).toBe(createSkeletonRenderer);
  });

  it('gives the renderer pose history and the options of the request, and never reduced motion', async () => {
    const { result } = await analysed();
    const focus = result.tracks[0]?.id ?? 0;
    const hidden = result.tracks[1]?.id ?? 0;
    const overlay = focusOptions(focus, [hidden]);
    const draws: { options: RenderOptions; hasHistory: boolean; stats: RenderStats }[] = [];
    const rendererFactory: SkeletonRendererFactory = () => {
      const real = createSkeletonRenderer();
      return {
        draw(ctx, frame, view, options) {
          const stats = real.draw(ctx, frame, view, options);
          draws.push({ options, hasHistory: frame.history !== undefined, stats });
          return stats;
        },
        dispose: () => real.dispose(),
      };
    };
    const done = await exportMp4({
      file: await fixtureFile(CLIP),
      result,
      request: { kind: 'mp4', overlay, includeAudio: false, rangeUs: RANGE_US },
      rendererFactory,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(done.frames).toBe(15);
    expect(draws).toHaveLength(15);
    expect(frameSourceOf(result).frameAt(10).history).toBeDefined();
    for (const draw of draws) {
      expect(draw.hasHistory).toBe(true);
      expect(draw.options).toEqual({ ...overlay, reducedMotion: false });
      // The focus layers ran (a renderer without them reports no focus stats).
      expect(draw.stats.focus).toBeDefined();
    }
  }, 60_000);

  it('changes pixels when the focus layers are on, through the export worker the app uses', async () => {
    const { api, result } = await analysed();
    const focus = result.tracks[0]?.id ?? 0;
    const render = async (overlay: RenderOptions) =>
      lastFramePixels(
        (await api.exportResult({ kind: 'mp4', overlay, includeAudio: false, rangeUs: RANGE_US, maxHeight: 360 })).blob,
      );
    const plain = await render({ ...focusOptions(null), showFocusTrails: false, showGhosts: false });
    const focused = await render(focusOptions(focus));
    expect(focused.width).toBe(plain.width);
    // Dimmed context players and the focus layers: far more than codec noise.
    expect(differingPixels(plain.data, focused.data)).toBeGreaterThan(200);
    // And the skeletons are drawn at all: the plain overlay differs from a clip with the overlay off.
    const off = await render({
      ...DEFAULT_RENDER_OPTIONS,
      hiddenTrackIds: result.tracks.map((t) => t.id),
      showBall: false,
      showTrails: false,
    });
    expect(differingPixels(off.data, plain.data)).toBeGreaterThan(200);
  }, 120_000);
});
