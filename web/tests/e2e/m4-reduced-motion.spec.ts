import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  frameAt,
  openClip,
  outDir,
  readPoseTrack,
  saveJson,
  seekToFrame,
  selectTab,
  setLayer,
  waitComplete,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B2b item 1l (review finding #16, "exports are content"): with reduced motion emulated (Playwright
 * reducedMotion: 'reduce' for the whole context) the PNG and the MP4 still contain the full trails and ghosts.
 * beach, picked player P1 (moves at 2.57 s), hand trails + ghosts + angles on:
 *  A  PNG under 'reduce'
 *  C  PNG after switching the emulation to 'no-preference' (must be pixel-identical to A)
 *  D  PNG under 'reduce' with hand trails and ghosts off (must differ from A: the trails are in A)
 *  V1/V2  the viewer's own stage screenshot under reduce and under no-preference (shows the emulation took effect)
 *  MP4 frame at the same time, looked at by eye.
 *   PORT=5184 E2E_TARGET=preview caffeinate -d -i -s npx playwright test m4-reduced-motion
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  reducedMotion: 'reduce',
});
test.setTimeout(900_000);

function psnr(a: string, b: string): { identical: boolean; line: string } {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const line = (
    r.stderr
      .split('\n')
      .filter((l) => l.includes('PSNR'))
      .at(-1) ?? ''
  ).trim();
  return { identical: /average:inf/.test(line), line };
}

test('exports are content: PNG and MP4 keep the full trails under reduced motion', async ({ page }) => {
  const dir = outDir('1l-reduced-motion');
  const report: Record<string, unknown> = {};
  await page.emulateMedia({ reducedMotion: 'reduce' });
  report.mediaReduce = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await openClip(page, repoVideo('github_beach_st_lenina_20250622_g1_005.mp4'));
  await waitComplete(page, 600_000);
  const json = await exportFile(page, 'json', dir);
  await page.keyboard.press('Escape');
  const track = readPoseTrack(json);
  const f = frameAt(track.frames.ptsUs, 2.57);
  await page
    .locator('ul[aria-label=Players] > li')
    .filter({ has: page.getByRole('button', { name: 'Hide P1', exact: true }) })
    .locator('button')
    .first()
    .click();
  await selectTab(page, 'Layers');
  for (const layer of ['Hand trails', 'Ghosts', 'Angles']) await setLayer(page, layer, true);
  await seekToFrame(page, f);
  await page.waitForTimeout(600);
  const stage = page.locator('[data-testid=video-stage]');
  await stage.screenshot({ path: join(dir, 'view-reduce-stage.png') });
  const A = await exportFile(page, 'png', dir);
  execFileSync('cp', [A, join(dir, 'A-png-reduce.png')]);
  await page.keyboard.press('Escape');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  report.mediaNoPref = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await page.waitForTimeout(800);
  await stage.screenshot({ path: join(dir, 'view-nopref-stage.png') });
  const C = await exportFile(page, 'png', dir);
  execFileSync('cp', [C, join(dir, 'C-png-nopref.png')]);
  await page.keyboard.press('Escape');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(500);
  await setLayer(page, 'Hand trails', false);
  await setLayer(page, 'Ghosts', false);
  await page.waitForTimeout(500);
  const D = await exportFile(page, 'png', dir);
  execFileSync('cp', [D, join(dir, 'D-png-reduce-no-trails.png')]);
  await page.keyboard.press('Escape');
  await setLayer(page, 'Hand trails', true);
  await setLayer(page, 'Ghosts', true);

  // MP4 under reduce
  const mp4 = await exportFile(page, 'mp4', dir);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    mp4,
    '-vf',
    `select=eq(n\\,${f})`,
    '-vframes',
    '1',
    join(dir, 'E-mp4-reduce.png'),
  ]);

  report.frame = f;
  report.viewReduceVsNoPref = psnr(join(dir, 'view-reduce-stage.png'), join(dir, 'view-nopref-stage.png'));
  report.pngReduceVsNoPref = psnr(join(dir, 'A-png-reduce.png'), join(dir, 'C-png-nopref.png'));
  report.pngWithVsWithoutTrails = psnr(join(dir, 'A-png-reduce.png'), join(dir, 'D-png-reduce-no-trails.png'));
  saveJson(dir, 'report.json', report);
  console.log(`reduced-motion: ${JSON.stringify(report)}`);
  expect(report.mediaReduce).toBe(true);
  expect(report.mediaNoPref).toBe(false);
  expect(
    (report.pngReduceVsNoPref as { identical: boolean }).identical,
    'PNG is the same whatever the preference',
  ).toBe(true);
  expect((report.pngWithVsWithoutTrails as { identical: boolean }).identical, 'trails and ghosts are in the PNG').toBe(
    false,
  );
});
