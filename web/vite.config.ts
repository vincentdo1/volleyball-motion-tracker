import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type UserConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { deployFiles } from './vite/deploy-files.ts';
import { devFixtures } from './vite/dev-fixtures.ts';
import { isolationHeaders } from './vite/isolation-headers.ts';
import { ortAssets } from './vite/ort-assets.ts';

/** Dev/preview port: each persona worktree uses its own (ML 5181, backend 5182, UI 5183, tester 5184). */
const port = Number(process.env.PORT ?? 5173);

export const viteConfig: UserConfig = {
  plugins: [
    isolationHeaders(),
    ortAssets(),
    devFixtures(),
    deployFiles(),
    react(),
    tailwindcss(),
    // App-shell precache only: models and the ORT wasm are cached by the engine's model manager, not the service worker.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/engine/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: ['**/*.wasm', 'models/**'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Makes `onnxruntime-web/{webgpu,jspi,wasm}` resolve to the builds that load their wasm from
    // `ort.env.wasm.wasmPaths` (served at /ort/<version>/) instead of bundling a 27 MiB asset.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: { format: 'es' },
  // A dependency the first scan misses is bundled on first use, and that reloads the page: in the browser tests the
  // reload fails every suite that is loading (first run after an install or a config change). Listing the ones the
  // scan misses bundles them up front.
  optimizeDeps: { exclude: ['onnxruntime-web'], include: ['react-dom/client', 'zustand/react/shallow'] },
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port, strictPort: true },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 1500 },
};

export default defineConfig(viteConfig);
