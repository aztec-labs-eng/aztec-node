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
  console.log('[global-teardown] Global teardown complete');
}
