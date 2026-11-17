#!/usr/bin/env node
// Seeds the local R2 simulation that `npm run cf:dev` serves /ort/* and /models/* from, with the files of the current
// build (run `npm run build` first). Same keys and content types as the remote upload in deploy/README.md, and the
// same --persist-to directory as cf:dev, so both see one local bucket.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));
const dist = join(web, 'dist');
const config = join(web, '../deploy/cloudflare/wrangler.jsonc');
const persistTo = join(web, '../deploy/cloudflare/.wrangler/state');
const wrangler = join(web, 'node_modules/.bin/wrangler');

const bucket = readFileSync(config, 'utf8').match(/"bucket_name"\s*:\s*"([^"]+)"/)?.[1];
if (!bucket) {
  console.error(`no bucket_name in ${config}`);
  process.exit(1);
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ not found: run npm run build first');
  process.exit(1);
}

const files = [];
for (const version of readdirSync(join(dist, 'ort'))) {
  for (const name of readdirSync(join(dist, 'ort', version))) {
    const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8';
    files.push({ key: `ort/${version}/${name}`, path: join(dist, 'ort', version, name), type });
  }
}
for (const name of readdirSync(join(dist, 'models')).filter((n) => n.endsWith('.onnx'))) {
  files.push({ key: `models/${name}`, path: join(dist, 'models', name), type: 'application/octet-stream' });
}

for (const f of files) {
  execFileSync(
    wrangler,
    [
      'r2',
      'object',
      'put',
      `${bucket}/${f.key}`,
      '--file',
      f.path,
      '--content-type',
      f.type,
      '--local',
      '--config',
      config,
      '--persist-to',
      persistTo,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  console.log(`  ${f.key} (${(statSync(f.path).size / 1024 / 1024).toFixed(1)} MiB)`);
}
console.log(`cf-seed-local: ${files.length} objects in the local ${bucket} bucket (${persistTo})`);
