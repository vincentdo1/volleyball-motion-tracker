/** Engine harness (no UI) in another browser: node m2-cross-harness.mjs webkit|firefox clip [headed] */
import { firefox, webkit } from '@playwright/test';

const [name, clip, headed] = process.argv.slice(2);
const b = await { webkit, firefox }[name].launch({ headless: headed !== 'headed' });
const ctx = await b.newContext();
if (process.env.PATCH) {
  await ctx.route('**/src/engine/process/frame-loop.ts*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace('MAX_IN_FLIGHT = 2', 'MAX_IN_FLIGHT = 1') });
  });
}
const p = await ctx.newPage();
p.on(
  'console',
  (m) => ['error', 'warning'].includes(m.type()) && console.log('[console]', m.type(), m.text().slice(0, 250)),
);
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 250)));
await p.goto('http://127.0.0.1:5185/src/engine/dev/harness.html');
await p.waitForTimeout(1500);
const r = await Promise.race([
  p.evaluate(async (c) => {
    try {
      const x = await window.__engineHarness.run(c, { init: { debug: true } });
      return { ok: true, tracks: x.result.tracks?.length, ready: x.ready };
    } catch (e) {
      return { err: String(e).slice(0, 400) };
    }
  }, clip),
  new Promise((res) => setTimeout(() => res('timeout'), 120000)),
]);
console.log(JSON.stringify(r).slice(0, 600));
console.log(
  (
    await p
      .evaluate(() =>
        window.__engineHarness.events
          .filter((e) => e.type !== 'model-progress' && e.type !== 'chunk' && e.type !== 'progress')
          .map(
            (e) =>
              e.type +
              (e.state ? ':' + e.state : '') +
              (e.error ? ':' + e.error.code + ':' + e.error.message.slice(0, 80) : '') +
              (e.warning ? ':' + e.warning.code : ''),
          ),
      )
      .catch((e) => ['evt err ' + e])
  ).join('\n'),
);
await b.close();
