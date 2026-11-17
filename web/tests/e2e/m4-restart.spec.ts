import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { clipGolden } from '../fixtures/clips.ts';
import {
  completeness,
  dataNotes,
  dumpProbe,
  focusPlayer,
  type GenerationPlan,
  hidePlayer,
  installProbe,
  type LogEntry,
  openClip,
  outDir,
  overlayPainted,
  type ProbeDump,
  pillPercent,
  playerRows,
  readPoseTrack,
  routeEngineFaults,
  routeInferenceFailure,
  type Sample,
  saveJson,
  seekToFrame,
  selectTab,
  waitComplete,
  waitForLog,
  waitPercent,
} from './m4-support';
import { exportFile, isPreview, repoVideo } from './support';

/**
 * M4-B item 1a (review findings #6 / #26): the engine restarts a run while the UI is showing it, on the real engine
 * and the production build. A stall is a blocked worker thread (see `routeEngineFaults`): the first one of a run
 * restarts the worker on the same tier and the run resumes from its stored 10 s chunks; a second one, or a failed
 * inference on WebGPU, steps a tier down and the analysis starts again from the first frame.
 *   PORT=5184 E2E_TARGET=preview npx playwright test m4-restart
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.setTimeout(900_000);

const GTU = 'github_gtu_20250316_002_volleyball_tracking.mp4';
const golden = clipGolden(GTU).video;
/** The first stall: past the first 10 s chunk (300 frames), so the restarted run has something to resume from. */
const FIRST_STALL = 520;
const SECOND_STALL = 700;
/** A stall inside the first 10 s of the clip: no chunk is stored yet. */
const EARLY_STALL = 180;

interface Scenario {
  readonly name: string;
  readonly plan: (generation: number) => GenerationPlan;
  readonly injectInferenceFailure?: boolean;
  /** Engine worker generation whose run is the one that finishes. */
  readonly lastGeneration: number;
  /** Pill percent at which a player is put in focus and another one hidden (default 25). */
  readonly pickAtPercent?: number;
  /** A frame only the replaced run had analysed, probed right after a fresh restart (default: 60 before the stall). */
  readonly beyondFrame?: number;
}

interface Outcome {
  readonly dir: string;
  readonly dump: ProbeDump;
  readonly faults: string[];
  /** The screen just before the client replaced the first worker. */
  readonly before: Sample;
  /** The screen just before the run of the last generation started. */
  readonly beforeRestart: Sample;
  /** `run-started` of the generation that finished. */
  readonly restarted: LogEntry;
  /** Notes listed in the clip's Data panel at the end. */
  readonly notes: string[];
  /** Painted overlay pixels at a frame only the replaced run had reached, and at one the new run has. */
  readonly overlay: { beyond: number; within: number; beyondFrame: number; pctThen: number | null } | null;
  readonly result: ReturnType<typeof completeness>;
  readonly playersAtEnd: number;
  readonly focusAtEnd: string;
}

async function run(page: Page, context: BrowserContext, scenario: Scenario, probeOverlay: boolean): Promise<Outcome> {
  const dir = outDir(`1a-${scenario.name}`);
  await installProbe(context);
  const faults = await routeEngineFaults(context, scenario.plan);
  if (scenario.injectInferenceFailure) await routeInferenceFailure(context, faults);
  const consoleLines: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('__m4')) consoleLines.push(message.text());
  });
  page.on('worker', (worker) => {
    worker.on('console', (message) => {
      if (message.text().includes('__m4')) consoleLines.push(message.text());
    });
  });
  let dump: ProbeDump | null = null;
  try {
    await openClip(page, repoVideo(GTU));
    await waitPercent(page, scenario.pickAtPercent ?? 25);
    const rows = await playerRows(page);
    const focusLabel = rows[0]?.label ?? '';
    const hideLabel = rows[2]?.label ?? '';
    await focusPlayer(page, focusLabel);
    await hidePlayer(page, hideLabel);
    await page.screenshot({ path: join(dir, '1-picked.png') });

    // the first fault: the worker goes quiet after the progress report that triggers the stall, or it reports the
    // failed inference (frames are in flight, so its last progress report is a few frames short of the failing call)
    const stallAt = scenario.plan(0).stallAtFrames;
    await waitForLog(
      page,
      (e) =>
        e.gen === 0 &&
        (e.k === 'error' || (stallAt !== undefined && e.k === 'progress' && (e.frames as number) >= stallAt)),
      120_000,
      'the first fault',
    );
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(dir, '2-fault.png') });

    const restarted = await waitForLog(
      page,
      (e) => e.gen === scenario.lastGeneration && e.k === 'run-started',
      240_000,
      `run-started of generation ${scenario.lastGeneration}`,
    );
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(dir, '3-restarted.png') });

    let overlay: Outcome['overlay'] = null;
    if (probeOverlay) {
      // a frame only the replaced run had analysed: the new run has not reached it, so nothing may be drawn there
      const beyondFrame = scenario.beyondFrame ?? FIRST_STALL - 60;
      await seekToFrame(page, beyondFrame);
      const pctThen = await pillPercent(page);
      const beyond = await overlayPainted(page);
      await page.screenshot({ path: join(dir, '4-frame-beyond-new-run.png') });
      // the first half second of the new run has to arrive before its first frames can show (slow on the CPU tier)
      await waitPercent(page, 2, 120_000);
      await seekToFrame(page, 3);
      const within = await overlayPainted(page);
      await page.screenshot({ path: join(dir, '5-frame-within-new-run.png') });
      overlay = { beyond, within, beyondFrame, pctThen };
    }

    await waitComplete(page, 600_000);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(dir, '6-done.png') });
    const endRows = await playerRows(page);
    await selectTab(page, 'Data');
    const notes = await dataNotes(page);
    await page.screenshot({ path: join(dir, '7-data-panel.png') });
    await selectTab(page, 'Players');
    const json = await exportFile(page, 'json', dir);
    const result = completeness(readPoseTrack(json));
    dump = await dumpProbe(page);
    const firstRespawn = dump.log.find((e) => e.k === 'spawn' && e.gen === 1)?.t ?? 0;
    return {
      dir,
      dump,
      faults: faults.entries,
      before: lastSampleBefore(dump, firstRespawn),
      beforeRestart: lastSampleBefore(dump, restarted.t),
      restarted,
      notes,
      overlay,
      result,
      playersAtEnd: endRows.length,
      focusAtEnd: endRows
        .filter((r) => r.focused)
        .map((r) => r.label)
        .join(','),
    };
  } finally {
    dump ??= await dumpProbe(page).catch(() => null);
    if (dump) {
      saveJson(dir, 'probe.json', dump);
      saveJson(dir, 'summary.json', summarise(dump, faults.entries, consoleLines));
    }
  }
}

/** The last screen sample taken before page time `t` while the analysis was showing. */
function lastSampleBefore(dump: ProbeDump, t: number): Sample {
  const sample = dump.samples.filter((s) => s.t < t && s.pct !== null).at(-1);
  if (!sample) throw new Error(`no screen sample before ${t} ms`);
  return sample;
}

/** What the page asked of one worker generation at start-up, and what that worker answered. */
function generationTier(dump: ProbeDump, generation: number): { asked: unknown; ready: unknown } {
  return {
    asked: dump.log.find((e) => e.gen === generation && e.k === 'command' && e.type === 'init')?.tierOverride,
    ready: dump.log.find((e) => e.gen === generation && e.k === 'ready')?.tier,
  };
}

/** The run in a few lines: what the engine announced and how the pill moved. */
function summarise(dump: ProbeDump, faults: string[], consoleLines: string[]) {
  const interesting = dump.log.filter((e) =>
    ['spawn', 'command', 'state', 'warning', 'error', 'run-started', 'ready', 'final', 'worker-error'].includes(e.k),
  );
  const pill = dump.samples.filter((s) => s.pct !== null).map((s) => [s.t, s.pct]);
  return {
    faults,
    consoleLines,
    events: interesting,
    pill,
    screen: dump.samples.map((s) => ({ ...s })),
    longestTaskMs: Math.max(0, ...dump.longTasks.map((l) => l.ms)),
    longestFrameGapMs: Math.max(0, ...dump.frameGaps.map((l) => l.ms)),
  };
}

function expectCompleteResult(outcome: Outcome, tier: string): void {
  expect(outcome.result.frames, 'frames in the final result').toBe(golden.presentableFrames);
  expect(outcome.result.processed, 'frames flagged processed').toBe(golden.presentableFrames);
  expect(outcome.result.skipped, 'frames flagged skipped').toBe(0);
  expect(outcome.result.partial, 'the result is not marked partial').toBe(false);
  expect(outcome.result.longestEmptyFrames, 'longest stretch without any player (frames)').toBeLessThan(15);
  expect(outcome.result.tier, 'tier the result was made on').toBe(tier);
  expect(outcome.playersAtEnd, 'players listed at the end').toBeGreaterThan(20);
}

test('a stalled worker restarts on the same tier: the view keeps what it had and the run finishes complete', async ({
  page,
  context,
}) => {
  const outcome = await run(
    page,
    context,
    { name: 'same-tier', plan: (gen) => (gen === 0 ? { stallAtFrames: FIRST_STALL } : {}), lastGeneration: 1 },
    false,
  );
  const { dump, before, restarted } = outcome;
  console.log(
    `same-tier: ${JSON.stringify({ before, restarted, tier: generationTier(dump, 1), notes: outcome.notes, result: outcome.result, focusAtEnd: outcome.focusAtEnd, faults: outcome.faults })}`,
  );
  expect(outcome.faults, 'engine worker generations').toHaveLength(2);
  expect(restarted.fresh, 'the restarted run continues the stream').toBe(false);
  expect(restarted.resumedFrames as number, 'frames resumed from the stored chunks').toBeGreaterThanOrEqual(300);
  // the recovery's notice is raised by the engine client on the page, so the toast is where it would show
  expect(generationTier(dump, 1), 'the restarted worker stays on the tier').toEqual({
    asked: 'webgpu-default',
    ready: 'webgpu-default',
  });
  expect(
    dump.samples.filter((s) => /(slower|lighter) mode|Analysis restarted/i.test(s.toast)),
    'no mode or restart toast (the run continues from its stored chunks)',
  ).toHaveLength(0);
  expect(
    outcome.notes.filter((n) => /slower|lighter|processor|graphics/i.test(n)),
    'no mode note',
  ).toHaveLength(0);
  expect(before.focus, 'a player was picked before the stall').not.toBe('');
  expect(before.hidden, 'a player was hidden before the stall').not.toBe('');

  // the pill never goes backwards, from the first percent to the end
  const pill = dump.samples.filter((s) => s.pct !== null);
  for (let i = 1; i < pill.length; i++) {
    expect(pill[i]?.pct, `pill at ${pill[i]?.t} ms after ${pill[i - 1]?.pct}%`).toBeGreaterThanOrEqual(
      pill[i - 1]?.pct ?? 0,
    );
  }
  // the view keeps its players and the picks while the worker restarts
  const during = dump.samples.filter((s) => s.t >= before.t && !s.done && s.pct !== null);
  expect(Math.min(...during.map((s) => s.players)), 'players listed during the restart').toBeGreaterThanOrEqual(
    before.players,
  );
  expect(new Set(during.map((s) => s.focus)), 'focus player during the restart').toEqual(new Set([before.focus]));
  expect(new Set(during.map((s) => s.hidden)), 'hidden player during the restart').toEqual(new Set([before.hidden]));
  // the lanes keep what was analysed: bars never retreat behind the pill and have no hole
  const lanes = dump.laneSamples.filter((l) => l.t >= before.t && l.pct !== null);
  for (const l of lanes) {
    expect(l.lastBar, `lane bars at ${l.t} ms (pill ${l.pct}%)`).toBeGreaterThan((l.pct as number) / 100 - 0.04);
    expect(l.maxGapFrames, `hole in the lanes at ${l.t} ms`).toBeLessThan(20);
  }
  expectCompleteResult(outcome, 'webgpu-default');
  expect(outcome.focusAtEnd, 'a player is still in focus after the final result').not.toBe('');
});

test('a second stall steps a tier down: the view starts again from 0 % and follows the new run', async ({
  page,
  context,
}) => {
  const outcome = await run(
    page,
    context,
    {
      name: 'step-down-stall',
      plan: (gen) => (gen === 0 ? { stallAtFrames: FIRST_STALL } : gen === 1 ? { stallAtFrames: SECOND_STALL } : {}),
      lastGeneration: 2,
    },
    true,
  );
  expectFreshRestart(outcome, { generations: 3, tier: 'webgpu-lite', notice: 'Switched to a lighter mode' });
  expectCompleteResult(outcome, 'webgpu-lite');
});

test('a failed inference on WebGPU steps down to the processor: the view starts again from 0 % and follows the new run', async ({
  page,
  context,
}) => {
  const outcome = await run(
    page,
    context,
    {
      name: 'step-down-inference',
      plan: (gen) => (gen === 0 ? { failAtCall: FIRST_STALL } : {}),
      injectInferenceFailure: true,
      lastGeneration: 1,
    },
    true,
  );
  expect(
    outcome.faults.some((f) => f.startsWith('ml patch applied')),
    `the ML chunk patch applied: ${outcome.faults}`,
  ).toBe(true);
  expect(
    outcome.dump.log.filter((e) => e.gen === 0 && e.k === 'error').map((e) => e.code),
    'the first worker reported the failed inference',
  ).toEqual(['inference-failed']);
  expectFreshRestart(outcome, { generations: 2, tier: 'wasm-mt', notice: 'Switched to a slower mode' });
  expectCompleteResult(outcome, 'wasm-mt');
});

/**
 * A stall before the first 10 s chunk is stored leaves the restarted worker nothing to resume from: the same tier
 * starts the clip again, so the engine announces a fresh stream although no tier changed (and no notice is due).
 */
test('a stall before the first stored chunk restarts on the same tier from 0 %: the view follows the new run', async ({
  page,
  context,
}) => {
  const outcome = await run(
    page,
    context,
    {
      name: 'same-tier-nothing-stored',
      plan: (gen) => (gen === 0 ? { stallAtFrames: EARLY_STALL } : {}),
      lastGeneration: 1,
      pickAtPercent: 8,
      beyondFrame: EARLY_STALL - 10,
    },
    true,
  );
  expectFreshRestart(outcome, { generations: 2, tier: 'webgpu-default', notice: 'Analysis restarted' });
  expectCompleteResult(outcome, 'webgpu-default');
});

interface FreshRestart {
  readonly generations: number;
  readonly tier: string;
  /**
   * Title of the toast the user sees: a tier step-down names the mode ('Switched to a lighter mode' for the step to
   * a lighter GPU mode after a stall, 'Switched to a slower mode' for the processor); a fresh restart on the same
   * tier with progress already shown says 'Analysis restarted' (M4-1 and M4-2 as fixed in bccc461).
   */
  readonly notice: 'Switched to a lighter mode' | 'Switched to a slower mode' | 'Analysis restarted';
}

function expectFreshRestart(outcome: Outcome, { generations, tier, notice }: FreshRestart): void {
  const { dump, beforeRestart, restarted, overlay } = outcome;
  const lastGeneration = generations - 1;
  console.log(
    `fresh restart on ${tier}: ${JSON.stringify({ before: outcome.before, beforeRestart, restarted, tier: generationTier(dump, lastGeneration), notes: outcome.notes, overlay, result: outcome.result, faults: outcome.faults })}`,
  );
  expect(
    outcome.faults.filter((f) => f.startsWith('entry')),
    'engine worker generations',
  ).toHaveLength(generations);
  expect(generationTier(dump, lastGeneration), 'tier of the last worker').toEqual({ asked: tier, ready: tier });
  expect(restarted.fresh, 'the restarted run starts a fresh stream').toBe(true);
  expect(restarted.resumedFrames, 'nothing is resumed').toBe(0);
  // the recovery's notice is raised by the engine client on the page: the toast and the Data panel show it
  const toasts = new Set(dump.samples.map((s) => s.toast).filter((t) => t !== ''));
  const titles = ['Switched to a lighter mode', 'Switched to a slower mode', 'Analysis restarted'];
  for (const title of titles) {
    expect(
      [...toasts].some((t) => t.includes(title)),
      `toast "${title}" shown: ${[...toasts].join(' | ')}`,
    ).toBe(title === notice);
  }
  const modeNote = notice !== 'Analysis restarted';
  expect(
    outcome.notes.filter((n) => /processor|slower|lighter/i.test(n)),
    `notes about a changed mode in the Data panel: ${outcome.notes}`,
  ).toHaveLength(modeNote ? 1 : 0);
  // a run that starts from the beginning drops the stale "Continuing from saved results." note (M4-1 follow-up)
  expect(
    outcome.notes.filter((n) => /Continuing from saved results/i.test(n)),
    `no stale resume note: ${outcome.notes}`,
  ).toHaveLength(0);
  expect(beforeRestart.focus, 'a player was picked on the replaced run').not.toBe('');
  expect(beforeRestart.hidden, 'a player was hidden on the replaced run').not.toBe('');

  // from the restart on: the pill starts again near 0 % and never goes backwards
  const after = dump.samples.filter((s) => s.t >= restarted.t && s.pct !== null);
  expect(after[0]?.pct ?? 100, 'first pill percent of the new run').toBeLessThanOrEqual(3);
  for (let i = 1; i < after.length; i++) {
    expect(after[i]?.pct, `pill at ${after[i]?.t} ms after ${after[i - 1]?.pct}%`).toBeGreaterThanOrEqual(
      after[i - 1]?.pct ?? 0,
    );
  }
  expect(after.at(-1)?.pct ?? 0, 'the pill is not frozen: it reaches the end').toBeGreaterThanOrEqual(97);
  // the picks made on the replaced run are dropped
  const sinceRestart = dump.samples.filter((s) => s.t >= restarted.t + 300);
  expect(new Set(sinceRestart.map((s) => s.focus)), 'focus after the fresh restart').toEqual(new Set(['']));
  expect(new Set(sinceRestart.map((s) => s.hidden)), 'hidden after the fresh restart').toEqual(new Set(['']));
  // lanes: nothing of the old run is left beyond what the new run has delivered, and no stretch is missing
  const lanes = dump.laneSamples.filter((l) => l.t >= restarted.t + 500 && l.pct !== null);
  expect(lanes.length, 'lane samples of the new run').toBeGreaterThan(10);
  for (const l of lanes) {
    expect(l.lastBar, `lane bars at ${l.t} ms (pill ${l.pct}%)`).toBeLessThan((l.pct as number) / 100 + 0.04);
    expect(l.maxGapFrames, `hole in the lanes at ${l.t} ms`).toBeLessThan(20);
  }
  const firstLanes = lanes[0];
  expect(firstLanes?.lanes ?? 999, 'lanes right after the restart (the old run had more)').toBeLessThan(
    beforeRestart.players,
  );
  // the overlay: empty at a frame only the old run had reached, drawn at a frame of the new run
  expect(overlay, 'overlay probe').not.toBeNull();
  expect(overlay?.pctThen ?? 100, 'the new run had not reached the probed frame').toBeLessThan(40);
  expect(overlay?.beyond, 'overlay pixels left over from the old run').toBe(0);
  expect(overlay?.within ?? 0, 'overlay pixels at a frame of the new run').toBeGreaterThan(200);
}
