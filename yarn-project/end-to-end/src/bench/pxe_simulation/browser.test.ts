import { compactArray } from '@aztec-labs/foundation/collection';
import { createLogger } from '@aztec-labs/foundation/log';
import { getRandomPort } from '@aztec-labs/foundation/testing';
import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium } from 'playwright';
import { type PreviewServer, build, preview } from 'vite';

import { PxeSimulationBenchmark } from './pxe_simulation_benchmark.js';
import type { Scenario, ScenarioConfig } from './scenario.js';

jest.setTimeout(1_800_000);

const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser_page');

// bb.js runs multithreaded only on a cross-origin isolated page, which is how a wallet's page is served.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

describe('PXE simulation benchmark in a browser', () => {
  const logger = createLogger('bench:pxe_simulation:browser');
  const benchmark = new PxeSimulationBenchmark();
  let config: ScenarioConfig;
  let pageBuildDir: string;
  let pageServer: PreviewServer;
  let profileDir: string;
  let context: BrowserContext;

  beforeAll(async () => {
    config = await benchmark.setup();

    pageBuildDir = await mkdtemp(path.join(tmpdir(), 'pxe-simulation-page-'));
    await build({
      root: PAGE_DIR,
      configFile: false,
      base: './',
      logLevel: 'warn',
      build: { outDir: pageBuildDir },
      // The PXE reads its log level from process.env, which a browser does not define.
      define: { 'process.env': JSON.stringify({ LOG_LEVEL: 'warn' }) },
    });
    pageServer = await preview({
      root: PAGE_DIR,
      configFile: false,
      logLevel: 'warn',
      build: { outDir: pageBuildDir },
      preview: { host: '127.0.0.1', port: await getRandomPort(), headers: CROSS_ORIGIN_ISOLATION_HEADERS },
    });
    // A browser's default context is off the record, which keeps OPFS in memory; a persistent one keeps it on disk, as
    // a user's browser does.
    profileDir = await mkdtemp(path.join(tmpdir(), 'pxe-simulation-profile-'));
    context = await chromium.launchPersistentContext(profileDir);
  });

  afterAll(async () => {
    await context?.close();
    await pageServer?.close();
    for (const dir of compactArray([pageBuildDir, profileDir])) {
      await rm(dir, { recursive: true, force: true });
    }
    await benchmark.teardown();
  });

  it('measures the PXE of a wallet running in a browser', async () => {
    const page = await context.newPage();
    page.on('console', message => logger.verbose(`page ${message.type()}: ${message.text()}`));
    page.on('pageerror', error => logger.error(`page error: ${error.message}`));
    await page.exposeFunction('mineBlock', benchmark.mineBlock);
    await page.goto(pageServer.resolvedUrls!.local[0]);

    await page.evaluate(scenarioConfig => window.pxeSimulation.setUp(scenarioConfig), config);
    const scenario: Scenario = {
      sendTxs: () => page.evaluate(() => window.pxeSimulation.sendTxs()),
      measure: () => page.evaluate(() => window.pxeSimulation.measure()),
    };
    await benchmark.run('browser', scenario);
  });
});
