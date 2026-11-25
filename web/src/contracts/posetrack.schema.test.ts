import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import type { PoseTrackDocument } from './posetrack';
import schema from './posetrack.schema.json';
import { validatePoseTrackSemantics } from './posetrack-codec';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(schema);
const dir = fileURLToPath(new URL('./examples/', import.meta.url));
const examples = readdirSync(dir)
  .filter((f) => f.endsWith('.posetrack.json'))
  .map((f) => [f, JSON.parse(readFileSync(`${dir}${f}`, 'utf8')) as PoseTrackDocument] as const);

function clone(doc: PoseTrackDocument): Record<string, unknown> & PoseTrackDocument {
  return structuredClone(doc) as Record<string, unknown> & PoseTrackDocument;
}

describe('PoseTrack v1 JSON Schema', () => {
  it('has at least three example documents', () => {
    expect(examples.map(([f]) => f).sort()).toEqual([
      'minimal.posetrack.json',
      'portrait.posetrack.json',
      'rally.posetrack.json',
    ]);
  });

  for (const [file, doc] of examples) {
    it(`${file} validates against the schema and the semantic rules`, () => {
      expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
      expect(validatePoseTrackSemantics(doc)).toEqual([]);
    });
  }

  const rally = examples.find(([f]) => f === 'rally.posetrack.json')?.[1] as PoseTrackDocument;

  it('rejects documents missing required fields or with unknown top-level fields', () => {
    const noVersion = clone(rally);
    delete (noVersion as Record<string, unknown>).schemaVersion;
    expect(validate(noVersion)).toBe(false);
    expect(validate({ ...clone(rally), surprise: true })).toBe(false);
  });

  it('rejects bad enum values and malformed fingerprints', () => {
    expect(validate({ ...clone(rally), clip: { ...rally.clip, rotation: 45 } })).toBe(false);
    expect(validate({ ...clone(rally), clip: { ...rally.clip, fingerprint: 'md5:abc' } })).toBe(false);
    const badVisibility = clone(rally);
    if (badVisibility.ball) badVisibility.ball.samples.visibility[0] = 7 as 0;
    expect(validate(badVisibility)).toBe(false);
  });

  it('semantic rules catch wrong column lengths, unsorted PTS, unknown PTS and flag mismatches', () => {
    const shortKp = clone(rally);
    shortKp.tracks[0]?.samples.kp.pop();
    expect(validatePoseTrackSemantics(shortKp).join()).toMatch(/kp must have 78/);

    const unsorted = clone(rally);
    unsorted.frames.ptsUs.reverse();
    expect(validatePoseTrackSemantics(unsorted).join()).toMatch(/strictly increasing/);

    const unknownPts = clone(rally);
    const samples = unknownPts.tracks[0]?.samples;
    if (samples) samples.ptsUs[0] = 1;
    expect(validatePoseTrackSemantics(unknownPts).join()).toMatch(/frame table/);

    const flagMismatch = clone(rally);
    const flags = flagMismatch.tracks[0]?.samples.kpFlags;
    if (flags) flags[0] = 4;
    expect(validatePoseTrackSemantics(flagMismatch).join()).toMatch(/MISSING/);

    const ballMismatch = clone(rally);
    if (ballMismatch.ball) ballMismatch.ball.samples.visibility[0] = 0;
    expect(validatePoseTrackSemantics(ballMismatch).join()).toMatch(/visibility is NONE/);
  });
});
