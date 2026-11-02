import { expect, test } from '@playwright/test';

/**
 * M1 UI acceptance: in the real player, the drawn overlay frame index equals the frame-table index of the presented
 * `mediaTime` over 30 frame-steps on attempt_03, attempt_04 and a pexels clip (the bare-<video> premise is checked in
 * sync-baseline.spec.ts). The player exposes `window.__player = { drawnIndex, mediaTime }` in `?debug=1` (testing hook,
 * 04 §8.5); the UI persona names the exact hook when it lands.
 */
for (const clip of [
  'volleyball_spike_attempt_03.mp4',
  'volleyball_spike_attempt_04.mp4',
  'pexels_single_spiker_6217330.mp4',
]) {
  test.fixme(`UI: ${clip}: drawn index equals the frame-table index over 30 frame steps`, async ({ page }) => {
    await page.goto('/?mock=1,fast&debug=1');
    await page.getByTestId('file-input').setInputFiles(`test_videos/${clip}`);
    await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
    for (let step = 0; step < 30; step++) {
      await page.keyboard.press('.');
      await page.waitForFunction(() => (window as unknown as { __player?: unknown }).__player !== undefined);
    }
  });
}
