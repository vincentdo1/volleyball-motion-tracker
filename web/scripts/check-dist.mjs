#!/usr/bin/env node
// Post-build check: Cloudflare Workers static assets reject files over 25 MiB. Everything that large must live
// under ort/ or models/, which deploy/cloudflare serves from R2 (and .assetsignore keeps out of the asset upload).
// It also guards the engine worker's entry chunk (see workerEntryProblems).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const LIMIT = 25 * 1024 * 1024;
const R2_PREFIXES = ['ort/', 'models/'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push({ path: relative(dist, path).split('\\').join('/'), size: statSync(path).size });
  }
  return out;
}

if (!existsSync(dist)) {
  console.error('dist/ not found: run vite build first');
  process.exit(1);
}
const files = walk(dist);
const viaR2 = (f) => R2_PREFIXES.some((p) => f.path.startsWith(p));
const assets = files.filter((f) => !viaR2(f));
const offenders = assets.filter((f) => f.size > LIMIT);
const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
const required = ['index.html', '_headers', '.assetsignore'];
const missing = required.filter((r) => !files.some((f) => f.path === r));
if (!files.some((f) => /^ort\/[^/]+\/ort-wasm-simd-threaded\.asyncify\.wasm$/.test(f.path))) {
  missing.push('ort/<version>/ort-wasm-simd-threaded.asyncify.wasm');
}

/**
 * WebKit re-evaluates a worker's entry module when another chunk imports the same URL, which starts a second engine
 * core inside the worker. The entry chunk (src/app/engine-worker.ts) must therefore export nothing and be imported
 * by no other chunk; Chromium never shows the failure, so only this build-level check catches a regression.
 */
function workerEntryProblems() {
  const entries = files.filter((f) => /^assets\/engine-worker-[^/]+\.js$/.test(f.path));
  if (entries.length !== 1)
    return [`expected one worker entry chunk assets/engine-worker-*.js, found ${entries.length}`];
  const entry = entries[0];
  const read = (f) => readFileSync(join(dist, f.path), 'utf8');
  const problems = [];
  if (/\bexport\s*[{*]|\bexport\s+(?:default|const|let|var|function|class)\b/.test(read(entry))) {
    problems.push(`worker entry ${entry.path} has exports, so other chunks can import it`);
  }
  const name = entry.path.slice('assets/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importsEntry = new RegExp(`(?:\\bfrom|\\bimport)\\s*\\(?\\s*["'\`]\\./${name}["'\`]`);
  for (const chunk of files.filter((f) => f.path.endsWith('.js') && f.path !== entry.path)) {
    if (importsEntry.test(read(chunk))) problems.push(`${chunk.path} imports the worker entry ${entry.path}`);
  }
  return problems;
}
const workerProblems = workerEntryProblems();

console.log(`dist: ${files.length} files, ${mib(files.reduce((s, f) => s + f.size, 0))} total`);
console.log(`  static assets: ${assets.length} files, ${mib(assets.reduce((s, f) => s + f.size, 0))}`);
console.log(`  R2-routed (ort/, models/): ${files.length - assets.length} files`);
for (const f of [...assets].sort((a, b) => b.size - a.size).slice(0, 5))
  console.log(`  largest asset ${mib(f.size)}  ${f.path}`);
if (offenders.length || missing.length || workerProblems.length) {
  for (const f of offenders)
    console.error(`ERROR asset over 25 MiB outside ort/ or models/: ${f.path} (${mib(f.size)})`);
  for (const m of missing) console.error(`ERROR missing from dist: ${m}`);
  for (const p of workerProblems) console.error(`ERROR ${p}`);
  process.exit(1);
}
console.log('check-dist: OK');
