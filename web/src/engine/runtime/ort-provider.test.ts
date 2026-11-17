import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import schema from '@/contracts/posetrack.schema.json';
import minimal from '../../contracts/examples/minimal.posetrack.json';
import { artifactById } from './model-lock';
import { modelInfo } from './ort-provider';

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
