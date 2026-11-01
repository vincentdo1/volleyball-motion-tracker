# web/scripts

| Script | What it does |
|---|---|
| `fetch-models.mjs` (`npm run fetch-models`) | Reads `../models.lock.json`, downloads missing models into `~/.cache/volleyball-motion-tracker/models` (override with `VBT_MODEL_CACHE`), verifies SHA-256, updates `SHA256SUMS` there and symlinks the shipped files into `public/models/<id>.<sha12>.onnx` (gitignored). Flags: `--check`, `--all` (also reference files), `--inspect` (compare model I/O with the lock using onnxruntime-node), `--rebuild-derived` (re-run fp16 conversions and compare hashes), `--copy`. |
| `check-dist.mjs` (runs after `npm run build`) | Fails if any static asset in `dist/` is over 25 MiB outside `ort/` and `models/` (Cloudflare's per-asset limit), or if `_headers`, `.assetsignore` or the ORT wasm are missing. |
| `convert_fp16.py` | Converts an fp32 ONNX model to fp16 weights/compute with float32 I/O, keeping listed nodes in fp32. |

## Reproducing the fp16 RTMPose builds
The fp16 files are already in the shared cache. To rebuild and verify them byte for byte:
```sh
python3 -m venv .venv
.venv/bin/pip install onnx==1.17.0 onnxconverter-common==1.16.0 numpy==2.0.2 protobuf==6.33.6
VBT_PYTHON=.venv/bin/python3 npm run fetch-models -- --rebuild-derived
```
The exact `--nodes` lists (both ScaleNorm chains and the GAU squared-ReLU attention, which overflow fp16) are the
`recipe` fields in `models.lock.json`.

| File (cache) | SHA-256 | Size |
|---|---|---|
| `rtmpose_m26_fp32.onnx` (upstream end2end.onnx) | `26f3a19e61304a600dfb82d1001d41d24343b89fc70a33ffc84657e0b0bf2ecf` | 55,685,444 |
| `rtmpose_m26_fp16.onnx` | `673466126f340320c2f0ebddb1514281af694294c006137b9293c85afaad7ef1` | 27,884,563 |
| `rtmpose_s26_fp32.onnx` (upstream end2end.onnx) | `85c5d669aa0b0c7969799ea9e0620d3b8c1d3c2b6878243e98a1ef8351457986` | 22,793,379 |
| `rtmpose_s26_fp16.onnx` | `907a6d72d61c57a341d23760512394a493545ed35862150bcdd9ac1a0106c452` | 11,435,244 |
