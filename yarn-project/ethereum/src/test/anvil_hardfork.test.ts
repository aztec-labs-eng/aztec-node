import { retryUntil } from '@aztec-labs/foundation/retry';
import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { foundry } from 'viem/chains';

import { createExtendedL1Client } from '../client.js';
import { isAmsterdamBlock } from '../l1_tx_utils/amsterdam.js';
import { assertAnvilSupportsHardfork, restartAnvilOnHardfork } from './anvil_hardfork.js';
import { EthCheatCodes } from './eth_cheat_codes.js';
import { type Anvil, startAnvil } from './start_anvil.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const BLOCK_TIME = 2;

describe('anvil_hardfork', () => {
  describe('assertAnvilSupportsHardfork', () => {
    it('accepts a hardfork the installed anvil runs', async () => {
      await expect(assertAnvilSupportsHardfork('amsterdam')).resolves.toBeUndefined();
    });

    it('fails instead of skipping when the installed anvil cannot run the hardfork', async () => {
      await expect(assertAnvilSupportsHardfork('not-a-hardfork')).rejects.toThrow(/foundry >= 1\.8\.5 is required/);
    }, 60_000);
  });

  describe('restartAnvilOnHardfork', () => {
    let anvil: Anvil | undefined;
    let stateDir: string;

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), 'anvil-hardfork-'));
    });

    afterEach(async () => {
      await anvil?.stop();
      rmSync(stateDir, { recursive: true, force: true });
    });

    it('continues the interval-mined chain on the new hardfork, on the L1 slot grid', async () => {
      const dateProvider = new TestDateProvider();
      const startOpts = { l1BlockTime: BLOCK_TIME, pruneHistory: 32, dateProvider };
      const res = await startAnvil({ ...startOpts, port: 0, hardfork: 'osaka' });
      anvil = res.anvil;
      const cheat = new EthCheatCodes([res.rpcUrl], dateProvider);
      const client = createExtendedL1Client([res.rpcUrl], MNEMONIC, foundry, undefined, 0);
      await retryUntil(async () => (await cheat.blockNumber()) >= 2, 'interval-mined blocks', 5 * BLOCK_TIME, 0.2);

      const restarted = await restartAnvilOnHardfork(anvil, cheat, client, {
        hardfork: 'amsterdam',
        stateDir,
        startOpts,
      });
      anvil = restarted.anvil;

      expect(anvil.port).toEqual(res.anvil.port);
      const forkBlock = await client.getBlock({ blockNumber: restarted.forkBlock.number });
      const lastOsakaBlock = await client.getBlock({ blockHash: forkBlock.parentHash });
      expect(lastOsakaBlock.number).toEqual(forkBlock.number - 1n);
      expect(isAmsterdamBlock(lastOsakaBlock)).toBe(false);
      expect(isAmsterdamBlock(forkBlock)).toBe(true);
      expect(forkBlock.timestamp).toBeGreaterThan(lastOsakaBlock.timestamp);
      expect((forkBlock.timestamp - lastOsakaBlock.timestamp) % BigInt(BLOCK_TIME)).toEqual(0n);

      const next = await retryUntil(
        () => client.getBlock({ blockNumber: forkBlock.number + 1n }).catch(() => undefined),
        'interval mining to resume after the restart',
        5 * BLOCK_TIME,
        0.2,
      );
      expect(next.timestamp).toBeGreaterThanOrEqual(forkBlock.timestamp + BigInt(BLOCK_TIME));
      expect(isAmsterdamBlock(next)).toBe(true);
    }, 60_000);
  });
});
