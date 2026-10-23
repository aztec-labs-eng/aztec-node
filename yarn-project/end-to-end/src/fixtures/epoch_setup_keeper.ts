import { RollupAbi } from '@aztec-foundation/l1-artifacts/RollupAbi';

import type { EthCheatCodes } from '@aztec-labs/aztec/testing';
import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import { getContract } from 'viem';

const POLLS_PER_L1_SLOT = 4;

/**
 * Calls `setupEpoch()` on the rollup early in every epoch that is not set up yet, checking several times per L1 slot.
 *
 * The epoch cache serves an epoch's committee only once the randao it samples is checkpointed on L1, so an epoch with
 * no proposal costs the next epoch its first slot, and with two-slot epochs the loss can repeat for several epochs.
 * Tests whose scenarios leave epochs without proposals (offline validators, warps, an open escape hatch) opt in so
 * proposer timing stays predictable. This hides the seed gate from the test. Tests that assert propose gas must not
 * use it, since a proposal no longer pays for setting up its epoch.
 */
export class EpochSetupKeeper {
  private readonly sender = EthAddress.random();
  private readonly runningPromise: RunningPromise;
  private lastEpochSetUp: EpochNumber | undefined;

  constructor(
    private readonly rollup: RollupContract,
    private readonly ethCheatCodes: EthCheatCodes,
    ethereumSlotDuration: number,
    private readonly logger: Logger,
  ) {
    // With two-slot epochs of two L1 slots per L2 slot, the next epoch's first-slot proposer looks up its committee from
    // this epoch's second L1 slot until the start of its last one. A poll that runs just before the epoch's first block
    // is mined sees the old epoch, so polling once per L1 slot can land the setup in the epoch's third or fourth block,
    // potentially too late for that proposer.
    this.runningPromise = new RunningPromise(
      () => this.setUpCurrentEpoch(),
      logger,
      (ethereumSlotDuration * 1000) / POLLS_PER_L1_SLOT,
    );
  }

  public async start(): Promise<this> {
    // A dedicated impersonated sender never races the tests' own L1 txs for nonces or impersonation.
    await this.ethCheatCodes.startImpersonating(this.sender);
    this.runningPromise.start();
    return this;
  }

  public async stop(): Promise<void> {
    await this.runningPromise.stop();
  }

  private async setUpCurrentEpoch(): Promise<void> {
    const epoch = await this.rollup.getCurrentEpoch();
    if (epoch === this.lastEpochSetUp || (await this.rollup.isEpochSetUp(epoch))) {
      return;
    }
    try {
      const client = this.ethCheatCodes.publicClient;
      const rollup = getContract({ address: this.rollup.address, abi: RollupAbi, client });
      const hash = await rollup.write.setupEpoch({ account: this.sender.toString() });
      const receipt = await client.waitForTransactionReceipt({ hash });
      this.lastEpochSetUp = epoch;
      this.logger.verbose(`Set up epoch ${epoch} on L1`, { epoch, l1BlockNumber: receipt.blockNumber });
    } catch (err) {
      this.logger.warn(`Failed to set up epoch ${epoch} on L1`, { epoch, err });
    }
  }
}
