import { expect, type Route, test } from '@playwright/test';
import { isPreview, repoVideo } from './support';

/**
 * Codex re-review N1, the symptom a user sees: in its repro the small ball model finished while the detector and pose
 * downloads were held, and the app read "100 %" with almost every byte still to come. Here the large downloads are
 * held the same way: no share shown meanwhile comes near 100 %, and once they are let through the clip reaches
 * results. (That the engine announces every model before loading is checked in src/engine/runtime/ort-provider.test.ts:
 * downloads from this machine are too fast to catch a model mid-download here.)
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-download-progress
 */
test.skip(!isPreview, 'tests the production build: E2E_TARGET=preview');
test.setTimeout(240_000);
// a fresh context without the service worker: the models come from the network, and the routes see every request
test.use({ serviceWorkers: 'block' });

test('N1: the download share counts the models that have not reported yet', async ({ page, context }) => {
  const held: Route[] = [];
  let holding = true;
  await context.route(/\/models\/(dfine|rtmpose)-[^/]+\.onnx$/, async (route) => {
    if (holding) held.push(route);
    else await route.continue();
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(repoVideo('volleyball_spike_attempt_04.mp4'));
  await expect(page.getByTestId('preparing')).toBeVisible();
  await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  // the ball model is through; whatever share is shown while the large models are held is far from complete
  const shown: string[] = [];
  for (let i = 0; i < 20; i++) {
    const progress = page.getByTestId('preparing-progress');
    if (await progress.isVisible()) shown.push((await progress.textContent()) ?? '');
    await page.waitForTimeout(150);
  }
  for (const text of shown) {
    const percent = Number(/(\d+)%/.exec(text)?.[1] ?? '0');
    expect(percent, `progress shown while the large models were held: ${text}`).toBeLessThan(50);
  }

  holding = false;
  for (const route of held.splice(0)) await route.continue();
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 180_000 });
});
