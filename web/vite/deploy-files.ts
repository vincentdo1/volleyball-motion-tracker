import { copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Copies the Cloudflare static-asset control files (`_headers`, `.assetsignore`) into the build output. */
export function deployFiles(): Plugin {
  const source = fileURLToPath(new URL('../../deploy/cloudflare/', import.meta.url));
  let outDir = resolve('dist');
  return {
    name: 'vbt:deploy-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const name of ['_headers', '.assetsignore']) {
        const from = join(source, name);
        if (existsSync(from)) copyFileSync(from, join(outDir, name));
      }
    },
  };
}
