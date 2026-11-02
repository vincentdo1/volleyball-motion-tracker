// Runs src/ml/harness/bench.html in Chrome for Testing (real Metal WebGPU) against a dev server this script starts,
// and writes the page's predictions + timings to <VBT_ML_RUNS_DIR>/<name>.json.
//   PORT=5181 node scripts/ml/run-bench.mjs [--tier webgpu-default] [--set static|run|all] [--limit n]
//     [--cadence n] [--detector id] [--pose id] [--name label]
// Environment: PORT (default 5181), VBT_CHROME, VBT_ML_RUNS_DIR (default ~/.cache/volleyball-motion-tracker/ml-runs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, all) => (v.startsWith('--') ? [v.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const port = Number(process.env.PORT ?? 5181);
const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const runsDir = process.env.VBT_ML_RUNS_DIR ?? join(homedir(), '.cache', 'volleyball-motion-tracker', 'ml-runs');
const base = `http://127.0.0.1:${port}`;

const server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: 'ignore', detached: false });
const stopServer = () => server.kill('SIGTERM');
process.on('exit', stopServer);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not start on ${port}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, executablePath: existsSync(chrome) ? chrome : undefined });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => (m.type() === 'error' ? console.error('console', m.text().slice(0, 300)) : undefined));
  const params = new URLSearchParams(args);
  await page.goto(`${base}/src/ml/harness/bench.html?${params}`);
  await page.waitForFunction(() => window.__bench?.done === true, undefined, { timeout: 0, polling: 500 });
  const { result, error } = await page.evaluate(() => window.__bench);
  if (error) throw new Error(error);
  mkdirSync(runsDir, { recursive: true });
  const out = join(runsDir, `${result.name}.json`);
  writeFileSync(out, JSON.stringify(result));
  console.log(`wrote ${out}`);
  console.log(
    JSON.stringify({
      name: result.name,
      medianMs: result.medianMs,
      stageMedianMs: result.stageMedianMs,
      warmup: result.warmup,
    }),
  );
} finally {
  await browser?.close();
  stopServer();
}
