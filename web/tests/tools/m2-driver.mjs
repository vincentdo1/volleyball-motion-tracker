/**
 * M2 driver: uploads one clip through the real UI (real engine, no ?mock), waits for the results view and exports
 * JSON / CSV / PNG / MP4 into an output folder; writes timings to run.json.
 *   node tests/tools/m2-driver.mjs --clip <path> --out <dir> [--port 5184] [--exports json,csv,png,mp4] [--args "--disable-features=..."]
 *        [--timeout 600000] [--shot] [--hide-tab] [--query ?x=y]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values: a } = parseArgs({
  options: {
    clip: { type: 'string' },
    out: { type: 'string' },
    port: { type: 'string', default: '5184' },
    exports: { type: 'string', default: 'json,csv,png,mp4' },
    args: { type: 'string', default: '' },
    timeout: { type: 'string', default: '900000' },
    shot: { type: 'boolean', default: false },
    query: { type: 'string', default: '' },
    tag: { type: 'string', default: '' },
  },
});
const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(a.out, { recursive: true });
const browser = await chromium.launch({
  executablePath: existsSync(chrome) ? chrome : undefined,
  headless: true,
  args: a.args ? a.args.split(' ').filter(Boolean) : [],
});
const ctx = await browser.newContext({
  acceptDownloads: true,
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 900 },
});
// M2-1 workaround (diagnostic, product code untouched): serve frame-loop.ts with MAX_IN_FLIGHT = 1 from the dev server
if (process.env.VBT_PATCH_INFLIGHT) {
  await ctx.route(/engine\.worker-.*\.js(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      'this.inFlight.length>=2',
      `this.inFlight.length>=${process.env.VBT_PATCH_INFLIGHT}`,
    );
    await route.fulfill({ response: res, body });
  });
}
const page = await ctx.newPage();
const log = { clip: basename(a.clip), console: [], errors: [], t: {} };
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) log.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => log.errors.push(String(e).slice(0, 300)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${a.port}/${a.query}`);
await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60000 });
log.t.loaded = Date.now() - t0;
const tPick = Date.now();
await page.getByTestId('file-input').setInputFiles(a.clip);
// first frames: wait for the pill / results
const outcome = await Promise.race([
  page
    .getByTestId('processing-pill')
    .waitFor({ timeout: 120000 })
    .then(() => 'processing'),
  page
    .getByRole('heading', { level: 1 })
    .filter({ hasText: /./ })
    .first()
    .waitFor({ timeout: 120000 })
    .then(() => 'heading'),
]).catch((e) => `none:${e.message.slice(0, 80)}`);
log.t.toProcessing = Date.now() - tPick;
log.outcome1 = outcome;
// poll until done / error
const deadline = Date.now() + Number(a.timeout);
let final = 'timeout';
const progress = [];
while (Date.now() < deadline) {
  const st = await page.evaluate(() => ({
    pill: document.querySelector('[data-testid=processing-pill]')?.textContent ?? null,
    status: [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('|'),
    players: document.querySelectorAll('ul[aria-label=Players] > li').length,
    problem: document.querySelector('[role=alert], h1')?.textContent ?? null,
  }));
  if (progress.length < 2000) progress.push([Date.now() - tPick, st.pill, st.players]);
  if (progress.length % 10 === 1)
    console.error(Math.round((Date.now() - tPick) / 1000), 's', JSON.stringify(st).slice(0, 200));
  if (/Analysis complete/.test(st.status)) {
    final = 'done';
    break;
  }
  if (!st.pill && !/Analysis complete/.test(st.status) && Date.now() - tPick > 4000) {
    const body = (await page.locator('body').innerText()).slice(0, 500);
    if (!/Stop|analys/i.test(body)) {
      final = `other:${body.replace(/\s+/g, ' ').slice(0, 300)}`;
      break;
    }
  }
  await page.waitForTimeout(500);
}
log.t.wall = Date.now() - tPick;
if (final !== 'done') await page.screenshot({ path: join(a.out, `fail${a.tag}.png`) }).catch(() => {});
log.final = final;
log.progress = progress;
if (a.shot) await page.screenshot({ path: join(a.out, 'results.png') });
if (final === 'done') {
  log.status = await page.evaluate(() =>
    [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('|'),
  );
  log.players = await page.locator('ul[aria-label=Players] > li').allInnerTexts();
  const wanted = a.exports.split(',').filter(Boolean);
  const names = { json: 'Tracking data', csv: 'Spreadsheet', png: 'Current frame', mp4: 'Video with skeletons' };
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  log.exports = {};
  for (const kind of wanted) {
    const t1 = Date.now();
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^Export ${names[kind]}`, 'i') }).first();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), btn.click()]);
      const file = join(a.out, dl.suggestedFilename());
      await dl.saveAs(file);
      log.exports[kind] = { file, ms: Date.now() - t1 };
    } catch (e) {
      const alert = await page.getByRole('alert').allInnerTexts();
      log.exports[kind] = { error: String(e).slice(0, 200), alert, ms: Date.now() - t1 };
    }
  }
}
writeFileSync(join(a.out, `run${a.tag}.json`), JSON.stringify(log, null, 1));
await browser.close();
console.log(
  JSON.stringify({
    clip: log.clip,
    final: log.final,
    t: log.t,
    players: log.players?.length,
    exports:
      log.exports &&
      Object.fromEntries(Object.entries(log.exports).map(([k, v]) => [k, v.error ? 'ERR ' + v.error : v.ms])),
    errors: log.errors.length,
    console: log.console.length,
  }),
);
