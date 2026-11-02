import { expect, test } from '@playwright/test';

/**
 * Whole product flow on the mock engine (`?mock=1`, `fast` for 2 ms chunks): choose a clip, watch it process, see the
 * results player with skeletons, change the focus player, open the export sheet and download JSON and CSV.
 * Enabled when the UI persona lands the shell (M1 UI) with the testids noted in its progress file.
 */
test.fixme('UI: upload -> processing -> results on the mock engine', async ({ page }) => {
  await page.goto('/?mock=1,fast');
  await page.getByTestId('file-input').setInputFiles('test_videos/volleyball_spike_attempt_03.mp4');
  await expect(page.getByTestId('processing')).toBeVisible();
  await expect(page.getByTestId('results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('player-overlay')).toBeVisible();
});

test.fixme('UI: an empty result (no people) shows the empty state, not a blank player', async ({ page }) => {
  await page.goto('/?mock=1,fast,empty');
  await page.getByTestId('file-input').setInputFiles('test_videos/volleyball_spike_attempt_03.mp4');
  await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 30_000 });
});

test.fixme('UI: cancel during processing returns to the clip screen within a second', async ({ page }) => {
  await page.goto('/?mock=1');
  await page.getByTestId('file-input').setInputFiles('test_videos/volleyball_spike_attempt_03.mp4');
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(page.getByTestId('processing')).toBeHidden({ timeout: 1_000 });
});
