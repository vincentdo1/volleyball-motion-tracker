import { expect, test } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';
import { isPreview, processClip, repoVideo } from './support';

/**
 * Cross-browser end to end (M2-9 / M2-10): a short clip goes through the real UI and engine to "Analysis complete" in
 * WebKit (WebGPU or its fallback) and in headed Firefox (WebGPU fails on a WGSL pad shader, so the engine must step
 * down to the WASM tier with a calm notice and never show raw ONNX Runtime text). Production build only.
 *   E2E_TARGET=preview PORT=5184 PLAYWRIGHT_BROWSERS_PATH=... npx playwright test -c tests/playwright.cross.config.ts cross-e2e
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block' });
test.setTimeout(420_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';

test('@cross a clip processes to done through the UI, no raw runtime text on screen', async ({ page }) => {
  const logs: string[] = [];
  page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 200)}`));
  const result = await processClip(page, repoVideo(CLIP), 400_000);
  const project = test.info().project.name;
  const body = await page.locator('body').innerText();
  console.log(
    `${project}: ${JSON.stringify({ ...result, notice: /slower mode/i.test(body) })} pageerrors=${logs.length}`,
  );
  expect(result.players, 'players found').toBeGreaterThan(0);
  expect(body, 'raw ORT text must never reach the screen').not.toMatch(/OrtRun|Shader '|WGSL|failed to call/i);
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(
    page.getByText(String(clipGoldens.clips[`${CLIP}`]?.video.presentableFrames), { exact: true }).first(),
  ).toBeVisible();
});
