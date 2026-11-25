import Ajv2020 from 'ajv/dist/2020';
import { afterEach, expect, it } from 'vitest';
import type { PoseTrackDocument } from '@/contracts/posetrack';
import schema from '@/contracts/posetrack.schema.json';
import { validatePoseTrackSemantics } from '@/contracts/posetrack-codec';
import { createEngine, type EngineHandle } from '../client';
import { fixtureFile } from '../testing/stub-engine';

const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
let engine: EngineHandle | undefined;

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

it('the real engine and models export a schema-valid partial result after a cancel (M2-3, M2-4)', async () => {
  engine = createEngine();
  await engine.init();
  await engine.open(await fixtureFile('volleyball_spike_attempt_03.mp4'));
  let frames = 0;
  engine.on('chunk', (e) => {
    frames += e.batch.count;
  });
  await engine.start();
  while (frames < 40) await new Promise((resolve) => setTimeout(resolve, 50));
  await engine.cancel();
  const exported = await engine.exportResult({ kind: 'json' });
  const doc = JSON.parse(await exported.blob.text()) as PoseTrackDocument;
  expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  expect(validatePoseTrackSemantics(doc)).toEqual([]);
  expect(doc.models[0]?.inputSize).toEqual([640, 640]);
  const partial = doc.extensions?.partial as { analysedFrames: number; plannedFrames: number };
  expect(partial.analysedFrames).toBeGreaterThan(0);
  expect(partial.analysedFrames).toBeLessThan(partial.plannedFrames);
  expect(doc.tracks.length).toBeGreaterThan(0);
}, 120_000);
