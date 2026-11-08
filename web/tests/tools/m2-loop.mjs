/**
 * M2-16 loop driver (adopted from the backend's loop2.mjs). Runs clips through the real app on the production build, one
 * fresh browser context per run, and records for each run: wall time, engine events seen by the page (spawn, state,
 * progress, warning, error), console output of the page and its workers, and, when a run makes no progress for
 * --stall ms, a screenshot plus a native `sample` of the renderer process.
 *   node tests/tools/m2-loop.mjs --clips a.mp4,b.mp4 --runs 3 --out dir [--port $PORT|5184] [--stall 45000] [--timeout 240000]
 *        [--fresh] [--keep] [--query ?x=y] [--args "--flag --flag2"] [--no-sample]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, webkit } from '@playwright/test';

const { values: a } = parseArgs({
  options: {
    clips: { type: 'string' },
    runs: { type: 'string', default: '1' },
    out: { type: 'string' },
    port: { type: 'string', default: process.env.PORT ?? '5184' },
    stall: { type: 'string', default: '45000' },
    timeout: { type: 'string', default: '240000' },
    fresh: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    query: { type: 'string', default: '' },
    args: { type: 'string', default: '' },
    'no-sample': { type: 'boolean', default: false },
    tag: { type: 'string', default: '' },
    'skew-at': { type: 'string', default: '' },
    'skew-ms': { type: 'string', default: '60000' },
    'freeze-at': { type: 'string', default: '' },
    'freeze-ms': { type: 'string', default: '15000' },
    'stop-at': { type: 'string', default: '' },
    'stop-ms': { type: 'string', default: '15000' },
    'stop-on-state': { type: 'string', default: '' },
    patch: { type: 'string', default: '' },
    shots: { type: 'boolean', default: false },
    browser: { type: 'string', default: 'chromium' },
    'patch-file': { type: 'string', default: 'engine\\.worker-[^/]*\\.js' },
  },
});
const chrome =
  process.env.VBT_CHROME ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(a.out, { recursive: true });
/** Monotonic like the page's performance.now(): does not advance while the machine sleeps. */
const now = () => performance.now();

/** Runs in every page before the app: records the engine events the page receives from each worker it spawns. */
function initScript(stopOnState) {
  const realNow = Date.now.bind(Date);
  window.__skewMs = 0;
  Date.now = () => realNow() + window.__skewMs;
  const log = [];
  window.__engineLog = log;
  const t0 = performance.now();
  const push = (e) => {
    if (log.length < 20000) log.push({ t: Math.round(performance.now() - t0), ...e });
  };
  const Orig = window.Worker;
  let generation = -1;
  window.Worker = class extends Orig {
    constructor(url, opts) {
      super(url, opts);
      generation++;
      const gen = generation;
      push({ k: 'spawn', gen, name: opts?.name ?? '' });
      this.addEventListener('message', (m) => {
        const d = m.data;
        if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
        const e = { k: d.type, gen };
        if (d.type === 'progress') {
          e.stage = d.progress.stage;
          e.frames = d.progress.framesDone;
          e.of = d.progress.framesTotal;
        } else if (d.type === 'state') {
          e.state = d.state;
          if (stopOnState && d.state === stopOnState) console.debug('__vbt_stop__');
        } else if (d.type === 'warning') e.warning = `${d.warning.code}:${d.warning.detail?.reason ?? ''}`;
        else if (d.type === 'error') e.error = `${d.error.code}:${String(d.error.message).slice(0, 80)}`;
        else if (d.type === 'reply') {
          e.id = d.requestId;
          e.ok = d.ok;
          if (!d.ok) e.error = d.error?.code;
        } else if (d.type === 'chunk') e.seq = d.seq;
        push(e);
      });
      this.addEventListener('error', (ev) => push({ k: 'worker-error', gen, msg: String(ev.message).slice(0, 100) }));
    }
  };
}

function processTable() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 1 << 26 })
    .toString()
    .split('\n')
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter(Boolean);
}

/**
 * Renderer processes of the browser this script launched. Chromium: children of its main process. WebKit (Playwright
 * MiniBrowser): the WebContent XPC services are not children, so match them by the Playwright cache path.
 */
function ownProcesses() {
  const table = processTable();
  if (a.browser === 'webkit') {
    return table
      .filter(
        (p) => /ms-playwright.*WebContent|WebContent.*ms-playwright/.test(p.command) && !/\bsample\b/.test(p.command),
      )
      .map((p) => ({ pid: p.pid, type: 'renderer' }));
  }
  const main = table.find((p) => p.ppid === process.pid && p.command.includes('Google Chrome for Testing'));
  if (!main) return [];
  return table
    .filter((p) => p.ppid === main.pid && /--type=(renderer|gpu-process)/.test(p.command))
    .map((p) => ({ pid: p.pid, type: /--type=(\w[\w-]*)/.exec(p.command)?.[1] ?? '?' }));
}

function sampleProcesses(dir, tag) {
  const files = [];
  for (const p of ownProcesses()) {
    const file = join(dir, `sample-${tag}-${p.type}-${p.pid}.txt`);
    try {
      execFileSync('sample', [String(p.pid), '3', '-file', file], { timeout: 30000, stdio: 'ignore' });
      files.push(file);
    } catch (e) {
      files.push(`${file} FAILED ${String(e).slice(0, 80)}`);
    }
  }
  return files;
}

const clips = a.clips.split(',').filter(Boolean);
const results = [];
let browser;
async function launch() {
  browser = await (a.browser === 'webkit' ? webkit : chromium).launch({
    executablePath: a.browser === 'webkit' ? undefined : existsSync(chrome) ? chrome : undefined,
    headless: true,
    args: a.args ? a.args.split(' ').filter(Boolean) : [],
  });
}

async function runOne(clip, index) {
  const label = `${String(index).padStart(3, '0')}-${basename(clip, '.mp4')}`;
  const runDir = join(a.out, label);
  mkdirSync(runDir, { recursive: true });
  if (a.fresh || !browser) {
    await browser?.close().catch(() => {});
    await launch();
  }
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(initScript, a['stop-on-state']);
  if (a.patch) {
    const pairs = a.patch.split('||').map((pair) => pair.split('=>'));
    await ctx.route(new RegExp(`${a['patch-file']}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      let text = await res.text();
      for (const [from, to] of pairs) {
        if (!text.includes(from)) console.error(`PATCH TARGET NOT FOUND: ${from}`);
        text = text.replace(from, to);
      }
      await route.fulfill({ response: res, body: text });
    });
  }
  const page = await ctx.newPage();
  const consoleLog = [];
  const t0 = now();
  const stamp = (text) => consoleLog.push(`${((now() - t0) / 1000).toFixed(1)}s ${text}`);
  let stopped = false;
  page.on('console', (m) => {
    if (m.text() === '__vbt_stop__') {
      // suspend as soon as the engine reports the state (e.g. 'processing': before the first frame is done)
      if (stopped) return;
      stopped = true;
      const pids = ownProcesses()
        .filter((p) => p.type === 'renderer')
        .map((p) => p.pid);
      run.stoppedOnState = a['stop-on-state'];
      run.stopWallMs = Math.round(now() - t0);
      run.stoppedPids = pids;
      for (const pid of pids) process.kill(pid, 'SIGSTOP');
      setTimeout(() => {
        for (const pid of pids) process.kill(pid, 'SIGCONT');
        run.contWallMs = Math.round(now() - t0);
      }, Number(a['stop-ms']));
      return;
    }
    stamp(`[page ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => stamp(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on('worker', (w) => {
    stamp(`[worker open] ${w.url().slice(-60)}`);
    w.on('console', (m) => stamp(`[worker ${m.type()}] ${m.text().slice(0, 300)}`));
    w.on('close', () => stamp(`[worker close] ${w.url().slice(-60)}`));
  });
  const run = { label, clip: basename(clip), outcome: 'timeout', wallMs: 0, stepdowns: 0, samples: [] };
  try {
    await page.goto(`http://127.0.0.1:${a.port}/${a.query}`);
    await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60000 });
    const tPick = now();
    const tPickWall = Date.now();
    await page.getByTestId('file-input').setInputFiles(clip);
    let lastPct = -1;
    let lastText = '';
    let lastChangeAt = now();
    let skewed = false;
    let frozen = false;
    let sampled = false;
    const deadline = tPick + Number(a.timeout);
    while (now() < deadline) {
      const st = await page
        .evaluate(() => ({
          pill: document.querySelector('[data-testid=processing-pill]')?.textContent ?? '',
          status: [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join('|'),
          body: document.body.innerText.slice(0, 4000),
        }))
        .catch(() => null);
      if (!st) {
        run.outcome = 'page-gone';
        break;
      }
      if (/Analysis complete/.test(st.status)) {
        run.outcome = 'done';
        break;
      }
      const pct = Number(/(\d+)%/.exec(st.pill)?.[1] ?? -1);
      const slower = /Switched to a slower mode/.test(st.body);
      if (slower) run.stepdowns = Math.max(run.stepdowns, 1);
      const text = `${pct}|${slower}`;
      if (pct !== lastPct || text !== lastText) {
        lastPct = pct;
        lastText = text;
        lastChangeAt = now();
      }
      if (a['skew-at'] !== '' && !skewed && pct >= Number(a['skew-at'])) {
        skewed = true;
        run.skewedAtPct = pct;
        await page.evaluate((ms) => {
          window.__skewMs += ms;
        }, Number(a['skew-ms']));
      }
      if (a['freeze-at'] !== '' && !frozen && pct >= Number(a['freeze-at'])) {
        frozen = true;
        run.frozenAtPct = pct;
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        await new Promise((r) => setTimeout(r, Number(a['freeze-ms'])));
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        lastChangeAt = now();
      }
      if (a['stop-at'] !== '' && !run.stoppedAtPct && pct >= Number(a['stop-at'])) {
        run.stoppedAtPct = pct;
        const pids = ownProcesses()
          .filter((p) => p.type === 'renderer')
          .map((p) => p.pid);
        run.stopWallMs = Math.round(now() - t0);
        run.stoppedPids = pids;
        for (const pid of pids) process.kill(pid, 'SIGSTOP');
        await new Promise((r) => setTimeout(r, Number(a['stop-ms'])));
        for (const pid of pids) process.kill(pid, 'SIGCONT');
        run.contWallMs = Math.round(now() - t0);
        lastChangeAt = now();
      }
      if (!st.pill && now() - tPick > 8000 && !/Stop|analys|Finding|player/i.test(st.body)) {
        run.outcome = `other:${st.body.replace(/\s+/g, ' ').slice(0, 160)}`;
        break;
      }
      if (now() - lastChangeAt > Number(a.stall)) {
        if (!sampled) {
          sampled = true;
          run.stalledAtPct = pct;
          run.stalledAfterMs = Math.round(now() - tPick);
          await page.screenshot({ path: join(runDir, 'stall.png') }).catch(() => {});
          if (!a['no-sample']) run.samples = sampleProcesses(runDir, 'stall');
        }
        if (!a.keep) {
          run.outcome = 'stalled';
          break;
        }
        if (now() - lastChangeAt > Number(a.stall) * 3) {
          run.outcome = 'stalled';
          break;
        }
      }
      await page.waitForTimeout(400);
    }
    run.wallMs = Math.round(now() - tPick);
    run.slept = Date.now() - tPickWall - run.wallMs > 10000;
    if (run.outcome === 'timeout') run.outcome = 'stalled-timeout';
    run.engineLog = await page.evaluate(() => window.__engineLog ?? []).catch(() => []);
    if (run.outcome !== 'done') await page.screenshot({ path: join(runDir, 'end.png') }).catch(() => {});
  } catch (error) {
    run.outcome = `driver-error:${String(error).slice(0, 160)}`;
  } finally {
    run.console = consoleLog;
    run.pid = process.pid;
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 1));
    await ctx.close().catch(() => {});
  }
  const { engineLog, console: _c, ...summary } = run;
  const warnings = (engineLog ?? []).filter((e) => e.k === 'warning' || e.k === 'error' || e.k === 'spawn');
  summary.generations = (engineLog ?? []).filter((e) => e.k === 'spawn').length;
  summary.notes = warnings.filter((e) => e.k !== 'spawn').map((e) => `${e.t}ms ${e.k} ${e.warning ?? e.error}`);
  console.log(JSON.stringify(summary));
  results.push(summary);
}

try {
  let index = 0;
  for (let pass = 0; pass < Number(a.runs); pass++) {
    for (const clip of clips) await runOne(clip, ++index);
  }
} finally {
  await browser?.close().catch(() => {});
}
const counts = {};
for (const r of results) counts[r.outcome.split(':')[0]] = (counts[r.outcome.split(':')[0]] ?? 0) + 1;
console.log('SUMMARY', JSON.stringify(counts), `runs=${results.length}`);
writeFileSync(join(a.out, `summary${a.tag}.json`), JSON.stringify(results, null, 1));
