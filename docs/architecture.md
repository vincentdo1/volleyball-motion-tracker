# Skeletal: web app architecture

Skeletal, the web app in `web/`, turns an uploaded volleyball clip into tracked, smoothed 2D skeletons for every person
on screen plus the ball, entirely in the browser. Nothing is uploaded; there is no server compute. The phase-one Python
package (`src/volleyball_tracker/`) remains the reference for the domain logic.

## Pipeline
```
File ──> engine worker ──────────────────────────────────────────────────────────────> main thread
         mediabunny demux + WebCodecs decode (frame table keyed by PTS in microseconds)
         per frame: GPU resize ─> D-FINE person detector ─> RTMPose (all people in one batch)
                    every 9 frames: VballNet ball heatmaps
         online tracker (ByteTrack + OC-SORT style, parameters in seconds)
         streamed raw results ──────────────────────────────────────────────────────> overlay while processing
         finalize: stitch tracks, fix left/right swaps, Kalman + RTS smoothing, ball trajectory
         final PoseTrack result ────────────────────────────────────────────────────> player, timeline, export
```
- Inference: onnxruntime-web 1.31.1 on WebGPU (fp16 models), falling back to multi-threaded WebAssembly.
- Rendering: Canvas2D overlay on a native `<video>`, synchronised with `requestVideoFrameCallback`.
- Export: MP4 with the overlay (WebCodecs H.264, audio copied), PNG frame, JSON (PoseTrack v1), CSV.
- Results and progress are stored in the browser (OPFS) so an interrupted run can resume.
- The main thread supervises the worker. Silence is measured in awake time, so a sleeping laptop or a frozen tab is not
  a hang. A stalled run restarts and resumes, and a run that stalls again steps down one device tier. A GPU that cannot
  run the models steps down to the CPU tier with a notice; the user only sees plain-language messages.

## Device tiers
| Tier | When | Detector -> pose |
|---|---|---|
| Standard | WebGPU with 16-bit float shaders | D-FINE-S 640 fp16 -> RTMPose-m fp16 |
| Quality (opt-in) | same devices | D-FINE-M 640 fp16 -> RTMPose-m fp16 |
| Lite | phones, weak GPUs | D-FINE-S 640 fp16 -> RTMPose-s fp16 |
| Compatibility | WebGPU without fp16 | D-FINE-S 640 fp32 -> RTMPose-s fp32 |
| CPU | no usable WebGPU | D-FINE-S 480 fp32 -> RTMPose-s fp32, detector every 3rd frame |

## Code layout
| Path | Purpose |
|---|---|
| `web/src/contracts/` | Shared types and schemas: PoseTrack v1 (`posetrack.schema.json`), Halpe26 topology, worker protocol, errors, model registry, device tiers, renderer and pipeline interfaces |
| `web/src/engine/` | Engine worker: ingest, decode, scheduling, inference sessions, persistence, export |
| `web/src/ml/` | Model pre/post-processing, tracking, smoothing, ball trajectory |
| `web/src/render/`, `web/src/app/`, `web/src/ui/` | Overlay renderer and the user interface |
| `web/tests/` | End-to-end tests, accuracy harness, fixtures |
| `web/models.lock.json` | Pinned model files (URL, SHA-256, size, license, conversion recipe) |
| `deploy/` | Cloudflare Workers + R2 hosting scaffold |

## Data format
PoseTrack v1 JSON: clip metadata (codec, rotation, display size), a frame table of presentation timestamps in
microseconds, one entry per track with columnar samples (box, 26 keypoints with scores, per-joint flags such as
interpolated or low confidence), a ball track with per-frame visibility, the models and settings used, and an
`extensions` object for future data. Coordinates are display pixels after rotation.

## Hosting
Static files on Cloudflare Workers Static Assets; models and the onnxruntime wasm (over the 25 MiB asset limit) from
R2 through the same Worker. Every response carries `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so the page is cross-origin isolated. See `deploy/README.md`.

## Licensing
MIT for this project. Shipped weights and libraries are Apache-2.0, MIT, BSD or ISC, plus MPL-2.0 (mediabunny) and
OFL-1.1 (Geist fonts). See `THIRD_PARTY_NOTICES.md`.
