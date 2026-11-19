import { expect, type Page, test } from '@playwright/test';
import { isPreview, repoVideo } from './support';

/**
 * Codex review F3 (and plan M4 "offline after first load"): a FRESH browser context loads the production build, waits
 * until the service worker controls the page, goes offline and reloads with no online reload in between. The landing
 * screen must appear (the review saw an empty page: the precached JS/CSS carried `Vary: Origin` and did not match the
 * browser's module requests). The visit's set-up (models and runtime files cached) completes before the network goes
 * away, and a clip is then analysed offline.
 *
 * Service workers are allowed here (unlike every other real-engine spec), on purpose.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-offline
 */
test.skip(!isPreview, 'tests the production build: E2E_TARGET=preview');
test.setTimeout(420_000);

const MODEL_CACHE = 'vbt-models-v1';

async function waitControlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
    );
  });
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

const ORT_CACHE = 'vbt-ort-v1';

/** Names of the Cache API caches and how many entries the model and ORT runtime caches hold. */
const cacheState = (page: Page) =>
  page.evaluate(
    async ([modelCache, ortCache]) => {
      const names = await caches.keys();
      const count = async (name: string) =>
        names.includes(name) ? (await (await caches.open(name)).keys()).length : 0;
      return { names, models: await count(modelCache), ort: await count(ortCache) };
    },
    [MODEL_CACHE, ORT_CACHE] as const,
  );

async function expectLanding(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect(page.getByRole('alert')).toHaveCount(0);
}

async function analyse(page: Page, clip: string): Promise<number> {
  await page.getByTestId('file-input').setInputFiles(repoVideo(clip));
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: 300_000 });
  return page.locator('ul[aria-label=Players] > li').count();
}

test('F3: first visit -> service worker controls the page -> offline -> reload shows the landing screen', async ({
  page,
  context,
}, testInfo) => {
  const failed: string[] = [];
  page.on('requestfailed', (request) => failed.push(`${request.url()} ${request.failure()?.errorText ?? ''}`));
  await page.goto('/');
  await expectLanding(page);
  await waitControlled(page);
  // the build's precache is complete before the network goes away
  await expect
    .poll(async () => (await cacheState(page)).names.some((n) => n.startsWith('vbt-app-')), { timeout: 30_000 })
    .toBe(true);
  // "after the first visit": the visit's set-up is complete once the models and the runtime files are cached
  await expect
    .poll(
      async () => {
        const state = await cacheState(page);
        // three models, and the runtime's loader and wasm (Chrome's WebGPU flavour loads both)
      return state.models >= 3 && state.ort >= 2;
      },
      { timeout: 180_000 },
    )
    .toBe(true);
  const before = await cacheState(page);
  failed.length = 0;

  await context.setOffline(true);
  await page.reload();
  await expectLanding(page);
  // an empty page was the defect: the app's own scripts and styles must load from the cache (the heading above only
  // renders when they did)
  expect(
    failed.filter((u) => /\.(js|css)\b/.test(u)),
    'failed script/style requests offline',
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('offline-landing.png') });

  const after = await cacheState(page);
  console.log(`offline: caches before ${JSON.stringify(before)}, after the offline reload ${JSON.stringify(after)}`);
  testInfo.annotations.push({
    type: 'cache',
    description: `caches before offline: ${JSON.stringify(before)}; after the offline reload: ${JSON.stringify(after)}`,
  });
  // The work order: where the models are cached in this context, analyse a clip offline. On a first visit that never
  // analysed anything the model cache is empty, so this only runs when something put the models there.
  if (after.models >= 3) {
    expect(await analyse(page, 'volleyball_spike_attempt_04.mp4')).toBeGreaterThanOrEqual(2);
  } else {
    testInfo.annotations.push({
      type: 'note',
      description: `models are not cached in a context that never analysed (${after.models} entries): offline analysis is covered by the next test`,
    });
  }
});

test('F3: after one online analysis the same context reloads offline and analyses a clip from the cache', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/');
  await expectLanding(page);
  await waitControlled(page);
  const online = await analyse(page, 'volleyball_spike_attempt_04.mp4');
  expect(online).toBeGreaterThanOrEqual(2);
  const cached = await cacheState(page);
  expect(cached.models, 'models stored by the online run').toBeGreaterThanOrEqual(3);

  // no online reload between the analysis and going offline
  await context.setOffline(true);
  await page.reload();
  await expectLanding(page);
  // a different clip: the same one would only offer the saved results ("You analysed this clip before")
  const offline = await analyse(page, 'volleyball_spike_attempt_03.mp4');
  expect(offline, 'players found offline').toBeGreaterThanOrEqual(1);
  console.log(`offline: att04 online ${online} players, att03 offline ${offline}; caches ${JSON.stringify(cached)}`);
  testInfo.annotations.push({
    type: 'result',
    description: `att04 online ${online} players, att03 offline ${offline}; caches ${JSON.stringify(cached)}`,
  });
});
