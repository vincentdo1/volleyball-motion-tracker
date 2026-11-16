import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import {
  type Completeness,
  clickWhen,
  completeness,
  dumpProbe,
  installProbe,
  type LogEntry,
  laneProbe,
  openClip,
  outDir,
  type ProbeDump,
  pageNow,
  pillPercent,
  playerRows,
  readPoseTrack,
  routeEngineFaults,
  saveJson,
  type Trigger,
  waitComplete,
  waitForLog,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B item 1e (review findings #7 / #21 / #22): the user cancels while the engine recovers from a stall, on the real
 * engine and the production build. The worker thread of generation 0 is blocked at frame 520 of the 33 s clip (see
 * `routeEngineFaults`); the client notices after 12 s of silence, replaces the worker and resumes the run. Cancel is
 * pressed at one of three moments of that recovery, with Discard and with Keep, and then another clip is opened.
 *   PORT=5184 E2E_TARGET=preview npx playwright test m4-cancel-recovery
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(600_000);

const GTU = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const NEXT = 'volleyball_spike_attempt_04.mp4';
const gtuFrames = clipGolden(GTU).video.presentableFrames;
const nextFrames = clipGolden(NEXT).video.presentableFrames;
const STALL = 520;
/** Page time after the stall by which the client has noticed it (12 s) and a recovery has had time to restart a run. */
const SETTLED_AFTER_STALL_MS = 24_000;
/** A cancel needs a moment to reach a worker that has just started a run. */
const GRACE_MS = 1500;

/** The moment of the recovery at which the choice in the "Stop the analysis?" dialog is pressed. */
type When = 'silence' | 'respawn' | 'restarted' | 'behind';
/** Frames the resumed run has reached when Keep is pressed "behind": it resumed at 300 and the view holds about 505. */
const BEHIND_FRAMES = 400;
const TRIGGERS: Readonly<Record<When, Trigger>> = {
  // the worker is blocked and the client has not noticed yet: what a user who sees the pill stand still would do
  silence: { at: 'now' },
  // the client has just replaced the worker and is initialising the new one
  respawn: { at: 'log', k: 'spawn', gen: 1 },
  // the new worker has just been told to start the run again
  restarted: { at: 'log', k: 'state', gen: 1, state: 'processing' },
  // the resumed run is under way but still re-analysing frames the view already shows (the pill has not moved yet)
  behind: { at: 'log', k: 'progress', gen: 1, minFrames: BEHIND_FRAMES },
};

interface Cancelled {
  readonly dir: string;
  readonly stall: LogEntry;
  /** Page time of the press on Discard or Keep. */
  readonly clickT: number;
  readonly percentAtClick: number | null;
}

/** Runs the 33 s clip into the stall, opens the cancel dialog during the silence and presses `choice` at `when`. */
async function cancelDuringRecovery(
  page: Page,
  context: BrowserContext,
  when: When,
  choice: 'discard' | 'keep',
): Promise<Cancelled> {
  const dir = outDir(`1e-${choice}-${when}`);
  await installProbe(context);
  await routeEngineFaults(context, (generation) => (generation === 0 ? { stallAtFrames: STALL } : {}));
  await openClip(page, repoVideo(GTU));
  const stall = await waitForLog(
    page,
    (e) => e.gen === 0 && e.k === 'progress' && (e.frames as number) >= STALL,
    120_000,
    'the stall',
  );
  await page.waitForTimeout(3000);
  await page.getByTestId('processing-pill').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).waitFor({ state: 'visible' });
  const percentAtClick = await pillPercent(page);
  await page.screenshot({ path: join(dir, '1-dialog-during-the-silence.png') });
  const clickT = await clickWhen(page, choice === 'discard' ? '^Discard$' : '^Keep \\d+% analysed$', TRIGGERS[when]);
  return { dir, stall, clickT, percentAtClick };
}

interface Aftermath {
  /** Progress reports for the 33 s clip that arrived later than the grace after the press. */
  readonly oldProgressLate: number;
  /** Runs of the 33 s clip announced after the press, and the engine state that followed each. */
  readonly oldRunsAfter: string[];
  /** Results of the 33 s clip delivered after the press (`partial` is "null" for a full one). */
  readonly oldFinalsAfter: string[];
  readonly problemScreens: string[];
  readonly failedReplies: string[];
  readonly errors: string[];
  readonly generations: number;
  readonly lastOpenedFrames: unknown;
}

/** What the engine did after the press at `clickT`, up to page time `until`. */
function aftermath(dump: ProbeDump, clickT: number, until: number): Aftermath {
  const log = dump.log.filter((e) => e.t <= until);
  const clipOf = (entry: LogEntry): unknown =>
    log.filter((e) => e.k === 'opened' && e.gen === entry.gen && e.t <= entry.t).at(-1)?.frames;
  const after = log.filter((e) => e.t > clickT);
  return {
    oldProgressLate: after.filter((e) => e.k === 'progress' && e.of === gtuFrames && e.t > clickT + GRACE_MS).length,
    oldRunsAfter: after
      .filter((e) => e.k === 'run-started' && clipOf(e) === gtuFrames)
      .map((e) => {
        const next = log.find((s) => s.k === 'state' && s.gen === e.gen && s.t >= e.t && s.state !== 'processing');
        return `gen ${e.gen} at +${e.t - clickT} ms, then ${next ? `${next.state} at +${next.t - clickT} ms` : 'still processing'}`;
      }),
    oldFinalsAfter: after.filter((e) => e.k === 'final' && clipOf(e) === gtuFrames).map((e) => String(e.partial)),
    problemScreens: [...new Set(dump.samples.filter((s) => s.t <= until && s.alert !== '').map((s) => s.alert))],
    failedReplies: after.filter((e) => e.k === 'reply' && e.ok !== true).map((e) => `gen ${e.gen} ${e.code}`),
    errors: after.filter((e) => e.k === 'error').map((e) => `gen ${e.gen} ${e.code}: ${e.message}`),
    generations: log.filter((e) => e.k === 'spawn').length,
    lastOpenedFrames: log.filter((e) => e.k === 'opened').at(-1)?.frames,
  };
}

interface NextClip {
  readonly pickedT: number;
  readonly wallMs: number;
  readonly players: number;
  readonly result: Completeness;
}

/** Opens the 6 s clip from the landing screen and waits for its results. */
async function analyseNextClip(page: Page, dir: string): Promise<NextClip> {
  const pickedT = await pageNow(page);
  await page.getByTestId('file-input').setInputFiles(repoVideo(NEXT));
  // what the user looks at while the engine gets ready for the new clip
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(dir, '8-next-clip-2s-after-pick.png') });
  await waitComplete(page, 240_000);
  const wallMs = (await pageNow(page)) - pickedT;
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, '9-next-clip-done.png') });
  const players = (await playerRows(page)).length;
  const result = completeness(readPoseTrack(await exportFile(page, 'json', dir)));
  return { pickedT, wallMs, players, result };
}

function expectNextClipComplete(next: NextClip): void {
  expect(next.result.frames, 'frames of the next clip').toBe(nextFrames);
  expect(next.result.processed, 'processed frames of the next clip').toBe(nextFrames);
  expect(next.result.partial, 'the next clip is a full result').toBe(false);
  expect(next.players, 'players found in the next clip').toBeGreaterThan(0);
}

interface KeptView {
  /** Percent the header cue states once the view has settled. */
  readonly cuePercent: number;
  /** Share of the timeline up to which any player lane has a bar, in percent. */
  readonly lanesPercent: number;
  /** Share of the clip the engine's partial result says it analysed, in percent; null when it delivered none. */
  readonly resultPercent: number | null;
}

/** What the kept view claims (the cue) against what it holds (the lanes, the engine's partial result). */
async function keptView(page: Page, seen: Aftermath): Promise<KeptView> {
  const cue = (await page.getByTestId('partial-cue').textContent()) ?? '';
  const lanes = await laneProbe(page);
  const partial = seen.oldFinalsAfter
    .map((text) => JSON.parse(text) as { analysedFrames: number; plannedFrames: number } | null)
    .find((value) => value !== null);
  return {
    cuePercent: Number(/(\d+)%/.exec(cue)?.[1] ?? Number.NaN),
    lanesPercent: Math.round((lanes?.lastBar ?? 0) * 100),
    resultPercent: partial ? Math.round((partial.analysedFrames / partial.plannedFrames) * 100) : null,
  };
}

async function waitUntilPageTime(page: Page, t: number): Promise<void> {
  const left = t - (await pageNow(page));
  if (left > 0) await page.waitForTimeout(left);
}

for (const when of ['silence', 'respawn', 'restarted'] as const) {
  test(`Discard pressed at "${when}" of a stall recovery: nothing restarts and the next clip reaches results`, async ({
    page,
    context,
  }) => {
    const { dir, stall, clickT } = await cancelDuringRecovery(page, context, when, 'discard');
    let dump: ProbeDump | null = null;
    try {
      await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 5000 });
      const landingMs = (await pageNow(page)) - clickT;
      await page.screenshot({ path: join(dir, '2-after-discard.png') });
      // pressed during the silence: pick the next clip at once, while the old worker is still blocked.
      // Otherwise watch the idle engine until a recovery would long have restarted the run.
      if (when === 'silence') await page.waitForTimeout(300);
      else await waitUntilPageTime(page, stall.t + SETTLED_AFTER_STALL_MS);
      const idle = aftermath(await dumpProbe(page), clickT, await pageNow(page));
      const next = await analyseNextClip(page, dir);
      dump = await dumpProbe(page);
      const after = aftermath(dump, clickT, dump.now);
      const firstProgress = dump.log.find((e) => e.k === 'progress' && e.of === nextFrames)?.t ?? Number.NaN;
      const report = {
        when,
        landingMs,
        clickAfterStallMs: clickT - stall.t,
        idle,
        after,
        next: { ...next, firstProgressAfterPickMs: firstProgress - next.pickedT },
      };
      saveJson(dir, 'report.json', report);
      console.log(`discard/${when}: ${JSON.stringify(report)}`);

      expect(landingMs, 'the landing screen shows at once').toBeLessThan(1000);
      expect(after.oldProgressLate, 'progress of the discarded run after the cancel').toBe(0);
      expect(after.oldFinalsAfter, 'results of the discarded run after the cancel').toEqual([]);
      for (const restarted of after.oldRunsAfter) {
        // a run the recovery had already restarted must be stopped at once
        expect(restarted, 'a restarted run of the discarded clip').toMatch(/then opened at \+\d{1,4} ms$/);
      }
      expect(after.problemScreens, 'error screens').toEqual([]);
      expect(after.lastOpenedFrames, 'the clip the engine holds at the end').toBe(nextFrames);
      expectNextClipComplete(next);
    } finally {
      dump ??= await dumpProbe(page).catch(() => null);
      if (dump) saveJson(dir, 'probe.json', dump);
    }
  });
}

for (const when of ['silence', 'respawn', 'restarted'] as const) {
  test(`Keep pressed at "${when}" of a stall recovery: the kept view stays, nothing restarts, the next clip reaches results`, async ({
    page,
    context,
  }) => {
    const { dir, stall, clickT, percentAtClick } = await cancelDuringRecovery(page, context, when, 'keep');
    let dump: ProbeDump | null = null;
    try {
      const cue = page.getByTestId('partial-cue');
      await cue.waitFor({ state: 'visible', timeout: 5000 });
      const cueText = (await cue.textContent()) ?? '';
      const playersAtKeep = (await playerRows(page)).length;
      await page.screenshot({ path: join(dir, '2-after-keep.png') });
      // right after Keep the exports wait for the engine's partial result (until the recovery has ended)
      await page.getByRole('button', { name: 'Export', exact: true }).first().click();
      const earlyButton = page.getByRole('button', { name: 'Export Tracking data' });
      await earlyButton.waitFor({ state: 'visible' });
      const sheetTextEarly = (await page.locator('ul').filter({ has: earlyButton }).innerText()).replace(/\s+/g, ' ');
      const sheetEarlyAfterMs = (await pageNow(page)) - clickT;
      await page.keyboard.press('Escape');
      await earlyButton.waitFor({ state: 'hidden' });
      await waitUntilPageTime(page, stall.t + SETTLED_AFTER_STALL_MS);
      const playersLater = (await playerRows(page)).length;
      const idle = aftermath(await dumpProbe(page), clickT, await pageNow(page));
      await page.screenshot({ path: join(dir, '3-kept-view-later.png') });
      const kept = await keptView(page, idle);

      // exports of the kept view
      await page.getByRole('button', { name: 'Export', exact: true }).first().click();
      const jsonButton = page.getByRole('button', { name: 'Export Tracking data' });
      await jsonButton.waitFor({ state: 'visible' });
      const sheet = page.locator('ul').filter({ has: jsonButton });
      const sheetText = (await sheet.innerText()).replace(/\s+/g, ' ');
      const jsonEnabled = await jsonButton.isEnabled();
      let jsonOutcome = 'the button is disabled';
      if (jsonEnabled) {
        const download = page
          .waitForEvent('download', { timeout: 20_000 })
          .then((d) => `downloaded ${d.suggestedFilename()}`)
          .catch(() => null);
        const alert = sheet.getByRole('alert').first();
        const failure = alert
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(async () => `error shown: ${await alert.innerText()}`)
          .catch(() => null);
        await jsonButton.click();
        jsonOutcome = (await Promise.race([download, failure])) ?? 'neither a file nor an error within 20 s';
      }
      await page.screenshot({ path: join(dir, '4-export-sheet.png') });
      const png = await exportFile(page, 'png', dir)
        .then((file) => `downloaded ${file.split('/').at(-1)}`)
        .catch((error: unknown) => `failed: ${String(error).slice(0, 120)}`);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'New clip' }).click();
      await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 5000 });
      const next = await analyseNextClip(page, dir);
      dump = await dumpProbe(page);
      const after = aftermath(dump, clickT, dump.now);
      const report = {
        when,
        clickAfterStallMs: clickT - stall.t,
        percentAtClick,
        cueText,
        playersAtKeep,
        playersLater,
        kept,
        sheetEarlyAfterMs,
        sheetTextEarly,
        sheetText,
        jsonOutcome,
        png,
        idle,
        after,
        next,
      };
      saveJson(dir, 'report.json', report);
      console.log(`keep/${when}: ${JSON.stringify(report)}`);

      expect(cueText, 'the header marks the view as partial').toMatch(/^Partial: only \d+% analysed$/);
      expect(Number(/(\d+)%/.exec(cueText)?.[1]), 'percent in the partial cue').toBeGreaterThanOrEqual(
        (percentAtClick ?? 0) - 2,
      );
      expect(playersAtKeep, 'players of the kept view').toBeGreaterThan(0);
      // M4-3 as fixed in bccc461: once the engine's partial result has replaced the view, the cue gives the share that
      // result covers, not the share that had been streamed
      if (kept.resultPercent !== null) {
        expect(kept.cuePercent, 'the cue equals the share the kept result covers').toBeGreaterThanOrEqual(
          kept.resultPercent - 2,
        );
        expect(kept.cuePercent, 'the cue equals the share the kept result covers').toBeLessThanOrEqual(
          kept.resultPercent + 2,
        );
      }
      expect(idle.oldProgressLate, 'progress of the kept run after the cancel').toBe(0);
      // a full result would mean the run went on in the background and replaced the kept view
      expect(
        after.oldFinalsAfter.filter((partial) => partial === 'null'),
        'full results of the kept run',
      ).toEqual([]);
      for (const restarted of after.oldRunsAfter) {
        expect(restarted, 'a restarted run of the kept clip').toMatch(/then opened at \+\d{1,4} ms$/);
      }
      expect(sheetText, 'the export rows no longer wait for the partial result').not.toContain(
        'Preparing what was analysed',
      );
      // known and accepted: with no run to finalize the exports fail with a plain error; a hang or runtime text is not
      expect(jsonOutcome, 'the tracking-data export ends in a file or a plain error').toMatch(
        /^(downloaded|error shown)/,
      );
      expect(jsonOutcome, 'no runtime text in the export error').not.toMatch(
        /OrtRun|WGSL|shader|TypeError|undefined|\bat \w+ \(/i,
      );
      expect(png, 'the frame PNG of the kept view').toMatch(/^downloaded .+\.png$/);
      expect(after.problemScreens, 'error screens').toEqual([]);
      expectNextClipComplete(next);
    } finally {
      dump ??= await dumpProbe(page).catch(() => null);
      if (dump) saveJson(dir, 'probe.json', dump);
    }
  });
}
