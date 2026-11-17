import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [clip, port = '5185', ms = '90000'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const p = await b.newPage();
p.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
p.on('response', (r) => r.status() >= 400 && console.log('[http]', r.status(), r.url()));
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto(`http://127.0.0.1:${port}/src/engine/dev/harness.html${process.env.Q ?? ''}`);
const t0 = Date.now();
const r = await Promise.race([
  p
    .evaluate(async (c) => {
      const x = await window.__engineHarness.run(c, {
        useStub: location.search.includes('stub'),
        init: { debug: true },
      });
      return {
        ok: true,
        ev: window.__engineHarness.events.length,
        tracks: x.result.document?.tracks?.length ?? Object.keys(x.result),
      };
    }, clip)
    .catch((e) => ({ err: String(e).slice(0, 300) })),
  new Promise((res) => setTimeout(() => res('timeout'), Number(ms))),
]);
console.log(JSON.stringify(r), Date.now() - t0);
const evs = await p.evaluate(() =>
  window.__engineHarness.events
    .map(
      (e) =>
        e.type +
        (e.stats ? ':' + JSON.stringify(e.stats) : '') +
        (e.state ? ':' + e.state : '') +
        (e.progress ? ':' + JSON.stringify(e.progress).slice(0, 120) : ''),
    )
    .slice(-12),
);
console.log(evs.join('\n'));
await b.close();
