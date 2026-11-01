#!/usr/bin/env node
// Downloads the models pinned in models.lock.json into the shared cache, verifies SHA-256, reuses cached files and
// links the shipped ones into public/models/<file> (gitignored), where the dev and preview servers serve them.
//
// usage: node scripts/fetch-models.mjs [--check] [--all] [--inspect] [--rebuild-derived] [--copy]
//   --check            verify only, never download (exit 1 if anything is missing or wrong)
//   --all              also fetch reference artifacts that do not ship (ship: false)
//   --inspect          open every cached model with onnxruntime-node and compare its I/O with the lock
//   --rebuild-derived  re-run derived conversions (needs VBT_PYTHON) and check they reproduce the pinned hash
//   --copy             copy into public/models instead of symlinking
// env: VBT_MODEL_CACHE (default ~/.cache/volleyball-motion-tracker/models), VBT_PYTHON (python with the toolchain
//      named in the lock's derived entries; only needed when a derived file is missing or with --rebuild-derived)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(readFileSync(join(web, 'models.lock.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const cacheDir = process.env.VBT_MODEL_CACHE ?? join(homedir(), '.cache', 'volleyball-motion-tracker', 'models');
const publicDir = join(web, 'public', 'models');
const byId = new Map(lock.models.map((m) => [m.id, m]));
const status = new Map();
let failed = false;

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function isValid(path, sha256) {
  return existsSync(path) && (await sha256File(path)) === sha256;
}

async function download(url, dest, expectedSha, expectedSize) {
  mkdirSync(join(cacheDir, '.partial'), { recursive: true });
  const tmp = join(cacheDir, '.partial', `${basename(dest)}.${process.pid}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
  let bytes = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  const sha = hash.digest('hex');
  if (sha !== expectedSha || (expectedSize && bytes !== expectedSize)) {
    rmSync(tmp, { force: true });
    throw new Error(`hash/size mismatch for ${url}: got ${sha} (${bytes} B), want ${expectedSha} (${expectedSize} B)`);
  }
  renameSync(tmp, dest);
  return bytes;
}

function runRecipe(model, inPath, outPath) {
  const python = process.env.VBT_PYTHON;
  if (!python) return false;
  const argv = model.source.recipe.replace('{in}', inPath).replace('{out}', outPath).split(' ');
  if (argv[0] !== 'python3') throw new Error(`unexpected recipe for ${model.id}`);
  execFileSync(python, argv.slice(1), { cwd: web, stdio: ['ignore', 'ignore', 'inherit'] });
  return true;
}

async function ensure(model) {
  if (status.has(model.id)) return status.get(model.id) !== 'missing';
  const path = join(cacheDir, model.cacheFile);
  if (await isValid(path, model.sha256)) {
    status.set(model.id, 'cached');
    return true;
  }
  if (existsSync(path)) console.warn(`  ${model.cacheFile}: hash mismatch, replacing`);
  if (args.has('--check')) {
    status.set(model.id, 'missing');
    return false;
  }
  const src = model.source;
  if (src.kind === 'direct') {
    console.log(`  downloading ${model.id} (${mib(model.size)}) from ${new URL(src.url).host}`);
    await download(src.url, path, model.sha256, model.size);
    status.set(model.id, 'downloaded');
    return true;
  }
  if (src.kind === 'zip') {
    mkdirSync(join(cacheDir, '.downloads'), { recursive: true });
    const zip = join(cacheDir, '.downloads', basename(new URL(src.url).pathname));
    if (!(await isValid(zip, src.sha256))) {
      console.log(`  downloading ${basename(zip)} (${mib(src.size)}) for ${model.id}`);
      await download(src.url, zip, src.sha256, src.size);
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, execFileSync('unzip', ['-p', zip, src.innerPath], { maxBuffer: 1 << 30 }));
    if ((await sha256File(tmp)) !== model.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${model.id}: ${src.innerPath} in ${basename(zip)} does not match the pinned sha256`);
    }
    renameSync(tmp, path);
    status.set(model.id, 'extracted');
    return true;
  }
  if (src.kind === 'derived') {
    const from = byId.get(src.from);
    if (!from || !(await ensure(from))) throw new Error(`${model.id}: source model ${src.from} unavailable`);
    const tmp = `${path}.${process.pid}.tmp`;
    if (!runRecipe(model, join(cacheDir, from.cacheFile), tmp)) {
      console.error(`  ${model.id} is derived and missing. Install the toolchain (${src.toolchain}) and rerun with`);
      console.error(
        `  VBT_PYTHON=/path/to/python3, or run:\n    ${src.recipe.replace('{in}', join(cacheDir, from.cacheFile)).replace('{out}', path)}`,
      );
      status.set(model.id, 'missing');
      return false;
    }
    if ((await sha256File(tmp)) !== model.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`${model.id}: conversion did not reproduce the pinned sha256 (check the toolchain versions)`);
    }
    renameSync(tmp, path);
    status.set(model.id, 'converted');
    return true;
  }
  throw new Error(`${model.id}: unknown source kind ${src.kind}`);
}

async function rebuildDerived(model) {
  const from = byId.get(model.source.from);
  await ensure(from);
  const tmp = join(cacheDir, '.partial', `${model.cacheFile}.rebuild`);
  mkdirSync(join(cacheDir, '.partial'), { recursive: true });
  if (!runRecipe(model, join(cacheDir, from.cacheFile), tmp)) throw new Error('--rebuild-derived needs VBT_PYTHON');
  const sha = await sha256File(tmp);
  rmSync(tmp, { force: true });
  console.log(`  rebuild ${model.id}: ${sha === model.sha256 ? 'reproduces the pinned sha256' : `MISMATCH ${sha}`}`);
  if (sha !== model.sha256) failed = true;
}

function writeSums() {
  const sumsPath = join(cacheDir, 'SHA256SUMS');
  const lines = new Map();
  if (existsSync(sumsPath)) {
    for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (sha && name) lines.set(name, sha);
    }
  }
  for (const m of lock.models) if (status.get(m.id) && status.get(m.id) !== 'missing') lines.set(m.cacheFile, m.sha256);
  const body = [...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, s]) => `${s}  ${n}`);
  writeFileSync(sumsPath, `${body.join('\n')}\n`);
}

function link(model) {
  const target = join(cacheDir, model.cacheFile);
  const dest = join(publicDir, model.file);
  if (existsSync(dest) || isSymlink(dest)) rmSync(dest, { force: true });
  if (args.has('--copy')) copyFileSync(target, dest);
  else symlinkSync(target, dest);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function inspect(model) {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(join(cacheDir, model.cacheFile));
  const names = (specs) => specs.map((s) => s.name).join(',');
  const ok =
    session.inputNames.join(',') === names(model.io.inputs) &&
    session.outputNames.join(',') === names(model.io.outputs);
  const meta = (list) =>
    (list ?? []).map((m) => `${m.name}[${(m.shape ?? []).join('x')}]${m.type ? `:${m.type}` : ''}`).join(' ');
  console.log(
    `  ${ok ? 'io ok ' : 'IO MISMATCH'} ${model.id}: in ${meta(session.inputMetadata)} out ${meta(session.outputMetadata)}`,
  );
  if (!ok) failed = true;
  await session.release();
}

mkdirSync(cacheDir, { recursive: true });
const targets = lock.models.filter((m) => m.ship || args.has('--all'));
console.log(`models: ${targets.length} artifacts, cache ${cacheDir}`);
for (const model of targets) {
  try {
    await ensure(model);
  } catch (error) {
    status.set(model.id, 'missing');
    console.error(`  ERROR ${model.id}: ${error instanceof Error ? error.message : error}`);
  }
}
writeSums();
if (!args.has('--check')) {
  mkdirSync(publicDir, { recursive: true });
  const shipped = new Set(lock.models.filter((m) => m.ship).map((m) => m.file));
  for (const name of readdirSync(publicDir)) if (!shipped.has(name)) rmSync(join(publicDir, name), { force: true });
  for (const model of lock.models.filter((m) => m.ship && status.get(m.id) !== 'missing')) link(model);
}
if (args.has('--rebuild-derived')) {
  for (const model of targets.filter((m) => m.source.kind === 'derived')) await rebuildDerived(model);
}
if (args.has('--inspect')) {
  for (const model of targets.filter((m) => status.get(m.id) !== 'missing')) await inspect(model);
}
for (const model of targets) {
  const st = status.get(model.id) ?? 'missing';
  if (st === 'missing') failed = true;
  console.log(
    `  ${st.padEnd(10)} ${model.id.padEnd(24)} ${mib(model.size).padStart(9)}  ${model.ship ? `/models/${model.file}` : '(reference, not shipped)'}`,
  );
}
console.log(failed ? 'fetch-models: FAILED' : 'fetch-models: OK');
process.exit(failed ? 1 : 0);
