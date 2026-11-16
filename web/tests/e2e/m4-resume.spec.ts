import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import {
  completeness,
  dataNotes,
  dumpProbe,
  installProbe,
  laneProbe,
  outDir,
  pageNow,
  pillPercent,
  playerRows,
  readPoseTrack,
  saveJson,
  selectTab,
  waitComplete,
  waitPercent,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B2a item 2b (M2-18, review finding #8): reload at about 50 %, pick the clip again, Continue. The part already
 * analysed must show at once, the page must stay responsive while it is replayed (longest main-thread task) and the
 * run must end with a full result.
 *   PORT=5184 E2E_TARGET=preview caffeinate -i -s npx playwright test m4-resume
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(400_000);

const GTU = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const frames = clipGolden(GTU).video.presentableFrames;

test('resume after a reload at about 50 %: the analysed part shows at once, the page stays responsive, the result is full', async ({
  page,
  context,
}) => {
  const dir = outDir('2b-resume');
  await installProbe(context);
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  const startT = await pageNow(page);
  await page.getByTestId('file-input').setInputFiles(repoVideo(GTU));
  const before = await waitPercent(page, 50);
  const playersBefore = (await playerRows(page)).length;
  const halfMs = (await pageNow(page)) - startT;
  await page.screenshot({ path: join(dir, '1-before-reload.png') });

  await page.reload();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(GTU));
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ');
  await page.screenshot({ path: join(dir, '2-continue-dialog.png') });

  const clickT = await pageNow(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  // the analysed part must be on screen at once: players listed and lanes drawn within a couple of seconds
  const shown = await page
    .waitForFunction(() => document.querySelectorAll('ul[aria-label=Players] > li').length > 0, undefined, {
      timeout: 20_000,
      polling: 50,
    })
    .then(() => pageNow(page));
  const showAfterMs = shown - clickT;
  const lanesAtShow = await laneProbe(page);
  const pctAtShow = await pillPercent(page);
  await page.screenshot({ path: join(dir, '3-after-continue.png') });
  await page.waitForTimeout(3000);
  const lanes3s = await laneProbe(page);
  const pct3s = await pillPercent(page);
  const players3s = (await playerRows(page)).length;

  await waitComplete(page, 300_000);
  const doneT = await pageNow(page);
  await page.screenshot({ path: join(dir, '4-complete.png') });
  await selectTab(page, 'Data');
  const notes = await dataNotes(page);
  const dump = await dumpProbe(page);
  const result = completeness(readPoseTrack(await exportFile(page, 'json', dir)));
  const afterClick = dump.longTasks.filter((l) => l.t >= clickT);
  const worst = afterClick.reduce((m, l) => Math.max(m, l.ms), 0);
  const pcts = dump.samples.filter((s) => s.t >= clickT && s.pct !== null).map((s) => s.pct as number);
  const report = {
    pctBeforeReload: before,
    playersBeforeReload: playersBefore,
    halfMs,
    dialogText,
    showAfterMs,
    pctAtShow,
    lanesAtShow,
    pct3s,
    lanes3s,
    players3s,
    firstPcts: pcts.slice(0, 8),
    monotonic: pcts.every((p, i) => i === 0 || p >= (pcts[i - 1] as number)),
    resumeRunMs: doneT - clickT,
    longestTaskMs: worst,
    longTasksOver100: afterClick.filter((l) => l.ms > 100),
    runStarted: dump.log.filter((e) => e.k === 'run-started'),
    notes,
    result,
  };
  saveJson(dir, 'report.json', report);
  saveJson(dir, 'probe.json', dump);
  console.log(`resume: ${JSON.stringify(report)}`);

  expect(dialogText).toMatch(/Continue where you left off/);
  expect(showAfterMs, 'the analysed part shows at once').toBeLessThan(3000);
  expect(players3s, 'players listed 3 s after Continue').toBeGreaterThan(0);
  expect(worst, 'the longest main-thread task while replaying').toBeLessThan(500);
  expect(result.frames).toBe(frames);
  expect(result.processed, 'a full result').toBe(frames);
  expect(result.partial).toBe(false);
});
