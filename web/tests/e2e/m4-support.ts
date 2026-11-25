import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * M4 part B: helpers for the checks that watch the real engine and the real UI together on the production build.
 * Everything here observes from outside (the DOM, the two canvases, the messages the engine worker posts) or changes
 * a built chunk on its way to the browser (a Playwright route), so no product code is involved.
 *
 * Evidence (screenshots, logs, exports) goes to M4_OUT (default ~/.cache/volleyball-motion-tracker/fixtures/m4-runs).
 */
export const M4_OUT = process.env.M4_OUT ?? join(homedir(), '.cache/volleyball-motion-tracker/fixtures/m4-runs');

export function outDir(name: string): string {
  const dir = join(M4_OUT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveJson(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 1));
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------
// The page-side probe
// ---------------------------------------------------------------------------------------------------------------------

/** One message the engine worker posted to the page (or `spawn`, `command`, `worker-error`), in page milliseconds. */
export interface LogEntry {
  readonly t: number;
  readonly k: string;
  readonly gen: number;
  readonly [key: string]: unknown;
}

/** What the screen showed; a sample is recorded whenever any field changes (checked every 100 ms). */
export interface Sample {
  readonly t: number;
  /** Percent in the processing pill; null when there is no pill. */
  readonly pct: number | null;
  readonly players: number;
  readonly lanes: number;
  readonly focus: string;
  readonly solo: string;
  readonly hidden: string;
  readonly toast: string;
  readonly done: boolean;
  readonly partialCue: string;
  readonly alert: string;
}

/** The timeline lanes read back from their canvas, every 400 ms. Fractions are of the timeline width. */
export interface LaneSample {
  readonly t: number;
  readonly pct: number | null;
  readonly lanes: number;
  /** Rightmost column in which any player lane has a bar. */
  readonly lastBar: number;
  /** Longest run of columns without any bar between the first and the last bar, in clip frames. */
  readonly maxGapFrames: number;
  readonly gapAt: number;
}

export interface LongTask {
  readonly t: number;
  readonly ms: number;
}

interface ProbeApi {
  log: LogEntry[];
  samples: Sample[];
  laneSamples: LaneSample[];
  longTasks: LongTask[];
  frameGaps: LongTask[];
  now(): number;
  lanes(): LaneSample | null;
  overlay(): { width: number; height: number; painted: number };
}

/**
 * Runs in the page before the app. It wraps `Worker` to record what each engine worker generation tells the page and
 * what the page tells it (the ticker worker of the stall supervisor is not an engine generation), samples the screen,
 * reads the lanes canvas, and records long main-thread tasks and late animation frames.
 */
function probeScript(): void {
  type Loose = Record<string, unknown>;
  const rec = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});
  const t0 = performance.now();
  const now = (): number => Math.round(performance.now() - t0);
  const log: Loose[] = [];
  const push = (entry: Loose): void => {
    if (log.length < 80_000) log.push({ t: now(), ...entry });
  };

  const Original = window.Worker;
  let generation = -1;
  class Probed extends Original {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const name = options?.name ?? '';
      if (name !== 'engine') {
        if (name !== 'skeletal-ticker') push({ k: 'other-worker', gen: -1, name });
        return;
      }
      generation++;
      const gen = generation;
      push({ k: 'spawn', gen });
      const send = this.postMessage.bind(this) as (message: unknown, options?: StructuredSerializeOptions) => void;
      this.postMessage = ((message: unknown, options?: StructuredSerializeOptions) => {
        const command = rec(message);
        if (typeof command.type === 'string' && command.type !== 'ack') {
          const entry: Loose = { k: 'command', gen, type: command.type };
          const opts = rec(command.options);
          if (command.type === 'init') entry.tierOverride = opts.tierOverride ?? null;
          if (command.type === 'start') entry.resume = opts.resume ?? false;
          push(entry);
        }
        send(message, options);
      }) as Worker['postMessage'];
      this.addEventListener('message', (message: MessageEvent) => {
        const d = rec(message.data);
        if (typeof d.type !== 'string') return;
        const entry: Loose = { k: d.type, gen };
        switch (d.type) {
          case 'progress': {
            const p = rec(d.progress);
            entry.stage = p.stage;
            entry.frames = p.framesDone;
            entry.of = p.framesTotal;
            break;
          }
          case 'state':
            entry.state = d.state;
            entry.previous = d.previous;
            break;
          case 'warning': {
            const warning = rec(d.warning);
            const detail = rec(warning.detail);
            entry.code = warning.code;
            entry.reason = detail.reason ?? null;
            entry.tier = detail.tier ?? null;
            entry.message = String(warning.message).slice(0, 200);
            break;
          }
          case 'error': {
            const error = rec(d.error);
            entry.code = error.code;
            entry.message = String(error.message).slice(0, 240);
            entry.detail = JSON.stringify(error.detail ?? null).slice(0, 400);
            break;
          }
          case 'reply':
            entry.id = d.requestId;
            entry.ok = d.ok;
            if (d.ok !== true) entry.code = rec(d.error).code;
            break;
          case 'chunk': {
            const batch = rec(d.batch);
            const pts = batch.ptsUs as ArrayLike<number> | undefined;
            entry.seq = d.seq;
            entry.replayed = d.replayed === true;
            entry.count = batch.count;
            if (pts && pts.length > 0) {
              entry.from = pts[0];
              entry.to = pts[pts.length - 1];
            }
            break;
          }
          case 'run-started':
            entry.fresh = d.fresh;
            entry.resumedFrames = d.resumedFrames;
            break;
          case 'ready':
            entry.tier = d.tier;
            entry.backend = d.backend;
            break;
          case 'opened':
            entry.frames = rec(d.clip).frameCount;
            entry.resume = JSON.stringify(d.resume ?? null);
            break;
          case 'final': {
            const result = rec(d.result);
            entry.frames = (rec(result.frames).ptsUs as ArrayLike<number> | undefined)?.length ?? null;
            entry.tracks = (result.tracks as unknown[] | undefined)?.length ?? null;
            entry.partial = JSON.stringify(rec(rec(result.header).extensions).partial ?? null);
            break;
          }
          default:
            break;
        }
        push(entry);
      });
      this.addEventListener('error', (event) =>
        push({ k: 'worker-error', gen, msg: String(event.message).slice(0, 160) }),
      );
    }
  }
  window.Worker = Probed;

  const longTasks: LongTask[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ t: Math.round(entry.startTime - t0), ms: Math.round(entry.duration) });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // no long-task timing in this browser: the frame gaps below still show a blocked main thread
  }
  const frameGaps: LongTask[] = [];
  let lastFrame = performance.now();
  const onFrame = (time: number): void => {
    if (time - lastFrame > 100) frameGaps.push({ t: Math.round(time - t0), ms: Math.round(time - lastFrame) });
    lastFrame = time;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

  const pillPercent = (): number | null => {
    const match = /(\d+)%/.exec(document.querySelector('[data-testid=processing-pill]')?.textContent ?? '');
    return match ? Number(match[1]) : null;
  };
  const RULER_H = 22;
  const LANE_H = 28;
  const lanes = (): LaneSample | null => {
    const canvas = document.querySelector<HTMLCanvasElement>('[role=slider][aria-label=Timeline] canvas');
    const slider = document.querySelector('[role=slider][aria-label=Timeline]');
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !slider || canvas.width === 0 || canvas.clientWidth === 0) return null;
    const dpr = canvas.width / canvas.clientWidth;
    const frames = Number(slider.getAttribute('aria-valuemax') ?? 0) + 1;
    const count = document.querySelectorAll('[data-testid=timeline-scroller] button[aria-label][aria-pressed]').length;
    const present = new Uint8Array(canvas.width);
    for (let row = 0; row < count; row++) {
      // 9 px into the lane: inside the bar, clear of the dashes of the part not reached yet and of the lane border
      const y = Math.round((RULER_H + row * LANE_H + 9) * dpr);
      if (y >= canvas.height) break;
      const data = context.getImageData(0, y, canvas.width, 1).data;
      for (let x = 0; x < canvas.width; x++) if ((data[x * 4 + 3] as number) > 8) present[x] = 1;
    }
    let first = -1;
    let last = -1;
    for (let x = 0; x < present.length; x++) {
      if (present[x] === 1) {
        if (first < 0) first = x;
        last = x;
      }
    }
    let maxGap = 0;
    let gapAt = 0;
    let run = 0;
    for (let x = Math.max(0, first); x <= last; x++) {
      if (present[x] === 1) run = 0;
      else {
        run++;
        if (run > maxGap) {
          maxGap = run;
          gapAt = x - run + 1;
        }
      }
    }
    const perColumn = frames / canvas.width;
    return {
      t: now(),
      pct: pillPercent(),
      lanes: count,
      lastBar: last < 0 ? 0 : (last + 1) / canvas.width,
      maxGapFrames: Math.round(maxGap * perColumn),
      gapAt: gapAt / canvas.width,
    };
  };
  const overlay = (): { width: number; height: number; painted: number } => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=video-stage] canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context || canvas.width === 0) return { width: 0, height: 0, painted: -1 };
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] as number) > 24) painted++;
    return { width: canvas.width, height: canvas.height, painted };
  };

  const samples: Sample[] = [];
  const laneSamples: LaneSample[] = [];
  let lastKey = '';
  const labelOf = (row: Element): string =>
    /(?:Hide|Show) (.+)$/.exec(row.querySelector('button:last-of-type')?.getAttribute('aria-label') ?? '')?.[1] ?? '?';
  setInterval(() => {
    const rows = [...document.querySelectorAll('ul[aria-label=Players] > li')];
    const pick = (test: (row: Element) => boolean): string => rows.filter(test).map(labelOf).join(',');
    const sample = {
      pct: pillPercent(),
      players: rows.length,
      lanes: document.querySelectorAll('[data-testid=timeline-scroller] button[aria-label][aria-pressed]').length,
      focus: pick((row) => row.querySelector('button')?.getAttribute('aria-pressed') === 'true'),
      solo: pick((row) => row.querySelectorAll('button')[1]?.getAttribute('aria-pressed') === 'true'),
      hidden: pick((row) => /^Show /.test(row.querySelector('button:last-of-type')?.getAttribute('aria-label') ?? '')),
      toast: [...document.querySelectorAll('[data-sonner-toast]')]
        .map((el) => (el.textContent ?? '').slice(0, 60))
        .join(' | '),
      done: [...document.querySelectorAll('[role=status]')].some((el) =>
        /Analysis complete/.test(el.textContent ?? ''),
      ),
      partialCue: document.querySelector('[data-testid=partial-cue]')?.textContent ?? '',
      alert: (document.querySelector('[role=alert] h1')?.textContent ?? '').slice(0, 80),
    };
    const key = JSON.stringify(sample);
    if (key !== lastKey && samples.length < 20_000) {
      lastKey = key;
      samples.push({ t: now(), ...sample });
    }
  }, 100);
  setInterval(() => {
    if (laneSamples.length >= 4000) return;
    const sample = lanes();
    if (sample) laneSamples.push(sample);
  }, 400);

  const api: ProbeApi = {
    log: log as unknown as LogEntry[],
    samples,
    laneSamples,
    longTasks,
    frameGaps,
    now,
    lanes,
    overlay,
  };
  (window as unknown as { __m4: ProbeApi }).__m4 = api;
}

export async function installProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(probeScript);
}

export interface ProbeDump {
  readonly log: LogEntry[];
  readonly samples: Sample[];
  readonly laneSamples: LaneSample[];
  readonly longTasks: LongTask[];
  readonly frameGaps: LongTask[];
  readonly now: number;
}

export function dumpProbe(page: Page): Promise<ProbeDump> {
  return page.evaluate(() => {
    const api = (window as unknown as { __m4: ProbeApi }).__m4;
    return {
      log: api.log,
      samples: api.samples,
      laneSamples: api.laneSamples,
      longTasks: api.longTasks,
      frameGaps: api.frameGaps,
      now: api.now(),
    };
  });
}

export const engineLog = (page: Page): Promise<LogEntry[]> =>
  page.evaluate(() => (window as unknown as { __m4: ProbeApi }).__m4.log);

export const pageNow = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __m4: ProbeApi }).__m4.now());

export const laneProbe = (page: Page): Promise<LaneSample | null> =>
  page.evaluate(() => (window as unknown as { __m4: ProbeApi }).__m4.lanes());

/** Pixels the overlay canvas has painted (alpha above a tenth): 0 means no skeleton, tag or ball is drawn. */
export const overlayPainted = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __m4: ProbeApi }).__m4.overlay().painted);

/** Waits until the engine log holds an entry that satisfies `test` (the log is read back every 200 ms). */
export async function waitForLog(
  page: Page,
  test: (entry: LogEntry) => boolean,
  timeoutMs: number,
  what: string,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await engineLog(page)).find(test);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await page.waitForTimeout(200);
  }
}

/** When `clickWhen` presses its button: at once, or when the engine log gets a matching entry. */
export type Trigger =
  | { readonly at: 'now' }
  | {
      readonly at: 'log';
      readonly k: string;
      readonly gen: number;
      readonly state?: string;
      /** For `progress` entries: fire once this many frames are reported. */
      readonly minFrames?: number;
    };

/**
 * Presses the first button whose text matches `pattern` (the source of a regular expression), from inside the page,
 * at the moment `trigger` fires (the log is checked every 4 ms, which a round trip from the test could not match).
 * Resolves with the page time of the click. The button must already be on screen, for example in an open dialog.
 */
export function clickWhen(page: Page, pattern: string, trigger: Trigger, timeoutMs = 120_000): Promise<number> {
  return page.evaluate(
    ({ pattern, trigger, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        const api = (window as unknown as { __m4: ProbeApi }).__m4;
        const started = performance.now();
        const press = (): void => {
          const wanted = new RegExp(pattern);
          const button = [...document.querySelectorAll('button')].find((b) =>
            wanted.test((b.textContent ?? '').trim()),
          );
          if (!button) {
            reject(new Error(`no button matching /${pattern}/ on screen`));
            return;
          }
          button.click();
          resolve(api.now());
        };
        if (trigger.at === 'now') {
          press();
          return;
        }
        let seen = 0;
        const timer = setInterval(() => {
          for (; seen < api.log.length; seen++) {
            const entry = api.log[seen] as LogEntry;
            if (
              entry.k === trigger.k &&
              entry.gen === trigger.gen &&
              (trigger.state === undefined || entry.state === trigger.state) &&
              (trigger.minFrames === undefined || (entry.frames as number) >= trigger.minFrames)
            ) {
              clearInterval(timer);
              press();
              return;
            }
          }
          if (performance.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`the trigger ${JSON.stringify(trigger)} did not fire in ${timeoutMs} ms`));
          }
        }, 4);
      }),
    { pattern, trigger, timeoutMs },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Faults injected into the built engine worker
// ---------------------------------------------------------------------------------------------------------------------

/** What one engine worker generation is made to do (generation 0 is the first worker of the page). */
export interface GenerationPlan {
  /** Block the worker thread for good right after it reports this many processed frames. */
  readonly stallAtFrames?: number;
  /** Throw the pipeline's own inference error from the n-th `process()` call (needs `routeInferenceFailure`). */
  readonly failAtCall?: number;
  /** With `failAtCall`: fail again after every later init of the same worker too (the count starts again). */
  readonly failRepeat?: boolean;
  /** Block the worker thread right after it reports the `finalizing` stage. */
  readonly hangFinalizing?: boolean;
}

/**
 * Prepended to the worker's entry chunk. A blocked thread is what a hang inside the inference runtime looks like from
 * the page: no message, no timer in the worker, only `terminate()` ends it.
 */
const PRELUDE = `(() => {
  const cfg = self.__m4cfg;
  const post = self.postMessage.bind(self);
  const block = () => {
    console.debug('__m4 worker gen ' + cfg.gen + ' blocks its thread');
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800000); }
    catch { const end = performance.now() + 1800000; while (performance.now() < end); }
  };
  let calls = 0;
  let spent = false;
  self.__m4fail = () => {
    calls++;
    if (spent || cfg.failAtCall == null || calls < cfg.failAtCall) return false;
    spent = !cfg.failRepeat;
    console.debug('__m4 worker gen ' + cfg.gen + ' fails process() call ' + calls);
    if (cfg.failRepeat) calls = 0;
    return true;
  };
  self.postMessage = (message, ...rest) => {
    post(message, ...rest);
    if (spent || !message || typeof message !== 'object' || message.type !== 'progress') return;
    const p = message.progress;
    if (cfg.stallAtFrames != null && p.stage === 'processing' && p.framesDone >= cfg.stallAtFrames) { spent = true; block(); }
    else if (cfg.hangFinalizing && p.stage === 'finalizing') { spent = true; block(); }
  };
})();
`;

export interface FaultLog {
  readonly entries: string[];
}

/**
 * Serves the engine worker's entry chunk with a prelude that carries out `plan(generation)`. Routing switches the
 * HTTP cache off, so every worker the client spawns fetches the entry again and gets the plan of its own generation.
 * The context must block service workers (they would answer from the precache).
 */
export async function routeEngineFaults(
  context: BrowserContext,
  plan: (generation: number) => GenerationPlan,
): Promise<FaultLog> {
  const entries: string[] = [];
  let generation = 0;
  await context.route(/\/assets\/engine-worker-[^/]*\.js(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const cfg = { gen: generation, ...plan(generation) };
    generation++;
    entries.push(`entry ${JSON.stringify(cfg)}`);
    const body = `self.__m4cfg=${JSON.stringify(cfg)};${PRELUDE}${await response.text()}`;
    await route.fulfill({ response, body });
  });
  return { entries };
}

/**
 * Makes `FramePipeline.process()` in the built ML chunk throw the pipeline's own `InferenceError` when the prelude
 * says so (`failAtCall`). The two names it needs are minified, so they are found by shape; the route reports in
 * `log.entries` whether the patch applied, and a test must check that.
 */
export async function routeInferenceFailure(context: BrowserContext, log: FaultLog): Promise<void> {
  await context.route(/\/assets\/ml-[^/]*\.js(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    const errorClass = /var (\w+)=class extends Error\{code=`inference-failed`/.exec(text)?.[1];
    const head = /async process\((\w+)\)\{(?=let \w+=new \w+,\w+=this\.turns\.reserve\(\))/.exec(text);
    if (!errorClass || !head) {
      log.entries.push('ml patch NOT APPLIED: the shape of the built chunk changed');
      await route.fulfill({ response, body: text });
      return;
    }
    const inject = `${head[0]}if(self.__m4fail&&self.__m4fail())throw new ${errorClass}("detector",new Error("m4: injected inference failure"));`;
    log.entries.push(`ml patch applied (error class ${errorClass})`);
    await route.fulfill({ response, body: text.replace(head[0], inject) });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Driving the UI
// ---------------------------------------------------------------------------------------------------------------------

export const pillPercent = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const match = /(\d+)%/.exec(document.querySelector('[data-testid=processing-pill]')?.textContent ?? '');
    return match ? Number(match[1]) : null;
  });

export async function waitPercent(page: Page, atLeast: number, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const percent = await pillPercent(page);
    if (percent !== null && percent >= atLeast) return percent;
    if (Date.now() > deadline)
      throw new Error(`the pill did not reach ${atLeast}% in ${timeoutMs} ms (last ${percent})`);
    await page.waitForTimeout(100);
  }
}

export async function openClip(page: Page, file: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('file-input').waitFor({ state: 'attached', timeout: 60_000 });
  await page.getByTestId('file-input').setInputFiles(file);
}

export async function waitComplete(page: Page, timeoutMs = 300_000): Promise<void> {
  await page
    .getByRole('status')
    .filter({ hasText: /Analysis complete/ })
    .waitFor({ state: 'attached', timeout: timeoutMs });
}

export interface PlayerRow {
  readonly label: string;
  readonly focused: boolean;
  readonly solo: boolean;
  readonly hidden: boolean;
  /** CSS colour of the identity dot. */
  readonly colour: string;
}

export function playerRows(page: Page): Promise<PlayerRow[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('ul[aria-label=Players] > li')].map((row) => {
      const buttons = row.querySelectorAll('button');
      const hideLabel = buttons[buttons.length - 1]?.getAttribute('aria-label') ?? '';
      const dot = row.querySelector<HTMLElement>('span[aria-hidden][style]');
      return {
        label: /(?:Hide|Show) (.+)$/.exec(hideLabel)?.[1] ?? '?',
        focused: buttons[0]?.getAttribute('aria-pressed') === 'true',
        solo: buttons[1]?.getAttribute('aria-pressed') === 'true',
        hidden: hideLabel.startsWith('Show '),
        colour: dot ? getComputedStyle(dot).backgroundColor : '',
      };
    }),
  );
}

/** Row of the Players list for `label` (P3, ...). */
export const playerRow = (page: Page, label: string) =>
  page
    .locator('ul[aria-label=Players] > li')
    .filter({ has: page.getByRole('button', { name: `Hide ${label}`, exact: true }) });

export async function focusPlayer(page: Page, label: string): Promise<void> {
  await playerRow(page, label).locator('button').first().click();
}

export async function soloPlayer(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: `Show only ${label}`, exact: true }).click();
}

export async function hidePlayer(page: Page, label: string): Promise<void> {
  await page
    .locator('ul[aria-label=Players]')
    .getByRole('button', { name: `Hide ${label}`, exact: true })
    .click();
}

export interface SliderState {
  readonly frame: number;
  readonly frames: number;
  readonly text: string;
}

export function sliderState(page: Page): Promise<SliderState> {
  return page.evaluate(() => {
    const slider = document.querySelector('[role=slider][aria-label=Timeline]');
    return {
      frame: Number(slider?.getAttribute('aria-valuenow') ?? -1),
      frames: Number(slider?.getAttribute('aria-valuemax') ?? -1) + 1,
      text: slider?.getAttribute('aria-valuetext') ?? '',
    };
  });
}

/** Seeks the paused player to a frame index with the timeline's own keys, and waits until the frame is shown. */
export async function seekToFrame(page: Page, frame: number): Promise<SliderState> {
  const slider = page.getByRole('slider', { name: 'Timeline' });
  await slider.focus();
  const { frames } = await sliderState(page);
  const target = Math.max(0, Math.min(frames - 1, Math.round(frame)));
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = (await sliderState(page)).frame;
    let delta = target - current;
    if (delta === 0) break;
    if (current > target && target < current / 2) {
      await page.keyboard.press('Home');
      delta = target;
    }
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    const big = Math.floor(Math.abs(delta) / 10);
    for (let i = 0; i < big; i++) await page.keyboard.press(`Shift+${key}`);
    for (let i = 0; i < Math.abs(delta) % 10; i++) await page.keyboard.press(key);
    await page
      .waitForFunction(
        (want) =>
          Number(document.querySelector('[role=slider][aria-label=Timeline]')?.getAttribute('aria-valuenow')) === want,
        target,
        { timeout: 8000 },
      )
      .catch(() => undefined);
  }
  await page.waitForTimeout(350);
  return sliderState(page);
}

/** Index of the frame shown at `seconds` (the last frame that starts at or before it), from the clip goldens. */
export function frameAt(ptsUs: readonly number[], seconds: number): number {
  const us = Math.round(seconds * 1e6);
  let index = 0;
  for (let i = 0; i < ptsUs.length; i++) {
    if ((ptsUs[i] as number) <= us) index = i;
    else break;
  }
  return index;
}

export async function selectTab(page: Page, name: 'Players' | 'Layers' | 'Data'): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click();
}

export async function setLayer(page: Page, name: string, on: boolean): Promise<void> {
  const toggle = page.getByRole('button', { name, exact: true });
  if (((await toggle.getAttribute('aria-pressed')) === 'true') !== on) await toggle.click();
}

export const toastText = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.textContent ?? '').join(' | '),
  );

/** Notes listed in the clip's Data panel (the tab must be showing). */
export const dataNotes = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll('ul[aria-label=Notes] > li')].map((el) => el.textContent ?? ''));

// ---------------------------------------------------------------------------------------------------------------------
// Reading exports
// ---------------------------------------------------------------------------------------------------------------------

export interface ExportedTrack {
  readonly id: number;
  readonly label: string;
  readonly colorSlot: number;
  readonly firstPtsUs: number;
  readonly lastPtsUs: number;
  readonly samples: {
    readonly ptsUs: number[];
    readonly box: number[];
    readonly kp: number[];
    readonly kpFlags: number[];
    readonly sampleFlags: number[];
  };
}

export interface ExportedPoseTrack {
  readonly clip: { readonly frameCount: number; readonly displayWidth: number; readonly displayHeight: number };
  readonly processing: {
    readonly elapsedMs: number;
    readonly settings: { readonly tier: string; readonly backend: string };
    readonly device: { readonly tier: string; readonly backend: string };
  };
  readonly frames: { readonly ptsUs: number[]; readonly flags: number[] };
  readonly tracks: ExportedTrack[];
  readonly ball?: {
    readonly samples: {
      readonly ptsUs: number[];
      readonly xy: number[];
      readonly radius: number[];
      readonly confidence: number[];
      /** 0 none, 1 measured, 2 inferred. */
      readonly visibility: number[];
      readonly source: number[];
    };
  };
  readonly extensions?: {
    readonly partial?: { analysedFrames: number; plannedFrames: number; analysedUntilUs: number };
  };
}

export const readPoseTrack = (file: string): ExportedPoseTrack =>
  JSON.parse(readFileSync(file, 'utf8')) as ExportedPoseTrack;

export const FLAG_PROCESSED = 1;
export const FLAG_SKIPPED = 8;

export interface Completeness {
  readonly frames: number;
  readonly processed: number;
  readonly skipped: number;
  readonly tracks: number;
  readonly tier: string;
  readonly backend: string;
  readonly partial: boolean;
  /** Longest stretch of frames in which no track has a sample, in frames. */
  readonly longestEmptyFrames: number;
}

export function completeness(result: ExportedPoseTrack): Completeness {
  const { flags, ptsUs } = result.frames;
  const index = new Map(ptsUs.map((pts, i) => [pts, i]));
  const covered = new Uint8Array(ptsUs.length);
  for (const track of result.tracks) {
    for (const pts of track.samples.ptsUs) {
      const i = index.get(pts);
      if (i !== undefined) covered[i] = 1;
    }
  }
  let longest = 0;
  let run = 0;
  for (const c of covered) {
    run = c === 1 ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return {
    frames: ptsUs.length,
    processed: flags.filter((f) => (f & FLAG_PROCESSED) !== 0).length,
    skipped: flags.filter((f) => (f & FLAG_SKIPPED) !== 0).length,
    tracks: result.tracks.length,
    tier: result.processing.device.tier,
    backend: result.processing.device.backend,
    partial: result.extensions?.partial !== undefined,
    longestEmptyFrames: longest,
  };
}
