import { rm } from 'fs/promises';
import path from 'path';

// Vite's dependency optimizer stages deps in `<cacheDir>/deps_temp_<rand>` and then renames it over
// `<cacheDir>/deps`. cacheDir defaults into node_modules, which CI bind-mounts into every ISOLATE
// container, so concurrent runs of different test files race on that directory and the rename fails
// with ENOTEMPTY/ENOENT — the optimizer dies and the browser's module fetch 404s. Give each process
// its own, and drop it in teardown: node-bucket tests run un-isolated on the shared CI host, so
// these would otherwise pile up.
export const cacheDir = path.join(process.env.TMPDIR ?? '/tmp', `kv-store-vite-${process.pid}`);

// Global setup for vitest - runs before browser is launched.
// Both projects in vitest.config.ts declare `extends: true` and so inherit the root
// `globalSetup`, which vitest then runs once per project: every log line below appears
// twice per invocation, on passing runs too.
export async function setup() {
  console.log('[global-setup] Starting global setup...');
  console.log('[global-setup] Node version:', process.version);
  console.log('[global-setup] Platform:', process.platform);
  console.log('[global-setup] CI:', process.env.CI);
  console.log('[global-setup] PLAYWRIGHT_BROWSERS_PATH:', process.env.PLAYWRIGHT_BROWSERS_PATH);
  console.log('[global-setup] Global setup complete, browser should launch next...');
}

export async function teardown() {
  console.log('[global-teardown] Global teardown starting...');
  await rm(cacheDir, { recursive: true, force: true });
  console.log('[global-teardown] Global teardown complete');
}
