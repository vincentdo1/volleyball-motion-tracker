# Hosting (Cloudflare Workers static assets + R2)

Nothing here deploys automatically. `deploy/cloudflare/` is ready for when the owner wants a public URL.

## What the owner needs
1. A Cloudflare account (the free plan is enough).
2. R2 enabled on the account (Dashboard > R2). R2 has a free allowance (10 GB storage, 10 M reads/month) and no
   egress fees; enabling it may ask for a payment method.
3. One R2 bucket named `volleyball-motion-tracker-assets` (or change `bucket_name` in `cloudflare/wrangler.jsonc`).
4. Optional: a custom domain on Cloudflare. Without one the app is served at `https://volleyball-motion-tracker.<account>.workers.dev`.

## How requests are served
| Path | Served by | Why |
|---|---|---|
| `/models/*`, `/ort/*` | the Worker (`cloudflare/src/worker.ts`) from R2 | model files and the 27.4 MiB onnxruntime wasm exceed the 25 MiB static-asset limit |
| everything else | Workers Static Assets from `web/dist` | free, cached at the edge; headers from `cloudflare/_headers` |

All responses send `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`,
`Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff` (the page must be cross-origin
isolated). R2 responses are `immutable` (file names are content-hashed or versioned) and support `Range` and `ETag`.
`web/dist/.assetsignore` keeps `ort/` and `models/` out of the static-asset upload.

## Deploy steps (run from `web/`)
```sh
npm ci && npm run fetch-models && npm run build      # dist/ (+ dist/ort/1.31.1, dist/models)
npx wrangler login                                   # once, opens the browser

# Upload the onnxruntime runtime files and the models to R2 (only when they change)
B=volleyball-motion-tracker-assets
for f in dist/ort/1.31.1/*; do
  case "$f" in *.wasm) t=application/wasm;; *) t="text/javascript; charset=utf-8";; esac
  npx wrangler r2 object put "$B/ort/1.31.1/$(basename "$f")" --file "$f" --content-type "$t" --remote
done
for f in dist/models/*.onnx; do
  npx wrangler r2 object put "$B/models/$(basename "$f")" --file "$f" --content-type application/octet-stream --remote
done

npx wrangler deploy --config ../deploy/cloudflare/wrangler.jsonc
```
For a custom domain, add `"routes": [{ "pattern": "app.example.com", "custom_domain": true }]` to `wrangler.jsonc`.

## Local check without an account
`npm run build && npm run cf:dev` runs the Worker locally (wrangler + workerd) against a local R2 simulation. Seed it
with the same `wrangler r2 object put` commands using `--local` instead of `--remote`.

## Other hosts
Any host works if it can (a) send the four headers above on every response and (b) serve files larger than 25 MiB
(or route `/ort/*` and `/models/*` to object storage on the same origin). GitHub Pages cannot set headers.
