/** Cancel / resume / reload / hidden-tab probes against a preview server; prints a JSON report. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const clip = process.argv[2] ?? '../test_videos/github_beach_st_lenina_20250622_g1_005.mp4';
const port = process.env.PORT ?? '5184';
const mode = process.argv[3] ?? 'all';
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const ctx = await browser.newContext({
  acceptDownloads: true,
  serviceWorkers: 'block',
  viewport: { width: 1440, height: 900 },
});
await ctx.route(/engine\.worker-.*\.js(\?.*)?$/, async (route) => {
  const res = await route.fetch();
  await route.fulfill({
    response: res,
    body: (await res.text()).replace('this.inFlight.length>=2', 'this.inFlight.length>=1'),
  });
});
const out = {};
const open = async () => {
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  return page;
};
const pct = (page) =>
  page.evaluate(() =>
    Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1),
  );
const done0 = (page, ms = 60000) =>
  page
    .waitForFunction(
      () =>
        /Analysis complete/.test(document.body.innerText) ||
        [...document.querySelectorAll('[role=status]')].some((e) => /complete/.test(e.textContent)),
      null,
      { timeout: ms },
    )
    .catch(async (e) => {
      out.stuck = {
        pill: await page.evaluate(() => document.querySelector('[data-testid=processing-pill]')?.textContent ?? null),
        body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300),
      };
      await page.screenshot({ path: '/tmp/m2-stuck.png' });
      throw e;
    });
const done = async (page, ms) => {
  try {
    await done0(page, ms);
  } catch (e) {
    out.stuck = {
      pill: await page.evaluate(() => document.querySelector('[data-testid=processing-pill]')?.textContent ?? null),
      body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300),
    };
    await page.screenshot({ path: '/tmp/m2-stuck.png' });
    console.log(JSON.stringify(out, null, 1));
    await browser.close();
    process.exit(1);
  }
};
if (mode === 'all' || mode === 'cancel') {
  const page = await open();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page.waitForFunction(
    () =>
      /(\d+)%/.test(document.querySelector('[data-testid=processing-pill]')?.textContent ?? '') &&
      Number(document.querySelector('[data-testid=processing-pill]').textContent.match(/(\d+)%/)[1]) >= 30,
    null,
    { timeout: 60000 },
  );
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /Keep \d+% analysed/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=processing-pill]'), null, { timeout: 10000 });
  out.keepPartial = {
    ms: Date.now() - t0,
    players: await page.locator('ul[aria-label=Players] > li').count(),
    body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200),
  };
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  out.keepPartial.exportButtons = await page
    .getByRole('button', { name: /^Export / })
    .evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label')}:${e.disabled ? 'disabled' : 'enabled'}`));
  await page.screenshot({ path: '/tmp/m2-cancel-keep.png' });
  await page.close();
}
if (mode === 'all' || mode === 'discard') {
  const page = await open();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page.waitForFunction(
    () =>
      Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1) >=
      30,
    null,
    { timeout: 60000 },
  );
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 10000 });
  out.discard = { ms: Date.now() - t0, landing: /See every player/.test(await page.locator('body').innerText()) };
  // now run again to completion and time it
  const t1 = Date.now();
  await page.getByTestId('file-input').setInputFiles(clip);
  await done(page);
  out.discard.rerunMs = Date.now() - t1;
  out.discard.players = await page.locator('ul[aria-label=Players] > li').count();
  await page.close();
}
if (mode === 'all' || mode === 'reload') {
  const page = await open();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page.waitForFunction(
    () =>
      Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1) >=
      50,
    null,
    { timeout: 60000 },
  );
  await page.reload();
  await page.getByTestId('file-input').waitFor({ state: 'attached' });
  out.reload = { landing: /See every player/.test(await page.locator('body').innerText()) };
  const t1 = Date.now();
  await page.getByTestId('file-input').setInputFiles(clip);
  const first = await page
    .waitForFunction(() => document.querySelector('[data-testid=processing-pill]')?.textContent ?? false, null, {
      timeout: 30000,
    })
    .then((h) => h.jsonValue());
  out.reload.firstPill = first;
  await done(page);
  out.reload.rerunMs = Date.now() - t1;
  await page.close();
}
if (mode === 'all' || mode === 'hidden') {
  // tab hidden: open a second tab in front so the first is backgrounded (headless: emulate via visibility override)
  const page = await open();
  await page.getByTestId('file-input').setInputFiles(clip);
  await page.waitForFunction(
    () =>
      Number((document.querySelector('[data-testid=processing-pill]')?.textContent.match(/(\d+)%/) ?? [])[1] ?? -1) >=
      10,
    null,
    { timeout: 60000 },
  );
  const t0 = Date.now();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(6000);
  out.hidden = { pctAfter6s: await pct(page), vis: await page.evaluate(() => document.visibilityState) };
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.bringToFront();
  await done(page, 180000);
  out.hidden.totalMs = Date.now() - t0;
  out.hidden.players = await page.locator('ul[aria-label=Players] > li').count();
  await page.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
