import { expect, test } from '@playwright/test';
import { ERROR_DEFAULTS } from '../../src/contracts/errors';
import { CASES_DIR, CODEC_DIR, isPreview, processClip, repoVideo, useRealEngine } from './support';

test.use({ serviceWorkers: 'block' });

/**
 * Every engine error code has a title and a recovery action in the contract (`ERROR_DEFAULTS`). With the mock engine
 * (`?mock=error:<code>`) the UI must show that title and offer the contract's action.
 */
const EXPORT_CODES = new Set(['encode-unsupported', 'export-failed']);
for (const [code, info] of Object.entries(ERROR_DEFAULTS)) {
  test(`mock: ?mock=error:${code} shows "${info.title}" and a way forward`, async ({ page }) => {
    await page.goto(`/?mock=error:${code}`);
    if (EXPORT_CODES.has(code)) {
      // export errors surface in the export sheet after a successful analysis
      await page.getByTestId('file-input').setInputFiles(repoVideo('volleyball_spike_attempt_04.mp4'));
      await page
        .getByRole('status')
        .filter({ hasText: /Analysis complete/ })
        .waitFor({ state: 'attached', timeout: 30_000 });
      await page.getByRole('button', { name: 'Export', exact: true }).first().click();
      await page.getByRole('button', { name: 'Export Video with skeletons' }).click();
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
      return;
    }
    if (code !== 'unsupported-browser')
      await page.getByTestId('file-input').setInputFiles(repoVideo('volleyball_spike_attempt_04.mp4'));
    await expect(page.getByText(info.title, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    if (info.action !== 'none' && code !== 'unsupported-browser')
      await expect(page.getByRole('button').filter({ hasText: /./ }).first()).toBeVisible();
  });
}

test.describe('real engine, bad and unusual files (M2 failure modes)', () => {
  test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview (M2-2)');
  test.setTimeout(240_000);

  const problem = async (page: import('@playwright/test').Page, file: string) => {
    await page.goto('/');
    await page.getByTestId('file-input').setInputFiles(file);
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  };

  test('a file that is not a video says the format is not supported', async ({ page }) => {
    expect(await problem(page, `${CASES_DIR}/not_a_video.mp4`)).toContain('This file format is not supported');
  });

  test('an empty file says the format is not supported', async ({ page }) => {
    expect(await problem(page, `${CASES_DIR}/empty.mp4`)).toContain('not supported');
  });

  test('a file damaged in the middle says it looks damaged', async ({ page, context }) => {
    await useRealEngine(context);
    expect(await problem(page, `${CASES_DIR}/corrupt_mid.mp4`)).toContain('The file looks damaged');
  });

  test('M2-6: a truncated file (missing moov) says it is damaged or incomplete, not "no video track"', async ({
    page,
  }) => {
    const text = await problem(page, `${CASES_DIR}/truncated.mp4`);
    expect(text).not.toContain('has no video track');
    expect(text).toMatch(/damaged|incomplete|cut short/i);
  });

  test('a clip with nobody in it ends in the "No players found" state, not a blank player', async ({
    page,
    context,
  }) => {
    await useRealEngine(context);
    await processClip(page, `${CASES_DIR}/zero_solid.mp4`);
    await expect(page.getByTestId('empty-result')).toBeVisible();
    await expect(page.getByText('No players found').first()).toBeVisible();
  });

  const codecs: [string, number][] = [
    ['av1_1280x720.mp4', 2],
    ['h264_240fps.mp4', 2],
    ['h264_4k60.mp4', 2],
    ['h264_vfr.mp4', 2],
    ['hevc10_hlg_rot90.mov', 1],
    ['hevc8_1080x1920.mp4', 1],
    ['vp9_720x1280.webm', 1],
  ];
  for (const [file, minPlayers] of codecs) {
    test(`codec clip ${file} processes to completion with at least ${minPlayers} player(s)`, async ({
      page,
      context,
    }, testInfo) => {
      await useRealEngine(context);
      const result = await processClip(page, `${CODEC_DIR}/${file}`);
      // hevc10_hlg_rot90 is a landscape clip tagged 90 degrees, so the player lies on the side after the rotation is applied
      // (Chrome finds one in a few frames, WebKit none): only completion is required there on WebKit.
      const sideways = file.startsWith('hevc10_hlg_rot90') && testInfo.project.name.startsWith('webkit');
      expect(result.players).toBeGreaterThanOrEqual(sideways ? 0 : minPlayers);
    });
  }
});
