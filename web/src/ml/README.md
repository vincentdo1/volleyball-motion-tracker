# ML module (`web/src/ml/`)

Per-frame inference, the online tracker and the offline post-pass, exposed as `mlModule` (`index.ts`, the `MlModule`
contract in `@/contracts/pipeline`). The engine owns I/O, decoding, sessions and scheduling; this module owns what happens
to a frame. Results are keyed by PTS in integer microseconds. Every time constant is in seconds, every rate per second;
nothing counts frames.

## Layout
| Path | What |
|---|---|
| `geometry.ts` | IoU, NMS, MMPose crop (`bboxToCS`), OKS and OKS-NMS (smaller-box OKS), box from keypoints, cadence `propagate` |
| `preprocess/cpu.ts`, `preprocess/gpu.ts`, `preprocess/wgsl/` | Rotation-aware sampler (CPU reference, also the WASM and Node path) and its WGSL port (stretch, batched affine crops, gray 512x288), external `VideoFrame` textures, zero-copy into ORT |
| `models/` | Adapters: D-FINE-S (prepare + decode), RTMPose-m Halpe26 (crop buckets 1/2/4/8/12/16/24/32, SimCC decode), VballNetV4c (9-frame gray clip, blob decode) |
| `pipeline/` | `createFramePipeline`: detector, one batched pose call per frame, OKS-NMS, propagated boxes between detector frames, ball ring with delayed results, per-stage timings, `warmup()`. `process()` may be called again before the previous call settles: frames are opened (decoded, read back) in parallel but run through the models one at a time in call order (`turns.ts`; concurrent ORT WebGPU runs on shared input buffers deadlock). A runtime rejection of a model run becomes an `InferenceError` (`session-run.ts`: code `inference-failed`, plain message, ORT text only in `detail.runtime`) so the engine can step down to the WASM tier |
| `tracking/` | Online tracker: ByteTrack two-pass, OC-SORT ORU/OCM, expanded-IoU rounds, OKS term, per-axis Kalman with PTS dt |
| `postprocess/` | `finalize()`: duplicate merge, stitching, short-track drop, static-object drop (net posts: a track that never moves and whose skeleton never fits), renumbering, L/R swap repair, Kalman + RTS smoothing with gap fill, ball trajectory |
| `settings.ts` | `defaultSettings(tier)`: the plan's initial parameters plus the tuned values below |
| `session-options.ts` | `sessionOptions(role, backend)` |
| `harness/` | Dev-only runners (below) |

## Parameters and their units
All live in `ProcessingSettings` (`@/contracts/params`); tuned overrides are in `settings.ts`.
- Detector: `scoreThreshold` 0.3 (pose), `trackerLowScore` 0.15, `nmsIou` 0.7, `minBoxHeightPx` 8 px, `cadence` (every n-th processed frame).
- Pose: `oksNms` (tuned 0.9, plan 0.6), `visibilityThreshold` 0.3.
- Tracker: `highScore`/`newTrackScore` (tuned 0.45/0.45, plan 0.5/0.6), `lowScore` 0.15, `matchCostMax` 0.8 (unitless cost),
  `lostTtlS` 1.0 s, `confirmHits` 3 within `confirmWindowS` 0.2 s (window never shorter than `confirmHits` update
  intervals), `eiouExpansions` (box growth factors), `costWeights`, `ocmWeight`, `stitchMaxGapS` 1.0 s,
  `minTrackDurationS` 0.5 s, `duplicateOks` 0.5, `duplicateOverlapFrac` 0.5. Constants private to a module are
  documented where they are declared (Kalman noise in box heights per second squared, birth-overlap IoU, ...).
- Smoothing: `measurementSigmaBoxFrac` (fraction of box height at score 1), `accelSigma` per joint group in box heights
  per second squared, `gateSigma` (standard deviations), `maxGapFillS` 0.3 s, `lowConfidenceScore` 0.3, `swapRepairGain`.
- Ball: all gates and fills in seconds or fractions of L = max(display width, height); see `BallParams`.

## Running things (from `web/`)
- Unit tests: `npm test`. Browser tests (WGSL parity with the CPU reference, zero-copy): `PORT=5181 npm run test:browser`.
- Node reference accuracy on the 277 bake-off frames (onnxruntime-node CPU, fp32):
  `VBT_RUN_NAME=node-fp32 VBT_ML_RUNS_DIR=<dir> npm run test:harness -- src/ml/harness/static`, then score with the bake-off
  `node/evaluate.mjs`. Other environment: `VBT_FRAMES_DIR`, `VBT_BAKEOFF_DIR`, `VBT_DETECTOR`, `VBT_POSE`, `VBT_OKS_NMS`, `VBT_LIMIT`.
- Browser pipeline bench (Chrome for Testing, real WebGPU or WASM):
  `PORT=5181 node scripts/ml/run-bench.mjs --tier webgpu-default --set static|run --name <label>`; agreement between two
  runs: `VBT_BAKEOFF_TOOLS=<dir> node scripts/ml/paired-oks.mjs <reference.json> <candidate.json>`.
- Tracking and smoothing on the three 60-frame runs: `VBT_RUN_NAME=<name> VBT_ML_RUNS_DIR=<dir> npm run test:harness -- src/ml/harness/runs`
  (writes `<name>-raw.json` and `<name>-smooth.json`; `VBT_TRACKER` takes a JSON of tracker overrides, `VBT_SMOOTH_ACCEL` scales the
  acceleration noise), score with `evaluate.mjs --frames run` and
  `VBT_BAKEOFF_TOOLS=<dir> node scripts/ml/score-tracks.mjs <teacher.json> <frames_meta.json> <preds.json>...` (ID switches).
- Whole-clip tracking and finalize from raw detections (what the app exports, without a browser): dump every frame with
  `VBT_CLIP=<file in test_videos/> VBT_FRAMES=100000 VBT_DETECTOR=dfine-s-coco.fp16 VBT_POSE=rtmpose-m-halpe26.fp16 VBT_OUT=<dir>/<clip>.json npm run test:harness -- src/ml/harness/clip-boxes`
  (the default tier's models; about 0.3 s per frame on CPU), then
  `VBT_RAW_DIR=<dumps> VBT_OUT_DIR=<out> npm run test:harness -- src/ml/harness/clip-tracks` (`VBT_TRACKER`, `VBT_SMOOTH_ACCEL`,
  `VBT_ONLY` as above) writes app-export-shaped `posetrack.json` files that `tests/tools/m2-to-bench.mjs`, `score.ts` and
  `m2-score-tracks.ts` score. It reproduces the app's exported numbers closely, so tracker and finalize parameters can be tuned offline.
- Person detections of the first frames of a test video (for building tracking ground truth):
  `VBT_CLIP=<file in test_videos/> VBT_FRAMES=301 VBT_OUT=<json> npm run test:harness -- src/ml/harness/clip-boxes`.
- Oracles for the geometry and pre-processing tests: `VBT_BAKEOFF_TOOLS=<dir> node scripts/ml/make-oracles.mjs`.

## Measured after the M2 fix round (in the app, production build, WebGPU Standard tier, 11 clips)
- Static set recall 0.845 -> 0.845 (0.814 while the teacher still lists the two beach net posts as persons), PCK@0.05 0.949; run set
  recall 0.886 -> 0.886 with the posts ignored in the labels (0.805 with them), FP/frame 0.006; unmatched predictions per frame
  1.15 -> 0.18 (run) and 0.64 -> 0.35 (static). The beach clip no longer has skeletons on the posts (10 -> 7 tracks).
- Raw -> finalized recall gap (1.3-1.9 points) is made of detections scoring 0.3-0.45 that cannot be told from false ones (83 true
  against 259 false in that band); every way of recovering them tried (lower birth score, skeleton-gated births, gap claims,
  track-end extension, reacquiring lost tracks) bought under one point at two to ten times the false positives or worse ids.
- Crowds: gtu keeps 59 ids (62 before) with IDF1 0.842 on the 10 s labels; the remaining switches are players who overlap and exchange
  ids, which position and size cannot resolve (checked offline with a crossing repair: motion agreed with the tracker at every
  encounter). A second look needs an appearance cue from pixels, which the `RawPerson` contract does not carry.

## Measured (see the work-order progress notes for the full tables)
- Node fp32, 110 static frames: recall 0.866, matched PCK@0.05 0.960, 0.155 false positives per frame. Without OKS-NMS the port reproduces the bake-off Node row.
- Browser WebGPU fp16 with GPU pre-processing: static recall 0.875, runs 0.905, median 30 ms/frame (static) on the M5 Pro; paired OKS against Node fp32 0.991.
- Runs (gtu, px330, beach), smoothed against raw: torso acceleration 0.17-0.31 against 0.81-1.48 (% box height per frame squared),
  mean OKS against the teacher 0.931 (raw 0.931), 0.011 false positives per frame.
