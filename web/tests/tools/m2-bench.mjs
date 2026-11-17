/** Runs the ML bench page (real WebGPU or WASM) against a running server and writes window.__bench to --out. */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const chrome = `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const [query, out, port = '5185', ms = '900000'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
const p = await b.newPage();
p.on('console', (m) => ['error'].includes(m.type()) && console.log('[console]', m.text().slice(0, 200)));
await p.goto(`http://127.0.0.1:${port}/src/ml/harness/bench.html?${query}`);
await p
  .waitForFunction(() => window.__bench?.done || window.__bench?.error, null, { timeout: Number(ms) })
  .catch((e) => console.log('wait fail', String(e).slice(0, 100)));
const r = await p.evaluate(() => window.__bench ?? null);
console.log(
  await p
    .locator('#status')
    .innerText()
    .catch(() => ''),
);
if (r && out) writeFileSync(out, JSON.stringify(r));
console.log(r ? Object.keys(r).join(',') : 'no result');
await b.close();
