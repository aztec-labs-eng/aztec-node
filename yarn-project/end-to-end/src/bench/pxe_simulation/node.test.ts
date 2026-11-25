import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { jest } from '@jest/globals';

import { PxeSimulationBenchmark } from './pxe_simulation_benchmark.js';
import { type ScenarioConfig, createScenario } from './scenario.js';

jest.setTimeout(1_800_000);

describe('PXE simulation benchmark in Node', () => {
  const benchmark = new PxeSimulationBenchmark();
  let config: ScenarioConfig;
  let wallet: EmbeddedWallet | undefined;

  beforeAll(async () => {
    config = await benchmark.setup();
  });

  afterAll(async () => {
    await wallet?.stop();
    await benchmark.teardown();
  });

  it('measures the PXE of a wallet running in Node', async () => {
    const scenario = await createScenario(config, {
      createWallet: async node => (wallet = await EmbeddedWallet.create(node, { ephemeral: true })),
      mineBlock: benchmark.mineBlock,
    });
    await benchmark.run('node', scenario);
  });
});
