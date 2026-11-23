import { playwright } from '@vitest/browser-playwright';
import { existsSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { cacheDir } from './vitest.global-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use pre-installed playwright browsers if available (e.g., in CI)
const systemPlaywrightPath = '/opt/ms-playwright';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(systemPlaywrightPath)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = systemPlaywrightPath;
}

// @aztec-labs/kv-sqlite fetches its wasm module from its own directory, which is outside the workspace when the
// package is a portal into the foundation tree; the dev server has to be allowed to serve it.
const kvSqliteDir = path.dirname(
  path.dirname(realpathSync(createRequire(import.meta.url).resolve('@aztec-labs/kv-sqlite'))),
);

export default defineConfig({
  cacheDir,
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), kvSqliteDir],
    },
  },
  define: {
    'process.env': {},
  },
  optimizeDeps: {
    include: [
      'chai',
      'zod',
      'idb',
      'sha3',
      'viem',
      'ohash',
      'hash.js',
      '@noble/curves/secp256k1',
      'colorette',
      'detect-node',
      'pino',
      'msgpackr/index-no-eval',
      'pako',
      'idb-keyval',
      'comlink',
    ],
    // These load their .wasm modules relative to their own files (`new URL(..., import.meta.url)`); let Vite serve
    // them as they are rather than pre-bundling, which would move the code away from its assets.
    exclude: ['@aztec-labs/sqlite3mc-wasm', '@aztec-labs/kv-sqlite'],
  },
  test: {
    globals: true,
    // Bench suites do full-population + N-iteration work; default 30s is too tight.
    testTimeout: process.env.VITE_BENCH === '1' ? 300_000 : 30_000,
    // Run test files sequentially to avoid race conditions in browser module loading
    fileParallelism: false,
    teardownTimeout: 10_000,
    globalSetup: './vitest.global-setup.ts',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            './src/lmdb/**/*.test.ts',
            './src/kv-sqlite/**/*.test.ts',
            './src/lmdb-v2/**/*.test.ts',
            './src/stores/**/*.test.ts',
            './src/interfaces/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        resolve: {
          alias: {
            // Browser stubs for modules that pull in Barretenberg WASM.
            '@aztec-labs/foundation/eth-address': path.resolve(__dirname, 'browser-stubs/eth-address.js'),
            '@aztec-labs/foundation/log': path.resolve(__dirname, 'browser-stubs/foundation-log.js'),
            buffer: path.resolve(__dirname, 'browser-stubs/buffer.js'),
            util: path.resolve(__dirname, 'browser-stubs/util.js'),
          },
        },
        test: {
          name: 'browser',
          include: [
            './src/deprecated/indexeddb/**/*.test.ts',
            './src/sqlite-opfs/**/*.test.ts',
            // Benchmarks self-skip unless VITE_BENCH=1; include so they're discoverable.
            './src/bench/indexeddb/**/*.test.ts',
            './src/bench/sqlite-opfs/**/*.test.ts',
            './src/bench/sqlite-opfs-encrypted/**/*.test.ts',
          ],
          reporters: ['verbose'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [
              {
                browser: 'chromium',
                launch: {
                  args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                  ],
                  timeout: 30_000,
                },
                context: {
                  actionTimeout: 10_000,
                },
              },
            ],
          },
        },
      },
    ],
  },
});
