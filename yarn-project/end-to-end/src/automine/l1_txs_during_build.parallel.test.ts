import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { waitForTx } from '@aztec-labs/aztec.js/node';
import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import type { EthCheatCodes } from '@aztec-labs/ethereum/test';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Logger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { TestContract } from '@aztec-labs/noir-test-contracts.js/Test';
import type { AztecNode, AztecNodeDebug } from '@aztec-labs/stdlib/interfaces/client';
import { type TxReceipt, TxStatus } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type { EndToEndContext } from '../fixtures/setup.js';
import { proveInteraction } from '../test-wallet/utils.js';
import { AutomineTestContext } from './automine_test_context.js';

/** Pause between two unrelated L1 txs: short enough to land several L1 blocks during one build. */
const SPAM_INTERVAL_MS = 50;
/** How long one unrelated L1 tx may take to be mined before the spammer gives up, failing the test. */
const SPAM_RECEIPT_TIMEOUT_MS = 30_000;

/**
 * Sends unrelated L1 txs one after the other from an account of its own, as a deploy script or a parallel test file
 * would, until stopped. Each tx is its own L1 block under automine, and the block-timestamp interval set at deploy
 * moves L1 time forward by a whole L1 slot per block.
 */
class L1TxSpammer {
  private stopped = false;
  private running?: Promise<number>;

  constructor(
    private readonly context: EndToEndContext,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    const account = privateKeyToAccount(generatePrivateKey());
    await this.context.ethCheatCodes.setBalance(account.address, 10n ** 20n);
    const client = createExtendedL1Client(this.context.config.l1RpcUrls, account, undefined, 10);
    this.stopped = false;
    this.running = (async () => {
      let sent = 0;
      while (!this.stopped) {
        const hash = await client.sendTransaction({ to: account.address, value: 0n });
        await client.waitForTransactionReceipt({ hash, pollingInterval: 10, timeout: SPAM_RECEIPT_TIMEOUT_MS });
        sent++;
        await sleep(SPAM_INTERVAL_MS);
      }
      return sent;
    })();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const sent = await this.running;
    this.logger.info(`Sent ${sent} unrelated L1 txs`);
  }
}

// Unrelated L1 txs landing while the automine sequencer builds a checkpoint must not move L1 time out of the slot it
// builds for. If they do, the propose reverts on L1 and the block the tx was PROPOSED in is rolled back, or a debug
// warp fails at the archiver insert because the slot has expired.
describe('automine/l1_txs_during_build', () => {
  jest.setTimeout(10 * 60 * 1000);

  let test: AutomineTestContext;
  let context: EndToEndContext;
  let aztecNode: AztecNode & AztecNodeDebug;
  let ethCheatCodes: EthCheatCodes;
  let owner: AztecAddress;
  let contract: TestContract;
  let spammer: L1TxSpammer;
  let ethereumSlotDuration: number;

  beforeAll(async () => {
    test = await AutomineTestContext.setup({ numberOfAccounts: 1 });
    ({ context, aztecNode } = test);
    ({ ethCheatCodes } = context);
    owner = test.defaultAccountAddress;
    ethereumSlotDuration = context.config.ethereumSlotDuration;
    ({ contract } = await TestContract.deploy(test.wallet).send({ from: owner }));
    spammer = new L1TxSpammer(context, test.logger);
  });

  afterAll(async () => {
    await spammer?.stop();
    await test?.teardown();
  });

  /** Asserts the L1 block after the latest one still comes one L1 slot later, by mining it with an L1 tx. */
  const expectBlockTimestampIntervalKept = async () => {
    const latest = await ethCheatCodes.lastBlockTimestamp();
    const account = privateKeyToAccount(generatePrivateKey());
    await ethCheatCodes.setBalance(account.address, 10n ** 18n);
    const client = createExtendedL1Client(context.config.l1RpcUrls, account);
    const hash = await client.sendTransaction({ to: account.address, value: 0n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    expect(Number(block.timestamp)).toBe(latest + ethereumSlotDuration);
  };

  it('keeps the block a tx was proposed in while unrelated L1 txs land', async () => {
    for (let i = 0; i < 3; i++) {
      // Prove before the L1 load starts, so it covers only the node's handling of the tx and not the client's proving.
      const tx = await proveInteraction(test.wallet, contract.methods.emit_nullifier_public(BigInt(1000 + i)), {
        from: owner,
      });
      await spammer.start();
      let proposedReceipt: TxReceipt;
      try {
        proposedReceipt = await tx.send({ wait: { waitForStatus: TxStatus.PROPOSED, timeout: 60 } });
      } finally {
        await spammer.stop();
      }

      const checkpointedReceipt = await waitForTx(aztecNode, proposedReceipt.txHash, {
        waitForStatus: TxStatus.CHECKPOINTED,
        timeout: 60,
      });
      expect(checkpointedReceipt.blockNumber).toEqual(proposedReceipt.blockNumber);
      expect(checkpointedReceipt.blockHash).toEqual(proposedReceipt.blockHash);
    }

    await expectBlockTimestampIntervalKept();
  });

  it('warps while unrelated L1 txs land', async () => {
    const warpBy = context.config.aztecSlotDuration;
    for (let i = 0; i < 3; i++) {
      const blockBefore = await aztecNode.getBlockNumber();
      const target = (await ethCheatCodes.lastBlockTimestamp()) + warpBy;

      await spammer.start();
      try {
        await aztecNode.warpL2TimeAtLeastBy(warpBy);
      } finally {
        await spammer.stop();
      }

      const blockAfter = await aztecNode.getBlockNumber();
      expect(blockAfter).toBeGreaterThan(blockBefore);
      const block = await aztecNode.getBlock(BlockNumber(blockAfter));
      expect(Number(block?.header.globalVariables.timestamp)).toBeGreaterThanOrEqual(target);
    }

    await expectBlockTimestampIntervalKept();
  });
});
