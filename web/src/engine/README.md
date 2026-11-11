# Engine

The in-browser processing engine: it turns a `File` into streamed, persisted pose tracks behind the typed protocol in
`src/contracts/protocol.ts`. The UI only sees `createEngine(): EngineApi` (`client.ts`).

## Layout

| Path | Role |
| --- | --- |
| `client.ts` | `createEngine()`: owns the worker, request/reply correlation, chunk acks, exports, GPU-loss restart + resume |
| `engine.worker.ts` | Production worker entry (ORT runtime + ML module from `ml-loader.ts`) |
| `core/` | `EngineCore` (command dispatch), state machine, settings merge, runtime provider interface |
| `capabilities/` | Feature detection and static tier selection (also used by `selftest/`) |
| `runtime/` | ORT loader per flavour, session factory, model manager (lock, streamed fetch, SHA-256, `vbt-models-v1`) |
| `ingest/` | mediabunny `openClip`: `ClipMetadata`, frame table (presentable PTS >= 0, integer us), fingerprint |
| `process/` | Pull-based decode loop, scheduler (cadence/stride), watchdog, batch packer, streamer, finalisation |
| `store/` | OPFS session store (10 s chunks + manifest), chunk codec, idb-keyval session index |
| `export/` | JSON, CSV and the MP4 export worker (decode, render, H.264, mux, audio copied) |
| `sw/` | Service worker source for vite-plugin-pwa `injectManifest` (offline app shell, ORT runtime cache) |
| `testing/` | Stub ML module, stub runtime, stub worker and in-page core for tests |
| `dev/` | `harness.html` + `window.__engineHarness` for Playwright |

## Data flow

1. `init`: capability detection, tier, models (verified, cached), ORT sessions, warm-up. `ready`.
2. `open`: container probe, frame table, fingerprint, saved-session lookup. `opened` (with `resume` when a session
   with identical settings exists).
3. `start`: the frame loop pulls decoded frames (at most 4 open, at most `MAX_IN_FLIGHT` in flight on the pipeline), runs the ML
   pipeline per the tier cadence, and packs results into `PackedFrameBatch` chunks of at most 0.5 s of media. Each chunk
   is written to OPFS first, then posted with a transfer list; the main thread acknowledges, and at most 4 chunks may be
   unacknowledged. `start({ resume: true })` on a saved, incomplete session first re-emits the stored batches (`chunk`
   events with `replayed: true`, in stream order, through the same ack window, each a private copy so the transfer
   cannot detach the store) and then continues the seq numbering, so a `seq` is the batch's position in the stream
   of the run that is announced by `run-started`. A complete saved session skips the replay: `final` follows at once
   and carries everything.

   **Run identity.** Every `ProcessingRun` emits `run-started { fresh, resumedFrames }` once, before any chunk, for
   `start()` and for each restart the client makes itself (stall, lost GPU, failed inference). `fresh: true` (resumedFrames
   0): the stream starts from the beginning with seq 0 and new track ids, so a consumer drops the streamed results,
   applied seqs and progress it holds. `fresh: false`: the stored windows are replayed under their original seq
   (`replayed` chunks) and the stream continues after them; the redone open window carries the same batches as before,
   so a consumer may ignore a seq it already holds. A same-tier restart resumes; a tier step-down changes the settings
   hash (tier and backend are in it), drops the stored windows and starts fresh from frame 0 (mixing tiers inside one
   result is out of scope). A seq that repeats after a `fresh` run-started is NOT the same batch as before.
4. `finalize` reads every chunk back from the store (so a resumed run and an uninterrupted run finalise from identical
   input), writes `posetrack.json` and emits `final`. It reports a `progress` with `stage: 'finalizing'` first: that is
   the start of the client's ceiling for the step (see Failure handling).
5. `cancel`, then `partialResult()`: in state `opened` after a cancel the engine finalizes the analysed part once
   (`finalizeResult` over the stored chunks, `header.extensions.partial`), caches it in the run, emits a copy as `final`
   and replies; the client resolves with it, or with null when nothing was analysed or the result was discarded (another
   clip was opened). The partial JSON, CSV and MP4 exports are made from the same cached result, so the view the UI
   shows and every export share track ids and colour slots.

All timestamps are integer presentation microseconds (`ptsUs`); parameters are in seconds.

## Failure handling

Every failure is mapped to an `errors.ts` code. A frame without a result after 10x the median latency (floor 5 s; 30 s
for the first frame after a start, which can compile shaders) fails with `inference-timeout`. That watchdog runs in the
worker, so it cannot see a worker whose thread is blocked inside the inference runtime (M2-1); the client therefore also
supervises a processing worker: no progress report for max(12 s, 10x the usual gap) (30 s before the first one) is a
stall.

Both supervisors only count time in which their own thread ran (`AwakeMeter`, `process/watchdog.ts`): a poll that comes
in more than two polls late (the machine slept, the tab was frozen, the thread was blocked) counts for two polls, and
only the monotonic clock is read, so neither a suspend nor a wall-clock jump can pass for a stall (M2-16: a laptop that
slept mid-run was restarted on the CPU tier for good).

Why a hung worker is always seen (M3 review of the blind spots):
- Main-thread timer throttling (hidden tab: 1 Hz, then once a minute): the supervisor is clocked by a worker timer
  (`process/ticker.ts`), whose ticks arrive as messages and are not throttled. With a main-thread `setInterval` a worker
  that hung while the tab was hidden took limit/2 minutes to be seen (late ticks count two polls), which matches the
  340 s run once seen at 85 %. The ticker falls back to `setInterval` where a blob worker is not available.
- A late tick after a suspend or freeze counts two polls only (M2-16): the worker was suspended with the page. The
  silence before the suspend counts in full and a worker that hangs after waking is seen one limit later.
- `heard()` resets the meter on any message except `stats`, the diagnostics heartbeat that a worker with a stuck pipeline
  keeps sending from its own timer. The other events (`state`, `reply`, `chunk`, `warning`, `progress`) are one-off
  consequences of work done, so a worker that sends them is not blocked; a live worker that stops finishing frames is
  caught by the in-worker per-frame watchdog (inference) and, for a decoder that never answers, by the missing
  progress reports (no `stats` in production builds).
- `finalizing` has a ceiling instead of a silence limit (smoothing a long clip is one long, silent computation, and a
  restart would only redo it): an awake-time ceiling of 60 s plus 2 s per second of the clip (`FINALIZE_FLOOR_MS`, `FINALIZE_MS_PER_CLIP_SECOND` in `client.ts`) counted from the `finalizing` state. On expiry the
  client aborts the worker with `worker-crashed` ("Finishing the analysis took too long.") so the engine leaves
  `finalizing` and a discard or a new clip is not blocked. `paused`/`opened` need no supervision (nothing is pending).
- The ticker worker is named `skeletal-ticker` (`TICKER_WORKER_NAME`; the engine worker is `engine`): a harness that
  counts worker generations must count only the engine workers.

A stall or a worker-reported `inference-timeout` restarts the worker on the same tier the first time in a run, without a
notice, and resumes from the saved chunks; a stall after that steps one tier down the ladder (a step-down restarts the
analysis from frame 0, see run identity). Every restart pins the tier the failed worker ran on (`plan.tier ?? ready.tier`),
so a same-tier recovery never retries a GPU tier that just failed. A failed WebGPU inference (`inference-failed` on a
WebGPU tier, e.g. Firefox M2-10) mid-run steps down to the CPU tier. When the first (warm-up) inference of `init` fails
on a WebGPU tier, the worker only reports `inference-failed` with `detail { phase: 'warmup', tier, backend,
crossOriginIsolated }` (any other failure keeps its own code and is not read as a GPU failure) and the client terminates
the worker, which releases the whole WebGPU onnxruntime instance, pins `initOptions.tierOverride` to the CPU tier below
and initialises a fresh worker, then emits the `slow-mode` notice (`detail.reason: 'gpu-inference-failed'`; its text does
not mention a clip, because it happens at app start). Later recoveries stay on that CPU tier. A re-init from `failed` in
one worker releases the sessions the failed engine still held. Every error that leaves the worker is a plain object (`plainEngineError`): structured clone keeps only the name and message of an `Error`, so an `Error` subclass that carries `code` would arrive without it. A step-down emits a `slow-mode`
warning whose `detail.reason` is `stalled` or `gpu-inference-failed`. On the slowest tier the second stall is final and
reaches the UI as an error. `device.lost` becomes `gpu-lost`; the client swallows it, restarts the worker and
resumes from the saved chunks. A second loss within 60 s moves to a CPU tier and emits a `slow-mode` warning.
`cancel()` while the client recovers wins: it is recorded, the recovery stops before it reopens the clip or restarts the
run (or cancels the run it had just restarted), `startOptions` is cleared so nothing restarts later, and the call
resolves once the engine is `opened` (`ready` when the clip was never reopened). With no worker at all it rejects with
`invalid-state`.
Runtime error text never reaches `message`; it is kept in `detail.reason`.
A worker global runs one `EngineCore` (`startEngineWorker` marks it): WebKit evaluates a worker entry again when a chunk
imports it by URL, and the second evaluation must not start a second core.
Frames in flight: `MAX_IN_FLIGHT` is per backend (WebGPU 1, WASM 2); `EngineDeps.maxInFlight` overrides it. The WebGPU
pipeline serializes its model runs, so 2 would be safe, but it is not faster (gtu: 46.4 s with 1, 46.2 s with 2).
A 404 or HTML fallback for a model is `model-download`; a hash mismatch is `model-integrity` (cache entry deleted,
one retry).

Finalize measurements (real engine and models, Chrome for Testing, `webgpu-default`, state `finalizing` to `done`, which
includes the store reads, `finalizeResult` and the write of `posetrack.json`, 2026-11-10): gtu (33.1 s, 991 frames,
1080p) 0.70 s; the same clip looped five times (165.4 s, 4955 frames) 12.9 s. Time grows about with clip length to the
power 1.8 on these. The ceiling is 126 s for gtu (180x) and 390 s for the 165 s clip (30x); extrapolated, it stays at least
5x above the finalize time up to a clip of about 20 minutes. It is deliberately generous: a false timeout throws away a
long analysis, a missed hang only costs the wait.

## Testing

- `npx vitest run --project unit src/engine`: pure parts (frame table, packing, ETA, fingerprint, CSV, routing).
- `PORT=5182 npx vitest run --project browser src/engine`: workers, OPFS, WebCodecs, WebGPU, all 11 repository clips.
- Fault injection lives in `testing/stub-ml.ts` (`failAtPtsUs`, `rawFailAtPtsUs`, `loseDeviceAtPtsUs`, `hangAtPtsUs`, `blockAtPtsUs`, `blockWhenConcurrent`, `coldDelayMs`, `failWarmupOnWebgpu`, `blockFinalize`, `onFinalize`) and
  `testing/stub-runtime.ts` (`loseDeviceAfterMs`, `onLifecycle`).
