import { ALL_FORMATS, CanvasSink, Input, UrlSource } from 'mediabunny';
import { afterEach, describe, expect, it } from 'vitest';
import { frameIndexForMediaTime } from '@/contracts/frame-table';
import { disposeMounted, mount, onCleanup } from './harness';

const CLIPS = [
  'volleyball_spike_attempt_03.mp4',
  'volleyball_spike_attempt_04.mp4',
  'pexels_single_spiker_6217330.mp4',
];
const STEPS = 30;
const START_INDEX = 20;
const PROBE_WIDTH = 64;

afterEach(disposeMounted);

/** Mean absolute pixel difference between two canvases of the same size. */
function difference(a: CanvasImageSource, b: CanvasImageSource): number {
  const read = (source: CanvasImageSource) => {
    const c = new OffscreenCanvas(PROBE_WIDTH, PROBE_WIDTH * 0.5625);
    const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };
  const x = read(a);
  const y = read(b);
  let sum = 0;
  for (let i = 0; i < x.length; i += 4)
    sum += Math.abs((x[i] as number) - (y[i] as number)) + Math.abs((x[i + 1] as number) - (y[i + 1] as number));
  return sum / (x.length / 4);
}

describe.each(CLIPS)('frame-accurate overlay sync on %s', (clipName) => {
  it(`draws the frame-table index of the presented frame for ${STEPS} consecutive frame-steps`, async () => {
    const url = `/__fixtures/videos/${clipName}`;
    const { info, video, controller, nextDraw } = await mount(url);
    const pts = info.frameTable.ptsUs;
    expect(pts.length).toBeGreaterThan(START_INDEX + STEPS + 2);

    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    onCleanup(() => input.dispose());
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const sink = new CanvasSink(track, { width: PROBE_WIDTH, height: Math.round(PROBE_WIDTH * 0.5625), fit: 'fill' });
    const decoded = async (index: number) => {
      const wrapped = await sink.getCanvas((pts[index] as number) / 1e6 + 1e-6);
      if (!wrapped) throw new Error(`no decoded frame at ${index}`);
      return wrapped.canvas;
    };

    let pending = nextDraw();
    controller.seekToIndex(START_INDEX);
    expect((await pending).frameIndex).toBe(START_INDEX);

    for (let i = 1; i <= STEPS; i++) {
      pending = nextDraw();
      controller.step(1);
      const drawn = await pending;
      const expected = START_INDEX + i;
      expect(drawn.frameIndex, `step ${i}`).toBe(expected);
      if (drawn.mediaTimeS !== null)
        expect(frameIndexForMediaTime(pts, drawn.mediaTimeS), `mediaTime at step ${i}`).toBe(expected);
      // independent check: the picture on screen is the decoded frame the table says it is, not a neighbour
      const onScreen = difference(video, await decoded(expected));
      const previous = difference(video, await decoded(expected - 1));
      const next = difference(video, await decoded(expected + 1));
      expect(onScreen, `pixels at step ${i}`).toBeLessThanOrEqual(Math.min(previous, next) + 0.5);
    }
    expect(controller.getSnapshot().frameIndex).toBe(START_INDEX + STEPS);
  });
});
