import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  focusPlayer,
  hidePlayer,
  installProbe,
  openClip,
  outDir,
  type PlayerRow,
  playerRows,
  saveJson,
  sliderState,
  soloPlayer,
} from './m4-support';
import { isPreview, repoVideo } from './support';

/**
 * M4-B2a item 2d (review finding on picks, M3 fix round): players picked (focus, hide, solo) while the clip is still
 * analysed must be the same people when the final result replaces the streamed view. The overlay canvas is read back
 * in a grid every 25 ms; the last sample before "Analysis complete" is compared with the first one after it, at the
 * same frame. The cells a pick changes (hide: what disappeared, focus: what appeared, solo: everything that is left)
 * are measured before and after the end.
 *   PORT=5184 E2E_TARGET=preview caffeinate -i -s npx playwright test m4-pick-survives
 */
test.skip(!isPreview, 'real-engine suites need E2E_TARGET=preview');
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
test.setTimeout(300_000);

const CLIPS = ['volleyball_spike_attempt_03.mp4', 'github_beach_st_lenina_20250622_g1_005.mp4'] as const;
const GW = 96;
const GH = 54;

interface Grid {
  readonly t: number;
  readonly cells: string;
  readonly done: boolean;
  readonly pill: boolean;
  readonly frame: number;
}

const GRID_SCRIPT = `(() => {
  const GW = ${GW}, GH = ${GH};
  const grid = () => {
    const canvas = document.querySelector('[data-testid=video-stage] canvas');
    const ctx = canvas && canvas.getContext('2d');
    if (!canvas || !ctx || canvas.width === 0) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const cw = canvas.width / GW, ch = canvas.height / GH;
    const out = new Uint8Array(GW * GH);
    for (let y = 0; y < canvas.height; y++) {
      const gy = Math.min(GH - 1, Math.floor(y / ch));
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 24) out[gy * GW + Math.min(GW - 1, Math.floor(x / cw))] = 1;
      }
    }
    return Array.from(out).join('');
  };
  const slider = () => Number(document.querySelector('[role=slider][aria-label=Timeline]')?.getAttribute('aria-valuenow') ?? -1);
  const state = () => ({
    done: [...document.querySelectorAll('[role=status]')].some((e) => /Analysis complete/.test(e.textContent || '')),
    pill: !!document.querySelector('[data-testid=processing-pill]'),
  });
  const w = window;
  w.__grid = { lastPre: null, firstPost: null, first: null };
  w.__gridNow = () => ({ t: Math.round(performance.now()), cells: grid(), ...state(), frame: slider() });
  setInterval(() => {
    const s = w.__gridNow();
    if (!s.cells) return;
    if (!s.done && s.pill) w.__grid.lastPre = s;
    if (s.done && !w.__grid.firstPost) w.__grid.firstPost = s;
  }, 25);
})();`;

const snapshot = (page: import('@playwright/test').Page): Promise<Grid> =>
  page.evaluate(() => (window as unknown as { __gridNow: () => Grid }).__gridNow());

const cellsOf = (g: Grid, test: (v: number) => boolean = (v) => v === 1): Set<number> =>
  new Set([...g.cells].map((c, i) => (test(Number(c)) ? i : -1)).filter((i) => i >= 0));
const count = (cells: Set<number>, inside: Set<number>): number => [...cells].filter((c) => inside.has(c)).length;
const iou = (a: Set<number>, b: Set<number>): number => {
  const inter = count(a, b);
  return inter / Math.max(1, a.size + b.size - inter);
};
const centroid = (cells: Set<number>): [number, number] => {
  let x = 0;
  let y = 0;
  for (const c of cells) {
    x += c % GW;
    y += Math.floor(c / GW);
  }
  return [x / Math.max(1, cells.size), y / Math.max(1, cells.size)];
};

const pickState = (rows: PlayerRow[]): string =>
  `focus=${rows.filter((r) => r.focused).map((r) => r.label)} solo=${rows.filter((r) => r.solo).map((r) => r.label)} hidden=${rows.filter((r) => r.hidden).map((r) => r.label)}`;

for (const clip of CLIPS) {
  for (const scenario of ['focus + hide', 'solo 1', 'solo 2', 'solo 3'] as const) {
    test(`${clip}: ${scenario} picked during the analysis stay on the same people at its end`, async ({
      page,
      context,
    }) => {
      const name = `${clip.replace(/^.*?_(\w+?)_.*$/, '$1').slice(0, 12)}-${scenario.replace(/\W+/g, '')}`;
      const dir = outDir(`2d-${clip.slice(0, 22)}-${scenario.replace(/\W+/g, '')}`);
      await installProbe(context);
      await context.addInitScript(GRID_SCRIPT);
      await openClip(page, repoVideo(clip));
      await page.waitForFunction(
        () => document.querySelectorAll('ul[aria-label=Players] > li').length >= 3,
        undefined,
        {
          timeout: 120_000,
          polling: 20,
        },
      );
      // pause on the first frame: the overlay then shows the same frame before and after the end
      const rows0 = await playerRows(page);
      const base = await snapshot(page);
      const report: Record<string, unknown> = {
        clip,
        scenario,
        name,
        rowsAtStart: rows0.length,
        baseFrame: base.frame,
      };
      let signature: Set<number>;
      let picks: string;
      if (scenario === 'focus + hide') {
        const [a, b] = [rows0[0]?.label as string, rows0[1]?.label as string];
        const m0 = cellsOf(await snapshot(page));
        await focusPlayer(page, a);
        const m1 = cellsOf(await snapshot(page));
        await hidePlayer(page, b);
        const m2 = cellsOf(await snapshot(page));
        const appeared = new Set([...m1].filter((c) => !m0.has(c)));
        const vanished = new Set([...m1].filter((c) => !m2.has(c)));
        report.focusLabel = a;
        report.hideLabel = b;
        report.focusAppearedCells = appeared.size;
        report.hiddenVanishedCells = vanished.size;
        signature = vanished;
        picks = `focus ${a}, hide ${b}`;
        report.focusCells = appeared;
      } else {
        const c = rows0[Number(scenario.slice(-1)) - 1]?.label as string;
        await soloPlayer(page, c);
        const m = cellsOf(await snapshot(page));
        report.soloLabel = c;
        report.soloCells = m.size;
        signature = m;
        picks = `solo ${c}`;
      }
      const rowsPicked = await playerRows(page);
      await page.screenshot({ path: join(dir, '1-picked.png') });
      // watch the analysis end; keep stage shots at about 150 ms
      let pre: Buffer | null = null;
      const deadline = Date.now() + 200_000;
      for (;;) {
        const s = await snapshot(page);
        if (s.done) break;
        pre = await page.locator('[data-testid=video-stage]').screenshot();
        if (Date.now() > deadline) throw new Error('analysis did not end');
      }
      await page.waitForTimeout(600);
      const post = await page.locator('[data-testid=video-stage]').screenshot();
      if (pre) (await import('node:fs')).writeFileSync(join(dir, '2-stage-just-before-the-end.png'), pre);
      (await import('node:fs')).writeFileSync(join(dir, '3-stage-after-the-end.png'), post);
      const { lastPre, firstPost } = await page.evaluate(
        () => (window as unknown as { __grid: { lastPre: Grid | null; firstPost: Grid | null } }).__grid,
      );
      const rowsAfter = await playerRows(page);
      const slider = await sliderState(page);
      await page.screenshot({ path: join(dir, '4-after-the-end.png') });
      expect(lastPre, 'a sample before the end').not.toBeNull();
      expect(firstPost, 'a sample after the end').not.toBeNull();
      const a = cellsOf(lastPre as Grid);
      const b = cellsOf(firstPost as Grid);
      const out = {
        ...report,
        focusCells: undefined,
        picks,
        pickedRows: pickState(rowsPicked),
        rowsAfter: pickState(rowsAfter),
        framePre: lastPre?.frame,
        framePost: firstPost?.frame,
        sliderAfter: slider.frame,
        paintedPre: a.size,
        paintedPost: b.size,
        iouPrePost: Number(iou(a, b).toFixed(3)),
        signaturePreInside: count(a, signature),
        signaturePostInside: count(b, signature),
        signatureSize: signature.size,
        centroidPre: centroid(a),
        centroidPost: centroid(b),
        rowsAfterCount: rowsAfter.length,
      };
      saveJson(dir, 'report.json', out);
      console.log(`pick ${name}: ${JSON.stringify(out)}`);
      expect(lastPre?.frame, 'the same frame is on show before and after the end').toBe(firstPost?.frame);
      if (scenario !== 'focus + hide') {
        // a streamed player that was not drawn at this frame (a 'position only' fragment) has no position to match:
        // such a pick may legitimately end with no match in the final result, so only a visible one is checked
        if (signature.size > 0) {
          expect(rowsAfter.filter((r) => r.solo).length, 'one player is soloed after the end').toBe(1);
          const [x0, y0] = centroid(a);
          const [x1, y1] = centroid(b);
          // the final result draws a smoothed, slightly different skeleton (beach P3, a small figure at the edge: 47 -> 35
          // cells, centroid 5.7 cells of 96 off), so the person is checked by overlap first, the centroid loosely
          expect(
            count(b, signature) / Math.max(1, b.size),
            'the soloed person after the end lies on the cells it covered before (share of post cells inside the pre cells)',
          ).toBeGreaterThanOrEqual(0.7);
          expect(
            Math.hypot(x1 - x0, y1 - y0),
            'the soloed person is drawn in the same place (grid cells of 96)',
          ).toBeLessThan(7);
        }
      } else {
        expect(rowsAfter.filter((r) => r.focused).length, 'one focused player after the end').toBe(1);
        expect(rowsAfter.filter((r) => r.hidden).length, 'one hidden player after the end').toBe(1);
        // what disappeared when the player was hidden must still be (nearly) empty after the end
        const refilled = count(b, signature) / Math.max(1, signature.size);
        const before = count(a, signature) / Math.max(1, signature.size);
        expect(
          refilled,
          'the hidden person stayed hidden (cells of the hidden person painted after the end)',
        ).toBeLessThan(Math.max(0.25, before + 0.15));
      }
    });
  }
}
