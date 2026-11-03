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
3. `start`: the frame loop pulls decoded frames (at most 4 open, at most 2 in flight on the pipeline), runs the ML
   pipeline per the tier cadence, and packs results into `PackedFrameBatch` chunks of at most 0.5 s of media. Each chunk
   is written to OPFS first, then posted with a transfer list; the main thread acknowledges, and at most 4 chunks may be
   unacknowledged.
4. `finalize` reads every chunk back from the store (so a resumed run and an uninterrupted run finalise from identical
   input), writes `posetrack.json` and emits `final`.

All timestamps are integer presentation microseconds (`ptsUs`); parameters are in seconds.

## Failure handling

Every failure is mapped to an `errors.ts` code. A frame without a result after 10x the median latency (floor 5 s)
fails with `inference-timeout`. That watchdog runs in the worker, so it cannot see a worker whose thread is blocked
inside the inference runtime (M2-1); the client therefore also supervises a processing worker: no message for
max(12 s, 10x the usual gap) is a stall. A stall, a worker-reported `inference-timeout` and a failed WebGPU inference
(`inference-failed` on a WebGPU tier, e.g. Firefox M2-10) restart the worker one tier down (stall: next tier of the
ladder; failed WebGPU inference: the CPU tier), resume from the saved chunks and emit a `slow-mode` warning whose
`detail.reason` is `stalled` or `gpu-inference-failed`. On the slowest tier the failure is final and reaches the UI as an
error. `device.lost` becomes `gpu-lost`; the client swallows it, restarts the worker and
resumes from the saved chunks. A second loss within 60 s moves to a CPU tier and emits a `slow-mode` warning.
Runtime error text never reaches `message`; it is kept in `detail.reason`.
Frames in flight: `MAX_IN_FLIGHT` is per backend (WebGPU 1 until the pipeline's shared GPU buffers are concurrency-safe,
WASM 2); `EngineDeps.maxInFlight` overrides it.
A 404 or HTML fallback for a model is `model-download`; a hash mismatch is `model-integrity` (cache entry deleted,
one retry).

## Testing

- `npx vitest run --project unit src/engine`: pure parts (frame table, packing, ETA, fingerprint, CSV, routing).
- `PORT=5182 npx vitest run --project browser src/engine`: workers, OPFS, WebCodecs, WebGPU, all 11 repository clips.
- Fault injection lives in `testing/stub-ml.ts` (`failAtPtsUs`, `rawFailAtPtsUs`, `loseDeviceAtPtsUs`, `hangAtPtsUs`, `blockAtPtsUs`, `blockWhenConcurrent`) and
  `testing/stub-runtime.ts` (`loseDeviceAfterMs`).
