import { afterEach, describe, expect, it } from 'vitest';
import { frameIndexForMediaTime } from '@/contracts/frame-table';
import { disposeMounted, mount } from './harness';

const CLIP = '/__fixtures/videos/volleyball_spike_attempt_03.mp4';

afterEach(disposeMounted);

describe('PlayerController on a real clip', () => {
  it('draws once per presented frame during playback, in order, never interpolating', async () => {
    const { info, controller, draws } = await mount(CLIP);
    draws.length = 0;
    controller.setMuted(true); // headless autoplay needs a muted video
    controller.setRate(0.5);
    controller.play();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.pause();
    expect(draws.length).toBeGreaterThan(5);
    const pts = info.frameTable.ptsUs;
    let previous = -1;
    for (const d of draws) {
      expect(d.frameIndex).toBeGreaterThanOrEqual(previous);
      if (d.mediaTimeS !== null) expect(d.frameIndex).toBe(frameIndexForMediaTime(pts, d.mediaTimeS));
      previous = d.frameIndex;
    }
    expect(new Set(draws.map((d) => d.frameIndex)).size).toBe(draws.length);
  });

  it('applies playback rates and mutes the slow ones', async () => {
    const { video, controller } = await mount(CLIP);
    controller.setRate(0.125);
    expect(video.playbackRate).toBe(0.125);
    expect(video.muted).toBe(true);
    controller.setRate(1);
    controller.setMuted(false);
    expect(video.muted).toBe(false);
    controller.setLoop(true);
    expect(video.loop).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ rate: 1, loop: true });
  });

  it('lands on the last requested frame after a burst of scrub requests', async () => {
    const { controller, nextDraw } = await mount(CLIP);
    let pending = nextDraw();
    controller.seekToIndex(30);
    await pending;
    pending = nextDraw();
    for (const i of [40, 80, 120, 60, 100]) controller.seekToIndex(i);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controller.getSnapshot().frameIndex).toBe(100);
  });

  it('clamps frame steps at both ends of the clip', async () => {
    const { info, controller, nextDraw } = await mount(CLIP);
    let pending = nextDraw();
    controller.step(-1);
    controller.seekToIndex(0);
    await pending;
    expect(controller.getSnapshot().frameIndex).toBe(0);
    pending = nextDraw();
    controller.seekToIndex(info.frameTable.ptsUs.length + 50);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(controller.getSnapshot().frameIndex).toBe(info.frameTable.ptsUs.length - 1);
  });
});
