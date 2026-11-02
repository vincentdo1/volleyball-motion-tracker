import { expect, test } from '@playwright/test';
import { isPreview, processClip, repoVideo, useRealEngine } from './support';

/** M2: cancel (keep / discard), restart after a cancel, and reload mid-run, on the real engine. */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2)');
test.use({ serviceWorkers: 'block' });
test.setTimeout(240_000);

const clip = repoVideo('github_beach_st_lenina_20250622_g1_005.mp4');
const percent = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent?.match(/(\d+)%/) ?? [])[1] ?? -1),
  );

async function startAndWait(page: import('@playwright/test').Page, atLeast: number) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(clip);
  await expect.poll(() => percent(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(atLeast);
}

test('discard returns to the landing screen in under 250 ms and the same clip then runs to completion', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  expect(Date.now() - t0).toBeLessThan(250);
  await page.waitForTimeout(600); // a person cannot pick a file sooner; see the M2-8 test for the immediate case
  await page.getByTestId('file-input').setInputFiles(clip);
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 120_000 });
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(5);
});

test('keep partial shows the analysed part and offers the frame PNG', async ({ page, context }) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Keep \d+% analysed/ }).click();
  await expect(page.getByTestId('processing-pill')).toHaveCount(0);
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Export Current frame' })).toBeEnabled();
});

test.fixme('M2-8: choosing a file right after Discard is accepted (the engine is still cancelling and rejects open with invalid-state)', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 120_000 });
});

test.fixme('M2-4: a kept partial result can export its tracking data (JSON, CSV) and the overlay video', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 30);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Keep \d+% analysed/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Export Tracking data' })).toBeEnabled();
});

test.fixme('M2-5: after a reload the same clip resumes from the saved chunks (finished chunks skipped, result equal)', async ({
  page,
  context,
}) => {
  await useRealEngine(context);
  await startAndWait(page, 50);
  await page.reload();
  const t0 = Date.now();
  const rerun = await processClip(page, clip);
  expect(rerun.wallMs).toBeLessThan((Date.now() - t0) * 0.7);
});
