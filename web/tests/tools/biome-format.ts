import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Serialises `value` with the repository's Biome JSON formatter, the one `npm run lint` applies, so generated
 * fixtures are lint-clean and regenerate byte for byte.
 */
export function formatJson(value: unknown, fileName: string): string {
  return execFileSync(join(webRoot, 'node_modules/.bin/biome'), ['format', `--stdin-file-path=${fileName}`], {
    input: JSON.stringify(value),
    encoding: 'utf8',
    cwd: webRoot,
    maxBuffer: 1 << 28,
  });
}
