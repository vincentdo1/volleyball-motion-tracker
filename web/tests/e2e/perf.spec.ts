import { expect, test } from '@playwright/test';
import { isPreview, processClip, repoVideo, useRealEngine } from './support';

/** M2 performance budgets on the real engine (WebGPU, models cached after the first load). Timing suite: run alone. */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2)');
test.use({ serviceWorkers: 'block' });
test.setTimeout(300_000);

test('30 s 1080p30 wide clip (gtu, 33 s) completes in <= 60 s', async ({ page, context }, info) => {
  await useRealEngine(context);
  const r = await processClip(page, repoVideo('github_gtu_20250316_002_volleyball_tracking.mp4'));
  info.annotations.push({
    type: 'wall',
    description: `${r.wallMs} ms for 991 frames (${(r.wallMs / 991).toFixed(1)} ms/frame)`,
  });
  expect(r.wallMs).toBeLessThanOrEqual(60_000);
});

test('first skeletons are listed within 3 s of choosing the file', async ({ page, context }, info) => {
  await useRealEngine(context);
  const times: number[] = [];
  for (const clip of ['volleyball_spike_attempt_04.mp4', 'github_beach_st_lenina_20250622_g1_005.mp4']) {
    const r = await processClip(page, repoVideo(clip));
    expect(r.firstPlayerMs).not.toBeNull();
    times.push(r.firstPlayerMs as number);
  }
  info.annotations.push({ type: 'first-skeleton', description: `${times.join(', ')} ms` });
  expect(Math.max(...times)).toBeLessThanOrEqual(3000);
});

test.fixme('UI: overlay p95 <= 4 ms at 3840x2160 with 12 players and every layer on (Chrome, M5 Pro)', async () => {
  // covered by src/render/renderer.perf.browser.test.ts (UI persona), run via npm run test:browser
});
