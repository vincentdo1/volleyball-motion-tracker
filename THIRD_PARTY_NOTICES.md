# Third-party notices

The web app in `web/` ships the model weights and libraries below to the browser. Everything is permissively licensed
(Apache-2.0, MIT, BSD, ISC), except mediabunny (MPL-2.0, used unmodified) and the Geist fonts (SIL OFL 1.1).
No Ultralytics/YOLO (AGPL-3.0) code or weights are shipped. Exact model files and hashes: `web/models.lock.json`.

## Model weights

### D-FINE (person and ball detector): D-FINE-S and D-FINE-M, COCO
- License: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Upstream: https://github.com/Peterande/D-FINE
  (Peng et al., "D-FINE: Redefine Regression Task in DETRs as Fine-grained Distribution Refinement", 2024).
- ONNX exports by onnx-community on Hugging Face (https://huggingface.co/onnx-community/dfine_s_coco-ONNX,
  https://huggingface.co/onnx-community/dfine_m_coco-ONNX), used unmodified at the pinned revisions.
- Trained on COCO (annotations CC BY 4.0). No training data is redistributed.

### RTMPose (pose model): RTMPose-m and RTMPose-s, body7, Halpe26, 256x192
- License: Apache License 2.0. Copyright OpenMMLab. Upstream: https://github.com/open-mmlab/mmpose (RTMPose: Jiang et al., 2023).
- Training data: the body7 checkpoints were trained by OpenMMLab on seven public datasets (AI Challenger, COCO,
  CrowdPose, Halpe, MPII, PoseTrack18, sub-JHMDB). The weights are released under Apache-2.0; some of these datasets,
  notably AI Challenger, have their own terms for the data itself. This project redistributes no training data.
- Modification notice (Apache-2.0 §4b): the `*.fp16` files are derived from the upstream ONNX exports by
  `web/scripts/convert_fp16.py` (weights and compute cast to float16, float32 inputs/outputs, the ScaleNorm and
  attention nodes listed in `web/models.lock.json` kept in float32). The `*.fp32` files are the unmodified upstream exports.

### VballNetV4c (ball model)
- Source: https://github.com/asigatchov/fast-volleyball-tracking-inference (file
  `models/VballNetV4c_seq9_grayscale_20260908_213829.onnx`, used unmodified).

```
MIT License

Copyright (c) 2025  Alexander Sigatchov

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Libraries bundled into the app

| Package | Version | License | Notes |
|---|---|---|---|
| onnxruntime-web | 1.31.1 | MIT (Microsoft) | The wasm runtime contains third-party components listed in https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt |
| mediabunny | 1.65.0 | MPL-2.0 (Vanilagy) | Used unmodified. MPL-2.0 obligations: keep its notices and make its source available; the exact source is the npm package `mediabunny@1.65.0` and https://github.com/Vanilagy/mediabunny. Any change to its files would have to be published under MPL-2.0. License text: https://mozilla.org/MPL/2.0/ |
| react, react-dom | 19.3.1 | MIT (Meta Platforms) | |
| @base-ui/react | 1.9.0 | MIT | |
| zustand | 5.0.16 | MIT | |
| xstate, @xstate/react | 5.33.3, 6.1.0 | MIT | |
| motion | 14.9.0 | MIT | |
| lucide-react | 1.66.0 | ISC (Lucide contributors; parts MIT, Feather) | |
| sonner | 2.0.8 | MIT | |
| vaul | 1.1.2 | MIT | |
| @use-gesture/react | 10.3.1 | MIT | |
| idb-keyval | 6.3.0 | Apache-2.0 | |
| comlink | 4.4.2 | Apache-2.0 | |
| workbox-window | 7.4.1 | MIT | |
| clsx, tailwind-merge | 2.1.1, 3.7.0 | MIT | |
| class-variance-authority | 0.7.1 | Apache-2.0 | |
| munkres | 2.1.1 | MIT | |
| tailwindcss (generated CSS), tw-animate-css | 4.3.3, 1.4.0 | MIT | |

## Fonts
- Geist and Geist Mono (variable), Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font),
  licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). Packaged by Fontsource
  (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono` 5.3.0). The full license text ships in those packages.

## Development-only tools (not shipped to users)
Vite, Vitest, Playwright, TypeScript, Biome, wrangler, onnxruntime-node, sharp (its prebuilt libvips binaries are
LGPL-3.0), @axe-core/playwright (MPL-2.0), ajv, happy-dom, Testing Library, fake-indexeddb, shadcn (CLI). Python
tooling for model conversion: onnx and onnxconverter-common (Apache-2.0 / MIT).
