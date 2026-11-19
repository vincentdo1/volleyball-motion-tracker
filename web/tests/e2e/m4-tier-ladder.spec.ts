import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  dumpProbe,
  installProbe,
  type LogEntry,
  openClip,
  outDir,
  routeEngineFaults,
  routeInferenceFailure,
  saveJson,
} from './m4-support';
import { isPreview, repoVideo } from './support';

/**
 * M4-B2a item 2g (review finding #2): "Try a lighter mode" must step down from the tier the engine really runs on, and
 * on the lightest tier the Problem screen offers "Reload the page" with the browser hint instead. The failures are the
 * pipeline's own InferenceError thrown from the built ML chunk (see `routeInferenceFailure`): generation 0 (webgpu-default)
 * fails, the engine falls back to wasm-mt by itself (generation 1); that tier fails too and the Problem screen shows.
 *   PORT=5184 E2E_TARGET=preview caffeinate -i -s npx playwright test m4-tier-ladder
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.setTimeout(600_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';

const readyTiers = (log: LogEntry[]): string[] =>
  log.filter((e) => e.k === 'ready').map((e) => `gen ${e.gen}: ${e.tier}/${String(e.backend)}`);
const initTiers = (log: LogEntry[]): string[] =>
  log.filter((e) => e.k === 'command' && e.type === 'init').map((e) => `gen ${e.gen}: ${String(e.tierOverride)}`);

test('Try a lighter mode steps down from the tier the engine really ran on; wasm-st offers Reload with the hint', async ({
  page,
  context,
}) => {
  const dir = outDir('2g-ladder');
  await installProbe(context);
  const faults = await routeEngineFaults(context, (generation) =>
    generation === 0 ? { failAtCall: 8 } : { failAtCall: 8, failRepeat: true },
  );
  await routeInferenceFailure(context, faults);
  const steps: Record<string, unknown>[] = [];
  const problem = async (label: string): Promise<Record<string, unknown>> => {
    const alert = page.getByRole('alert');
    await alert.waitFor({ state: 'visible', timeout: 300_000 });
    await page.screenshot({ path: join(dir, `${label}.png`) });
    const buttons = await page.locator('main button').allInnerTexts();
    const hint = await page.getByTestId('browser-hint').allInnerTexts();
    const title = (await alert.innerText()).trim();
    const state = { label, title, buttons, hint, log: await dumpProbe(page).then((d) => d.log) };
    steps.push({
      label,
      title,
      buttons,
      hint,
      ready: readyTiers(state.log),
      init: initTiers(state.log),
    });
    return state;
  };

  try {
    await openClip(page, repoVideo(CLIP));
    // 1. webgpu-default fails -> automatic fallback to wasm-mt -> fails too -> Problem screen
    const first = await problem('1-problem-after-wasm-mt');
    const log1 = first.log as LogEntry[];
    const buttons1 = first.buttons as string[];
    expect(faults.entries.join(' | '), 'the ML patch applied').toContain('ml patch applied');

    // 2. "Try a lighter mode": must go to wasm-st (one step below wasm-mt), not webgpu-lite (below webgpu-default)
    const lighter = page.getByRole('button', { name: 'Try a lighter mode' });
    const offered1 = await lighter.isVisible();
    if (offered1) {
      await lighter.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(dir, '2-after-lighter-mode.png') });
      const mid = await dumpProbe(page);
      steps.push({ label: 'after first lighter-mode press', init: initTiers(mid.log), ready: readyTiers(mid.log) });
      // the clip may have to be picked again (the machine returns to booting, then landing)
      const input = page.getByTestId('file-input');
      if ((await input.count()) > 0 && (await page.getByRole('alert').count()) === 0) {
        await input.setInputFiles(repoVideo(CLIP));
      }
    }
    const second = await problem('3-problem-on-wasm-st');
    const log2 = second.log as LogEntry[];
    const buttons2 = second.buttons as string[];
    const hint2 = second.hint as string[];
    const dump = await dumpProbe(page);
    saveJson(dir, 'report.json', { steps, faults: faults.entries, offered1 });
    saveJson(dir, 'probe.json', dump);
    console.log(`tier ladder: ${JSON.stringify({ steps, faults: faults.entries })}`);

    const inits = log2.filter((e) => e.k === 'command' && e.type === 'init').map((e) => e.tierOverride);
    expect(buttons1, 'first Problem screen').toContain('Try a lighter mode');
    expect(readyTiers(log1).join(' '), 'the engine really ran on wasm-mt before the first Problem screen').toContain(
      'wasm-mt',
    );
    expect(inits, 'the init after "Try a lighter mode" asks for wasm-st').toContain('wasm-st');
    expect(inits, 'never webgpu-lite: that is below the tier the app guessed, not the one it ran on').not.toContain(
      'webgpu-lite',
    );
    expect(buttons2, 'lightest tier: no further step down').not.toContain('Try a lighter mode');
    expect(buttons2, 'lightest tier: reload offered').toContain('Reload the page');
    expect(hint2.join(' '), 'browser hint').toContain('Try a recent version of Chrome or Edge');
  } finally {
    const dump = await dumpProbe(page).catch(() => null);
    if (dump) saveJson(dir, 'probe.json', dump);
  }
});
