/** Model registry types (`web/models.lock.json`) and served-asset locations. */

export const ORT_VERSION = '1.31.1';
/** onnxruntime-web wasm/mjs files, served same-origin (dev: vite/ort-assets.ts; prod: R2 via the Worker). */
export const ORT_ASSET_BASE = `/ort/${ORT_VERSION}/`;
export const MODEL_BASE = '/models/';

export type ModelRole = 'person-detector' | 'pose' | 'ball';
export type ModelPrecision = 'fp32' | 'fp16' | 'int8';
export type ModelFamily = 'd-fine' | 'rtmpose' | 'vballnet';

export interface TensorSpec {
  readonly name: string;
  /** Symbolic dims are strings (e.g. "batch"). */
  readonly dims: readonly (number | string)[];
  readonly dtype: 'float32' | 'float16' | 'int64';
}

export type ModelSource =
  | { readonly kind: 'direct'; readonly url: string }
  | {
      readonly kind: 'zip';
      readonly url: string;
      readonly sha256: string;
      readonly size: number;
      readonly innerPath: string;
    }
  | {
      readonly kind: 'derived';
      /** Model id this file is converted from. */
      readonly from: string;
      /** Exact command, relative to `web/`; `{in}` and `{out}` are cache paths. */
      readonly recipe: string;
      /** Tool versions that reproduce the file byte for byte. */
      readonly toolchain: string;
    };

export interface ModelArtifact {
  readonly id: string;
  readonly role: ModelRole;
  readonly family: ModelFamily;
  readonly displayName: string;
  /** Upstream revision or release the weights come from. */
  readonly version: string;
  readonly precision: ModelPrecision;
  /** Served file name, content-hashed: `<id>.<sha256[0:12]>.onnx`. */
  readonly file: string;
  /** File name in the shared cache (`~/.cache/volleyball-motion-tracker/models`). */
  readonly cacheFile: string;
  readonly sha256: string;
  readonly size: number;
  /** Only shipped artifacts are linked into `public/models/` and referenced by tiers. */
  readonly ship: boolean;
  readonly license: string;
  readonly licenseUrl: string;
  readonly attribution: string;
  readonly upstream: string;
  readonly source: ModelSource;
  readonly io: { readonly inputs: readonly TensorSpec[]; readonly outputs: readonly TensorSpec[] };
  readonly notes: string;
}

export interface ModelsLock {
  readonly lockVersion: 1;
  readonly description: string;
  readonly cacheDir: string;
  readonly servedPath: string;
  readonly models: readonly ModelArtifact[];
}

export function servedFileName(id: string, sha256: string): string {
  return `${id}.${sha256.slice(0, 12)}.onnx`;
}

export function modelUrl(artifact: Pick<ModelArtifact, 'file'>, base: string = MODEL_BASE): string {
  return `${base.endsWith('/') ? base : `${base}/`}${artifact.file}`;
}

export function findModel(lock: ModelsLock, id: string): ModelArtifact {
  const found = lock.models.find((m) => m.id === id);
  if (!found) throw new Error(`model not in models.lock.json: ${id}`);
  return found;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Runtime check of a parsed `models.lock.json` (ids unique, hashes well-formed, served names content-hashed). */
export function parseModelsLock(value: unknown): ModelsLock {
  if (typeof value !== 'object' || value === null || !('models' in value) || !Array.isArray(value.models)) {
    throw new Error('models.lock.json: missing models array');
  }
  const lock = value as ModelsLock;
  if (lock.lockVersion !== 1) throw new Error('models.lock.json: unsupported lockVersion');
  const ids = new Set<string>();
  for (const m of lock.models) {
    if (ids.has(m.id)) throw new Error(`models.lock.json: duplicate id ${m.id}`);
    ids.add(m.id);
    if (!SHA256.test(m.sha256)) throw new Error(`models.lock.json: bad sha256 for ${m.id}`);
    if (m.file !== servedFileName(m.id, m.sha256))
      throw new Error(`models.lock.json: ${m.id} file must be content-hashed`);
    if (!['direct', 'zip', 'derived'].includes(m.source.kind))
      throw new Error(`models.lock.json: bad source for ${m.id}`);
    const source = m.source;
    if (source.kind === 'derived' && !lock.models.some((other) => other.id === source.from)) {
      throw new Error(`models.lock.json: ${m.id} derives from unknown ${source.from}`);
    }
  }
  return lock;
}
