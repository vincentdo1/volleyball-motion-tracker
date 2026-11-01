#!/usr/bin/env node
// Post-build check: Cloudflare Workers static assets reject files over 25 MiB. Everything that large must live
// under ort/ or models/, which deploy/cloudflare serves from R2 (and .assetsignore keeps out of the asset upload).
import { existsSync, readdirSync, statSync } from 'node:fs';
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

console.log(`dist: ${files.length} files, ${mib(files.reduce((s, f) => s + f.size, 0))} total`);
console.log(`  static assets: ${assets.length} files, ${mib(assets.reduce((s, f) => s + f.size, 0))}`);
console.log(`  R2-routed (ort/, models/): ${files.length - assets.length} files`);
for (const f of [...assets].sort((a, b) => b.size - a.size).slice(0, 5))
  console.log(`  largest asset ${mib(f.size)}  ${f.path}`);
if (offenders.length || missing.length) {
  for (const f of offenders)
    console.error(`ERROR asset over 25 MiB outside ort/ or models/: ${f.path} (${mib(f.size)})`);
  for (const m of missing) console.error(`ERROR missing from dist: ${m}`);
  process.exit(1);
}
console.log('check-dist: OK');
