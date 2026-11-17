import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import { videoUrl } from './support';

/**
 * The premise of the player's overlay sync (05 §3.2): after a frame-step seek, requestVideoFrameCallback reports the
 * presented frame's PTS in `mediaTime`, and `lastIndexWhere(pts[i] <= mediaTime + 1e-4)` over the frame table recovers
 * the frame index. This runs against a bare <video>, so it holds the browser to the table in clips.json independently
 * of the app (Firefox reports the seek target, not the PTS, in `mediaTime`; see the comment below); the app-level check (drawn index in the real player) is in app-sync.spec.ts.
 */
const CLIPS = [
  'volleyball_spike_attempt_03.mp4', // 46 negative-PTS packets, 167 ms last-frame gap
  'volleyball_spike_attempt_04.mp4', // 31 negative-PTS packets
  'pexels_single_spiker_6217330.mp4', // starts at 0
];
const STEPS = 30;

interface StepResult {
  target: number;
  mediaTime: number;
}

for (const clip of CLIPS) {
  const { ptsUs } = clipGolden(clip).video;
  const windows = [
    { name: 'first frames', indexes: Array.from({ length: STEPS }, (_, i) => i) },
    { name: 'last frames', indexes: Array.from({ length: 6 }, (_, i) => ptsUs.length - 6 + i) },
  ];
  for (const { name, indexes } of windows) {
    test(`@cross ${clip}: rVFC mediaTime maps back to the frame-table index over ${name}`, async ({
      page,
      browserName,
    }) => {
      await page.goto('/');
      const steps = await page.evaluate(
        async ({ url, table, indexes }) => {
          const video = document.createElement('video');
          video.muted = true;
          video.preload = 'auto';
          video.src = url;
          document.body.append(video);
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error(`video failed to load: ${video.error?.message}`));
          });
          const results: StepResult[] = [];
          for (const target of indexes as number[]) {
            // Seek to the middle of the target frame, as the player does, so rounding cannot pick a neighbour.
            const next = table[target + 1] ?? (table[target] ?? 0) + 33_333;
            const middle = ((table[target] ?? 0) + (next - (table[target] ?? 0)) / 2) / 1e6;
            const presented = new Promise<number>((resolve) => {
              video.requestVideoFrameCallback((_now, metadata) => resolve(metadata.mediaTime));
            });
            video.currentTime = middle;
            results.push({ target, mediaTime: await presented });
          }
          video.remove();
          return results;
        },
        { url: videoUrl(clip), table: ptsUs, indexes },
      );

      const recovered = steps.map(({ mediaTime }) => {
        let index = -1;
        ptsUs.forEach((pts, i) => {
          if (pts / 1e6 <= mediaTime + 1e-4) index = i;
        });
        return index;
      });
      expect(recovered).toEqual(steps.map((s) => s.target));
      for (const { target, mediaTime } of steps) {
        const start = (ptsUs[target] ?? 0) / 1e6;
        const end = (ptsUs[target + 1] ?? (ptsUs[target] ?? 0) + 33_333) / 1e6;
        expect(mediaTime, `frame ${target} lies inside its own frame interval`).toBeGreaterThanOrEqual(start - 1e-4);
        expect(mediaTime).toBeLessThan(end);
        // Firefox 157 reports the seek target (the middle of the frame) instead of the frame's PTS; the index rule
        // above still recovers the right frame, so only Chromium and WebKit are held to the exact PTS.
        if (browserName !== 'firefox') expect(Math.abs(mediaTime - start), `frame ${target}`).toBeLessThan(1e-4);
      }
    });
  }
}
