import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { outDir, saveJson, waitComplete } from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * The UI/UX items of the Codex review that were done, checked in the real app (production build):
 *   rank 1: "Preparing analysis" from the moment a file is chosen (no ignored-click look)
 *   rank 4: Cancel in the export sheet aborts a running video export without an error
 *   rank 7: a codec identifier on the error screen is shown as a recognisable name
 *   rank 9: the Settings button "Reset preferences" puts quality mode back to off and leaves saved analyses alone
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-ui-items
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 900 } });
test.setTimeout(300_000);

const ATT04 = repoVideo('volleyball_spike_attempt_04.mp4');

test('rank 1: "Preparing analysis" shows right after a file is chosen, with the download in a fresh context', async ({
  page,
}) => {
  const dir = outDir('m5-ui-items');
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as unknown as { __seen: { t: number; text: string }[] };
    w.__seen = [];
    const t0 = performance.now();
    let last = '';
    const look = () => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ');
      const state = /Preparing analysis/.test(text)
        ? `preparing${/Download progress|MB|%/.test(text) ? '+progress' : ''}`
        : document.querySelector('[data-testid=processing-pill]')
          ? 'pill'
          : /Analysis complete|Players/.test(text)
            ? 'results'
            : 'other';
      if (state !== last) w.__seen.push({ t: Math.round(performance.now() - t0), text: state });
      last = state;
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    setInterval(look, 50);
  });
  const t0 = Date.now();
  await page.getByTestId('file-input').setInputFiles(ATT04);
  await expect(page.getByText('Preparing analysis').first()).toBeVisible({ timeout: 3_000 });
  const firstShownMs = Date.now() - t0;
  await page.screenshot({ path: join(dir, 'rank1-preparing.png') });
  await waitComplete(page, 240_000);
  const seen = await page.evaluate(() => (window as unknown as { __seen: unknown[] }).__seen);
  saveJson(dir, 'rank1.json', { firstShownMs, seen });
  console.log(`rank1: ${JSON.stringify({ firstShownMs, seen })}`);
  expect((seen as { text: string }[]).map((s) => s.text)[0], 'the first state after the choice is Preparing').toMatch(
    /^preparing/,
  );
});

test('rank 4: Cancel in the export sheet aborts a running video export, with no error, and exports work again', async ({
  page,
}) => {
  const dir = outDir('m5-ui-items');
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo('github_beach_st_lenina_20250622_g1_005.mp4'));
  await waitComplete(page, 240_000);
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Export Video with skeletons' }).click();
  const cancel = page.getByTestId('export-cancel');
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(dir, 'rank4-exporting.png') });
  await cancel.click();
  await expect(cancel).toBeHidden({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(dir, 'rank4-cancelled.png') });
  expect(await page.getByRole('alert').count(), 'no error after a cancel').toBe(0);
  expect(downloads, 'no file from the cancelled export').toEqual([]);
  // the sheet is usable again
  const json = await exportFile(page, 'json', dir);
  expect(json).toMatch(/\.json$/);
  saveJson(dir, 'rank4.json', { downloadsAfterCancel: downloads, jsonAfter: json });
});

test('rank 7: an unsupported-codec screen names the codec (HEVC), not its identifier', async ({ page }) => {
  const dir = outDir('m5-ui-items');
  await page.goto('/?mock=error:unsupported-codec');
  await page.getByTestId('file-input').setInputFiles(ATT04);
  await expect(page.getByText('This browser cannot decode this video').first()).toBeVisible({ timeout: 20_000 });
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  await page.screenshot({ path: join(dir, 'rank7-codec.png') });
  saveJson(dir, 'rank7.json', { text });
  console.log(`rank7: ${text.slice(0, 600)}`);
  expect(text).toMatch(/HEVC|H\.265/);
  // the identifier may live in the copyable technical details, never in the explanation sentence
  const alert = (await page.getByRole('alert').first().innerText()).replace(/\s+/g, ' ');
  expect(alert.split(/Details|Technical|Copy/)[0], 'explanation has no raw identifier').not.toMatch(/hvc1|hev1/i);
});

test('rank 9: "Reset preferences" turns quality mode off and leaves saved analyses alone', async ({ page }) => {
  const dir = outDir('m5-ui-items');
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const quality = page.getByRole('button', { name: /^(On|Off)$/ });
  await quality.click();
  await expect(quality).toHaveAttribute('aria-pressed', 'true');
  const reset = page.getByRole('button', { name: /Reset preferences/ });
  await expect(reset).toBeVisible();
  await page.screenshot({ path: join(dir, 'rank9-before.png') });
  await reset.click();
  await expect(page.getByText('Preferences reset')).toBeVisible({ timeout: 5_000 });
  await expect(quality).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: join(dir, 'rank9-after.png') });
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  expect(body).not.toMatch(/Clear local data/i);
  await page.keyboard.press('Escape');
  // a saved analysis survives: analyse a clip, reset again, choose the clip once more -> "You analysed this clip before"
  await page.getByTestId('file-input').setInputFiles(ATT04);
  await waitComplete(page, 240_000);
  await page.getByRole('button', { name: 'New clip' }).click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: /Reset preferences/ }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('file-input').setInputFiles(ATT04);
  await expect(page.getByText('You analysed this clip before')).toBeVisible({ timeout: 30_000 });
  saveJson(dir, 'rank9.json', { ok: true });
});
