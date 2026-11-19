import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { installProbe, outDir, readPoseTrack, saveJson, waitComplete } from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * Codex review F4: the Settings "Quality mode" toggle promises to apply to the NEXT clip. In one page (one engine):
 * quality off -> clip one exports tier webgpu-default; quality on -> clip two exports webgpu-quality (D-FINE-M in the
 * model list); quality off again -> clip three exports webgpu-default again. Judged on the exported JSON, not on the
 * toggle.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m5-quality
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 900 } });
test.setTimeout(600_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';

interface Doc {
  processing: { settings: { tier: string; backend: string }; device: { tier: string; backend: string } };
  models: { id?: string; name?: string; role?: string }[];
  tracks: unknown[];
}

async function setQuality(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const toggle = page.getByRole('button', { name: /^(On|Off)$/ });
  await toggle.waitFor({ state: 'visible' });
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed !== on) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', on ? 'true' : 'false');
  await page.keyboard.press('Escape');
  await toggle.waitFor({ state: 'hidden' });
}

async function runChosen(page: Page, dir: string, label: string): Promise<Doc> {
  await page.getByTestId('file-input').setInputFiles(repoVideo(CLIP));
  await waitComplete(page, 420_000);
  const doc = readPoseTrack(await exportFile(page, 'json', join(dir, label))) as unknown as Doc;
  await page.keyboard.press('Escape');
  return doc;
}

test('F4: quality off -> webgpu-default, on -> webgpu-quality, off again -> webgpu-default (one page, one engine)', async ({
  context,
  page,
}) => {
  const dir = outDir('m5-quality');
  await installProbe(context);
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  // clip one: quality off (the default); open Settings on the landing screen to prove the state first
  await setQuality(page, false);
  const one = await runChosen(page, dir, 'one-off');

  await page.getByRole('button', { name: 'New clip' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 10_000 });
  await setQuality(page, true);
  const two = await runChosen(page, dir, 'two-on');

  await page.getByRole('button', { name: 'New clip' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 10_000 });
  await setQuality(page, false);
  const three = await runChosen(page, dir, 'three-off');

  const view = (d: Doc) => ({
    settingsTier: d.processing.settings.tier,
    deviceTier: d.processing.device.tier,
    backend: d.processing.device.backend,
    models: d.models.map((m) => m.id ?? m.name ?? JSON.stringify(m)),
    tracks: d.tracks.length,
  });
  const report = { one: view(one), two: view(two), three: view(three) };
  saveJson(dir, 'report.json', report);
  console.log(`quality: ${JSON.stringify(report)}`);

  expect(report.one.deviceTier).toBe('webgpu-default');
  expect(report.one.settingsTier).toBe('webgpu-default');
  expect(report.two.deviceTier).toBe('webgpu-quality');
  expect(report.two.settingsTier).toBe('webgpu-quality');
  expect(report.two.models.join(' '), 'D-FINE-M is in the quality run model list').toMatch(/dfine-m/i);
  expect(report.three.deviceTier).toBe('webgpu-default');
  expect(report.three.settingsTier).toBe('webgpu-default');
  expect(report.three.models.join(' '), 'the small detector is back').toMatch(/dfine-s/i);
  expect(report.three.models.join(' ')).not.toMatch(/dfine-m/i);
});
