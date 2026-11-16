import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { clipGoldens } from '../fixtures/clips.ts';
import { dataNotes, outDir, readPoseTrack, selectTab, waitComplete } from './m4-support';
import { exportFile, isPreview, processClip, repoVideo } from './support';

/**
 * Cross-browser end to end (M2-9 / M2-10): a short clip goes through the real UI and engine to "Analysis complete" in
 * WebKit (WebGPU or its fallback) and in headed Firefox (WebGPU fails on a WGSL pad shader, so the engine must step
 * down to the WASM tier with a calm notice and never show raw ONNX Runtime text). Production build only.
 *
 * Firefox part (M4-B2b item 2, review finding #27): the toast is the calm one (title "Switched to ..."), no raw
 * runtime text appears anywhere on screen (body text sampled every 250 ms during the run), the engine's own note is
 * listed in the clip's Data panel and is still there for a second clip, the exported JSON says the engine ended on
 * the wasm backend, and ms per frame is logged.
 *   E2E_TARGET=preview PORT=5184 npx playwright test -c tests/playwright.cross.config.ts cross-e2e
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block' });
test.setTimeout(420_000);

const CLIP = 'volleyball_spike_attempt_04.mp4';
const SECOND_CLIP = 'volleyball_spike_attempt_03.mp4';
const RAW = /OrtRun|Shader '|WGSL|failed to call|onnxruntime|ORT|\bwgpu\b|createComputePipeline|\bPad\b/i;

test('@cross a clip processes to done through the UI, no raw runtime text on screen', async ({ page }) => {
  const logs: string[] = [];
  page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 200)}`));
  // every toast and every piece of body text that mentions runtime internals, seen at any moment of the run
  await page.addInitScript(() => {
    const w = window as unknown as { __toasts: string[]; __bodyRaw: string[] };
    w.__toasts = [];
    w.__bodyRaw = [];
    const raw = /OrtRun|Shader '|WGSL|failed to call|onnxruntime|\bORT\b|createComputePipeline/i;
    setInterval(() => {
      for (const el of document.querySelectorAll('[data-sonner-toast]')) {
        const text = (el.textContent ?? '').trim();
        if (text && !w.__toasts.includes(text)) w.__toasts.push(text);
      }
      const body = document.body?.innerText ?? '';
      const m = raw.exec(body);
      if (m && w.__bodyRaw.length < 5) w.__bodyRaw.push(body.slice(Math.max(0, m.index - 60), m.index + 100));
    }, 250);
  });
  const project = test.info().project.name;
  const isFirefox = project.startsWith('firefox');
  const result = await processClip(page, repoVideo(CLIP), 400_000);
  const body = await page.locator('body').innerText();
  console.log(
    `${project}: ${JSON.stringify({ ...result, notice: /slower mode/i.test(body) })} pageerrors=${logs.length}`,
  );
  expect(result.players, 'players found').toBeGreaterThan(0);
  expect(body, 'raw ORT text must never reach the screen').not.toMatch(/OrtRun|Shader '|WGSL|failed to call/i);
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(
    page.getByText(String(clipGoldens.clips[`${CLIP}`]?.video.presentableFrames), { exact: true }).first(),
  ).toBeVisible();

  const seen = await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[]; __bodyRaw: string[] };
    return { toasts: w.__toasts, bodyRaw: w.__bodyRaw };
  });
  const notes = await dataNotes(page);
  const dir = outDir(`2-${project}`);
  await page.screenshot({ path: `${dir}/clip1-data-panel.png` });
  const json = await exportFile(page, 'json', dir);
  await page.keyboard.press('Escape');
  const track = readPoseTrack(json);
  const frames = track.frames.ptsUs.length;
  const msPerFrame = Math.round((track.processing.elapsedMs / frames) * 10) / 10;

  // second clip of the same session
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New clip' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 10_000 });
  await page.getByTestId('file-input').setInputFiles(repoVideo(SECOND_CLIP));
  await waitComplete(page, 400_000);
  await selectTab(page, 'Data');
  const notes2 = await dataNotes(page);
  const seen2 = await page.evaluate(() => (window as unknown as { __bodyRaw: string[] }).__bodyRaw);
  await page.screenshot({ path: `${dir}/clip2-data-panel.png` });
  const summary = {
    project,
    toasts: seen.toasts,
    bodyRaw: seen2,
    notes,
    notes2,
    backend: track.processing.device.backend,
    tier: track.processing.device.tier,
    elapsedMs: track.processing.elapsedMs,
    frames,
    msPerFrame,
  };
  writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 1));
  console.log(`${project} summary: ${JSON.stringify(summary)}`);
  expect(seen2, 'no raw runtime text on screen at any moment of the run').toEqual([]);

  if (isFirefox) {
    const toast = seen.toasts.join(' | ');
    expect(toast, 'the calm toast appeared').toMatch(/Switched to/);
    expect(toast, 'no raw runtime text in a toast').not.toMatch(RAW);
    expect(track.processing.device.backend, 'the engine ended on the wasm backend').toMatch(/wasm/i);
    // wording is not pinned (the lead rewords it): a calm note about the graphics card and the processor
    const calm = /graphics card.*processor/i;
    expect(notes.join(' | '), 'the fallback note is listed in the Data panel').toMatch(calm);
    expect(notes2.join(' | '), 'and is still listed for the second clip').toMatch(calm);
    for (const note of [...notes, ...notes2]) expect(note).not.toMatch(RAW);
  }
});
