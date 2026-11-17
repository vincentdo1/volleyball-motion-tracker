import { expect, test } from '@playwright/test';
import { isPreview, repoVideo, useRealEngine } from './support';

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

test('M2-8: choosing a file right after Discard is accepted (the engine is still cancelling and rejects open with invalid-state)', async ({
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

test('M2-4: a kept partial result can export its tracking data (JSON, CSV) and the overlay video', async ({
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

test('M2-5: after a reload the same clip offers to continue and skips the finished 10 s chunks (result complete)', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(300_000);
  // Playwright's WebKit refuses OPFS sync access handles ("UnknownError ... transient reason"), so the engine falls back to
  // its in-memory store and a reload loses the chunks. Real Safari is not covered here (M2-17, accepted limitation).
  test.skip(testInfo.project.name.startsWith('webkit'), 'OPFS sync access handles do not work in Playwright WebKit');
  await useRealEngine(context);
  const gtu = repoVideo('github_gtu_20250316_002_volleyball_tracking.mp4'); // chunks are 10 s windows: needs a clip longer than that
  const t0 = Date.now();
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(gtu);
  await expect.poll(() => percent(page), { timeout: 120_000 }).toBeGreaterThanOrEqual(50);
  const halfMs = Date.now() - t0; // progress is close to linear, so a full run is about twice this
  await page.reload();
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  await page.getByTestId('file-input').setInputFiles(gtu);
  await expect(page.getByRole('dialog')).toContainText(/Continue where you left off/);
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 240_000 });
  expect(Date.now() - t1).toBeLessThan(halfMs * 2 * 0.85);
  expect(await page.locator('ul[aria-label=Players] > li').count()).toBeGreaterThan(20);
});
