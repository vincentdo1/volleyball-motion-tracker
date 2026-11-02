import type { ProcessingSettings } from '@/contracts/params';
import type { StartOptions } from '@/contracts/protocol';

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? base : patch;
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = merge(base[key], value);
  }
  return out;
}

/** Applies the partial overrides of `start()` onto a tier's settings. */
export function mergeSettings(base: ProcessingSettings, overrides: StartOptions['settings']): ProcessingSettings {
  return overrides === undefined ? base : (merge(base, overrides) as ProcessingSettings);
}

/** JSON with sorted keys, so equal values always serialise to equal strings. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlain(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ResumeKeyInput {
  readonly settings: ProcessingSettings;
  /** `id:sha256` of the models the run uses. */
  readonly models: readonly string[];
  readonly frameStride: number;
  readonly rangeUs: readonly [number, number] | null;
}

/** Results from different models, parameters, stride or range must never be mixed on resume (plan §3.12). */
export function settingsHash(input: ResumeKeyInput): Promise<string> {
  return sha256Hex(canonicalJson(input));
}
