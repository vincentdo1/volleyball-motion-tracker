import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeExampleResults, stringifyExample } from './examples/make-examples';
import { encodePoseTrack } from './posetrack-codec';

const update = process.env.UPDATE_EXAMPLES === '1';

describe('contract example documents', () => {
  for (const [name, result] of Object.entries(makeExampleResults())) {
    it(`examples/${name}.posetrack.json matches its generator`, () => {
      const file = fileURLToPath(new URL(`./examples/${name}.posetrack.json`, import.meta.url));
      const doc = encodePoseTrack(result);
      if (update) writeFileSync(file, stringifyExample(doc));
      expect(existsSync(file), 'run with UPDATE_EXAMPLES=1 to create it').toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(doc)));
    });
  }
});
