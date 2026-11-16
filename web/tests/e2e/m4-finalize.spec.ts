import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import {
  completeness,
  dumpProbe,
  installProbe,
  openClip,
  outDir,
  type ProbeDump,
  pageNow,
  playerRows,
  readPoseTrack,
  routeEngineFaults,
  saveJson,
  waitComplete,
  waitForLog,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B item 1f (review finding #11): `finalizing` hangs on the real engine and the production build. The first
 * engine worker blocks its thread right after it reports the finalizing stage (see `routeEngineFaults`), which is what
 * a stuck stitch, smooth or store write looks like from the page. The client's ceiling for finalizing is 60 s plus 2 s
 * per second of clip (about 72 s for the 6 s clip used here), counted in awake page time.
 *   PORT=5184 E2E_TARGET=preview npx playwright test m4-finalize
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(600_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';
const NEXT = 'github_beach_st_lenina_20250622_g1_005.mp4';
const clip = clipGolden(CLIP).video;
const nextFrames = clipGolden(NEXT).video.presentableFrames;
/** FINALIZE_FLOOR_MS + FINALIZE_MS_PER_CLIP_SECOND per second of clip (web/src/engine/client.ts). */
const ceilingMs = 60_000 + 2000 * ((clip.lastPtsUs + clip.lastFrameDurationUs - clip.firstPtsUs) / 1e6);

test('a hang in finalizing ends in a plain error after the ceiling, and the next clip reaches results', async ({
  page,
  context,
}) => {
  const dir = outDir('1f-wait');
  await installProbe(context);
  await routeEngineFaults(context, (generation) => (generation === 0 ? { hangFinalizing: true } : {}));
  let dump: ProbeDump | null = null;
  try {
    await openClip(page, repoVideo(CLIP));
    const finalizing = await waitForLog(
      page,
      (e) => e.gen === 0 && e.k === 'progress' && e.stage === 'finalizing',
      120_000,
      'the finalizing stage',
    );
    await page.waitForTimeout(20_000);
    await page.screenshot({ path: join(dir, '1-finalizing-hangs-20s.png') });
    const pillWhileHanging = (await page.getByTestId('processing-pill').textContent()) ?? '';

    const alert = page.getByRole('alert');
    await alert.waitFor({ state: 'visible', timeout: ceilingMs + 30_000 });
    const errorAfterMs = (await pageNow(page)) - finalizing.t;
    await page.screenshot({ path: join(dir, '2-error-screen.png') });
    const title = (await alert.innerText()).trim();
    const bodyBefore = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const buttons = await page.locator('main button').allInnerTexts();
    await page.locator('summary').click();
    const details = (await page.locator('details').innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: join(dir, '3-error-screen-details.png') });

    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 5000 });
    const pickedT = await pageNow(page);
    await page.getByTestId('file-input').setInputFiles(repoVideo(NEXT));
    await waitComplete(page, 240_000);
    const nextWallMs = (await pageNow(page)) - pickedT;
    await page.screenshot({ path: join(dir, '4-next-clip-done.png') });
    const players = (await playerRows(page)).length;
    const result = completeness(readPoseTrack(await exportFile(page, 'json', dir)));
    dump = await dumpProbe(page);
    const report = {
      ceilingMs: Math.round(ceilingMs),
      errorAfterMs,
      pillWhileHanging,
      title,
      bodyBefore,
      buttons,
      details,
      clientEvents: dump.log.filter((e) => e.k === 'spawn' || e.k === 'error' || e.k === 'worker-error'),
      next: { nextWallMs, players, result },
    };
    saveJson(dir, 'report.json', report);
    console.log(`finalize hang, waited: ${JSON.stringify(report)}`);

    expect(errorAfterMs, 'the error comes at the ceiling, not before').toBeGreaterThan(ceilingMs - 3000);
    expect(errorAfterMs, 'the error comes at the ceiling, not long after').toBeLessThan(ceilingMs + 15_000);
    expect(details, 'the plain reason is on the error screen').toContain('Finishing the analysis took too long.');
    expect(`${title} ${bodyBefore} ${details}`, 'no runtime text on the error screen').not.toMatch(
      /OrtRun|WGSL|shader|TypeError|undefined|\bat \w+ \(/i,
    );
    expect(buttons, 'a way on from the error screen').toContain('Start over');
    expect(result.frames, 'frames of the next clip').toBe(nextFrames);
    expect(result.processed, 'processed frames of the next clip').toBe(nextFrames);
    expect(result.partial, 'the next clip is a full result').toBe(false);
    expect(players, 'players found in the next clip').toBeGreaterThan(0);
  } finally {
    dump ??= await dumpProbe(page).catch(() => null);
    if (dump) saveJson(dir, 'probe.json', dump);
  }
});

test('Discard during a hang in finalizing: the next clip opens once the ceiling has ended the stuck run', async ({
  page,
  context,
}) => {
  const dir = outDir('1f-discard');
  await installProbe(context);
  await routeEngineFaults(context, (generation) => (generation === 0 ? { hangFinalizing: true } : {}));
  let dump: ProbeDump | null = null;
  try {
    await openClip(page, repoVideo(CLIP));
    const finalizing = await waitForLog(
      page,
      (e) => e.gen === 0 && e.k === 'progress' && e.stage === 'finalizing',
      120_000,
      'the finalizing stage',
    );
    // a user who sees the pill stand still at the end gives up after a while
    await page.waitForTimeout(10_000);
    await page.getByTestId('processing-pill').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 5000 });
    const pickedT = await pageNow(page);
    await page.getByTestId('file-input').setInputFiles(repoVideo(NEXT));
    await page.waitForTimeout(5000);
    await page.screenshot({ path: join(dir, '1-next-clip-picked-5s.png') });
    const screenWhileWaiting = (await page.locator('main').first().innerText()).replace(/\s+/g, ' ').slice(0, 300);
    await waitComplete(page, ceilingMs + 240_000);
    const doneT = await pageNow(page);
    await page.screenshot({ path: join(dir, '2-next-clip-done.png') });
    const players = (await playerRows(page)).length;
    const result = completeness(readPoseTrack(await exportFile(page, 'json', dir)));
    dump = await dumpProbe(page);
    const firstProgress = dump.log.find((e) => e.k === 'progress' && e.of === nextFrames)?.t ?? Number.NaN;
    const report = {
      ceilingMs: Math.round(ceilingMs),
      pickedAfterFinalizingMs: pickedT - finalizing.t,
      waitedBeforeAnalysisMs: firstProgress - pickedT,
      analysisStartedAfterFinalizingMs: firstProgress - finalizing.t,
      totalAfterPickMs: doneT - pickedT,
      screenWhileWaiting,
      problemScreens: [...new Set(dump.samples.filter((s) => s.alert !== '').map((s) => s.alert))],
      clientEvents: dump.log.filter((e) => e.k === 'spawn' || e.k === 'error' || e.k === 'worker-error'),
      next: { players, result },
    };
    saveJson(dir, 'report.json', report);
    console.log(`finalize hang, discarded: ${JSON.stringify(report)}`);

    expect(report.analysisStartedAfterFinalizingMs, 'the stuck run is ended at the ceiling').toBeLessThan(
      ceilingMs + 20_000,
    );
    expect(report.problemScreens, 'error screens').toEqual([]);
    expect(result.frames, 'frames of the next clip').toBe(nextFrames);
    expect(result.processed, 'processed frames of the next clip').toBe(nextFrames);
    expect(result.partial, 'the next clip is a full result').toBe(false);
    expect(players, 'players found in the next clip').toBeGreaterThan(0);
  } finally {
    dump ??= await dumpProbe(page).catch(() => null);
    if (dump) saveJson(dir, 'probe.json', dump);
  }
});
