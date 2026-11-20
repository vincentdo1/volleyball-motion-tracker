import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { type CapabilityReport, DEVICE_TIERS } from '@/contracts/capabilities';
import type { MlModule } from '@/contracts/pipeline';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import schema from '@/contracts/posetrack.schema.json';
import minimal from '../../contracts/examples/minimal.posetrack.json';
import { artifactById } from './model-lock';
import { createOrtRuntimeProvider, modelInfo } from './ort-provider';

const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);

describe('model records of the exported document (M2-3)', () => {
  for (const tier of Object.values(DEVICE_TIERS)) {
    it(`${tier.id}: every input size is positive and the document validates against the schema`, () => {
      const models = [tier.models.detector, tier.models.pose, tier.models.ball].map((id) =>
        modelInfo(artifactById(id), tier),
      );
      const doc = { ...(minimal as unknown as PoseTrackDocument), models };
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(models[0]?.inputSize).toEqual([tier.detectorInputSize, tier.detectorInputSize]);
      expect(models[1]?.inputSize).toEqual([192, 256]);
      expect(models[2]?.inputSize).toEqual([512, 288]);
    });
  }
});

describe('model download announcement (re-review N1)', () => {
  it('announces every model of the tier, with its size, before any download is awaited', () => {
    const tier = DEVICE_TIERS['wasm-st'];
    const events: { modelId: string; bytesDone: number; bytesTotal: number; fromCache: boolean }[] = [];
    // a network that never answers: only what prepare() reports before its first download can arrive
    const provider = createOrtRuntimeProvider({ fetchFn: () => new Promise<Response>(() => {}), cacheStorage: null });
    void provider.prepare({
      tier,
      ml: {} as MlModule,
      capabilities: {} as CapabilityReport,
      options: {},
      onModelProgress: (event) => events.push(event),
    });
    expect(events.map((e) => e.modelId)).toEqual([tier.models.detector, tier.models.pose, tier.models.ball]);
    for (const event of events) {
      expect(event.bytesDone).toBe(0);
      expect(event.bytesTotal).toBe(artifactById(event.modelId).size);
    }
  });
});
