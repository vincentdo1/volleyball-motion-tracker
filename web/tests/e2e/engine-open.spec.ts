import { expect, test } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';
import { isPreview, processClip, repoVideo, useRealEngine, workaroundM21 } from './support';

/**
 * M2: every repository clip goes through the real UI and the real engine (no `?mock`): upload, process to completion,
 * results view with players, timeline lanes and a drawn skeleton overlay, frame count equal to the ffprobe golden.
 * Needs the production build (`E2E_TARGET=preview`): the dev server trips over M2-2.
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2: dev server shows an init error)');
test.use({ serviceWorkers: 'block' });
test.setTimeout(300_000);

test.fixme('M2-1: the app as shipped leaves 0 % (two frames in flight deadlock the WebGPU worker); remove when fixed', async ({
  page,
}) => {
  test.skip(workaroundM21, 'run with VBT_NO_WORKAROUND=1');
  const result = await processClip(page, repoVideo('volleyball_spike_attempt_03.mp4'), 60_000);
  expect(result.wallMs).toBeLessThan(60_000);
});

for (const [clip, golden] of Object.entries(clipGoldens.clips)) {
  test(`${clip}: uploads, completes with ${golden.video.presentableFrames} frames, players, lanes and an overlay`, async ({
    page,
    context,
  }) => {
    await useRealEngine(context);
    const result = await processClip(page, repoVideo(clip));
    expect(result.players, 'players found').toBeGreaterThan(0);
    // the data panel states the frame count the engine opened
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.getByText(String(golden.video.presentableFrames), { exact: true }).first()).toBeVisible();
    await expect(page.getByText(`${golden.video.displayWidth} x ${golden.video.displayHeight}`)).toBeVisible();
    await page.getByRole('tab', { name: 'Players' }).click();
    // one timeline lane per player (+ the ball lane): each lane has a hide toggle named after the player
    const toggles = await page.getByRole('button', { name: /^(Hide|Show) P\d+/ }).count();
    expect(toggles).toBeGreaterThanOrEqual(result.players);
  });

  const crowded = [
    'github_beach_st_lenina_20250622_g1_005.mp4',
    'github_gtu_20250316_002_volleyball_tracking.mp4',
    'github_reel_g_volleyball_tracking.mp4',
    'pexels_single_spiker_6217335.mp4',
  ].includes(clip);
  (crowded ? test.fixme : test)(
    `${clip}: the video stays at least 240 px tall and the overlay draws skeletons${crowded ? ' (M2-7: lanes squeeze the video: 236 px at 1280x720 with 11 players, 0-110 px with 20+)' : ''}`,
    async ({ page, context }) => {
      await useRealEngine(context);
      await processClip(page, repoVideo(clip));
      const stage = await page.getByTestId('video-stage').boundingBox();
      expect(stage?.height ?? 0, 'video stage height').toBeGreaterThanOrEqual(240);
      // the overlay canvas has drawn pixels at some frame of the clip
      const drawn = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=video-stage] canvas');
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return -1;
        const next = document.querySelector<HTMLElement>('button[aria-label="Next frame"]');
        let best = 0;
        for (let i = 0; i < 40; i++) {
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let n = 0;
          for (let p = 3; p < data.length; p += 4) if (data[p] !== 0) n++;
          best = Math.max(best, n);
          next?.click();
          await new Promise((r) => setTimeout(r, 60));
        }
        return best;
      });
      expect(drawn, 'overlay pixels drawn').toBeGreaterThan(200);
    },
  );
}
