/** Cross-browser probe: capability tier and one short clip end to end through the UI. node m2-cross.mjs webkit|firefox [headed] */
import { chromium, firefox, webkit } from '@playwright/test';

const [name, headed] = process.argv.slice(2);
const type = { webkit, firefox, chromium }[name];
const clip = process.env.CLIP ?? '../test_videos/volleyball_spike_attempt_04.mp4';
const browser = await type.launch({ headless: headed !== 'headed' });
const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
if (process.env.PATCH) {
  await ctx.route(/engine\.worker-.*\.js(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      body: (await res.text()).replace('this.inFlight.length>=2', 'this.inFlight.length>=1'),
    });
  });
}
const page = await ctx.newPage();
const logs = [];
page.on(
  'console',
  (m) => ['error', 'warning'].includes(m.type()) && logs.push(`${m.type()}: ${m.text().slice(0, 200)}`),
);
page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url().slice(-60)} ${r.failure()?.errorText}`));
page.on('response', (r) => /models|ort/.test(r.url()) && logs.push(`resp ${r.status()} ${r.url().slice(-50)}`));
const out = { browser: name, version: browser.version() };
await page.goto('http://127.0.0.1:5184/#/about');
await page.getByTestId('cap-tier').waitFor({ timeout: 60000 });
await page.waitForTimeout(4000);
out.caps = await page.evaluate(() =>
  Object.fromEntries(
    ['isolated', 'webgpu', 'adapter', 'webcodecs', 'tier'].map((k) => [
      k,
      document.querySelector(`[data-testid=cap-${k}]`)?.textContent,
    ]),
  ).constructor === Object
    ? {
        ...Object.fromEntries(
          ['isolated', 'webgpu', 'adapter', 'webcodecs', 'tier'].map((k) => [
            k,
            document.querySelector(`[data-testid=cap-${k}]`)?.textContent,
          ]),
        ),
        ort: document.querySelector('[data-testid=ort-selftest]')?.textContent,
      }
    : {},
);
await page.goto('http://127.0.0.1:5184/');
await page.getByTestId('file-input').waitFor({ state: 'attached' });
if (process.env.WAIT) await page.waitForTimeout(Number(process.env.WAIT));
const t0 = Date.now();
await page.getByTestId('file-input').setInputFiles(clip);
const deadline = Date.now() + Number(process.env.TIMEOUT ?? 240000);
let last = '';
while (Date.now() < deadline) {
  const st = await page.evaluate(() => ({
    pill: document.querySelector('[data-testid=processing-pill]')?.textContent ?? null,
    done: [...document.querySelectorAll('[role=status]')].some((e) => /Analysis complete/.test(e.textContent)),
    alert: document.querySelector('[role=alert]')?.innerText ?? null,
    players: document.querySelectorAll('ul[aria-label=Players] > li').length,
  }));
  if (st.done) {
    out.result = { status: 'done', ms: Date.now() - t0, players: st.players };
    break;
  }
  if (st.alert) {
    out.result = { status: 'error', ms: Date.now() - t0, alert: st.alert.replace(/\s+/g, ' ').slice(0, 300) };
    break;
  }
  last = st.pill ?? '';
  await page.waitForTimeout(1000);
}
out.result ??= { status: 'timeout', last };
await page.screenshot({ path: `/tmp/m2-cross-${name}.png` });
out.logs = logs.slice(0, 40);
console.log(JSON.stringify(out, null, 1));
await browser.close();
