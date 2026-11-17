import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import lockJson from '../../models.lock.json';
import { ORT_FILES } from '../../vite/ort-assets.ts';
import { DEVICE_TIERS } from './capabilities';
import { findModel, ORT_VERSION, parseModelsLock, servedFileName } from './models';
import { initialSettingsForTier } from './params';

const lock = parseModelsLock(lockJson);
const web = fileURLToPath(new URL('../../', import.meta.url));

describe('models.lock.json', () => {
  it('pins every tier model as a shipped, permissively licensed, content-hashed artifact', () => {
    for (const tier of Object.values(DEVICE_TIERS)) {
      for (const id of Object.values(tier.models)) {
        const m = findModel(lock, id);
        expect(m.ship, id).toBe(true);
        expect(['Apache-2.0', 'MIT']).toContain(m.license);
        expect(m.file).toBe(servedFileName(m.id, m.sha256));
      }
    }
  });

  it('derived artifacts name their source and the repo conversion script', () => {
    for (const m of lock.models) {
      if (m.source.kind !== 'derived') continue;
      expect(m.source.recipe).toMatch(/^python3 -I scripts\/convert_fp16\.py \{in\} \{out\} --nodes \S+$/);
      expect(findModel(lock, m.source.from).precision).toBe('fp32');
    }
    expect(existsSync(`${web}scripts/convert_fp16.py`)).toBe(true);
  });

  it('ORT_VERSION matches the installed onnxruntime-web and its runtime files exist', () => {
    const pkg = JSON.parse(readFileSync(`${web}node_modules/onnxruntime-web/package.json`, 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(ORT_VERSION);
    for (const f of ORT_FILES) expect(existsSync(`${web}node_modules/onnxruntime-web/dist/${f}`), f).toBe(true);
  });

  it('tier settings use the tier detector size, cadence and batching', () => {
    const wasm = initialSettingsForTier(DEVICE_TIERS['wasm-mt']);
    expect(wasm.detector.inputSize).toBe(480);
    expect(wasm.detector.cadence).toBe(3);
    expect(wasm.pose.batching).toBe('single');
    expect(initialSettingsForTier(DEVICE_TIERS['webgpu-default']).pose.batchBuckets).toEqual([
      1, 2, 4, 8, 12, 16, 24, 32,
    ]);
    expect(wasm.ball.lockMaxAgeS).toBeCloseTo(0.6, 6);
  });
});
