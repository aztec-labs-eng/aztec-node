import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';

/** What `EpochProofStatus` reads from: the archiver for the proven tip, the rollup contract for registrations. */
export type EpochProofStatusDeps = {
  l2BlockSource: Pick<L2BlockSource, 'getBlockNumber' | 'getBlockData' | 'isEpochComplete' | 'getL1Constants'>;
  rollupContract: Pick<RollupContract, 'getHasSubmittedFullEpochProof'>;
  proverId: EthAddress;
  dateProvider: DateProvider;
  bindings?: LoggerBindings;
};

/**
 * Answers questions about what L1 has proven so far:
 * - whether a block, or every block of an epoch, is proven;
 * - the last fully proven epoch and the next unproven one;
 * - whether L1 registered this prover's full-epoch proof of an epoch.
 *
 * The proven tip comes from the archiver and is read again on every call. The registration comes from the rollup
 * contract and is cached for one L2 slot.
 */
export class EpochProofStatus {
  private readonly log: Logger;
  /**
   * Cache of L1 reads of this prover's full-epoch proof registration, so an epoch is read at most once per L2 slot
   * instead of on every call. Each entry records the checkpoint count it was read for, when it was read, and the
   * answer:
   * - `true`: the proof is registered.
   * - `undefined`: L1 could not be read.
   *
   * `false` is not cached, so an epoch without our registration is read again on the next call.
   *
   * Entries expire after one slot, so an L1 reorg that drops a registration is noticed within a slot, and an L1
   * outage costs one slow read per slot. Expired entries are removed on every read, so the map holds only epochs read
   * within the last slot.
   */
  private readonly ownFullEpochProofs = new Map<
    EpochNumber,
    {
      length: number;
      registered: true | undefined;
      /** When the read happened, in milliseconds since the Unix epoch, as returned by `DateProvider.now()`. */
      readAtMs: number;
    }
  >();

  constructor(private readonly deps: EpochProofStatusDeps) {
    this.log = createLogger('prover-node:epoch-proof-status', deps.bindings);
  }

  /** True if the proven tip is at or past the block. False when nothing is proven yet. */
  public async isBlockProven(blockNumber: BlockNumber): Promise<boolean> {
    const provenBlock = await this.deps.l2BlockSource.getBlockNumber({ tag: 'proven' });
    if (!provenBlock || provenBlock <= 0) {
      return false;
    }
    return provenBlock >= blockNumber;
  }

  /** True if every block of the epoch is proven, which holds once its last block is. */
  public async isEpochFullyProven(epochNumber: EpochNumber): Promise<boolean> {
    const proven = await this.getProvenBlockAndEpoch();
    if (!proven) {
      return false;
    }
    if (epochNumber !== proven.epoch) {
      return epochNumber < proven.epoch;
    }
    return this.isProvenBlockLastOfItsEpoch(proven.block, proven.epoch);
  }

  /**
   * The last epoch whose blocks are all proven. That is the proven tip's epoch if the tip is the epoch's last block,
   * and the epoch before it otherwise.
   *
   * Returns undefined when:
   * - nothing is proven yet;
   * - the archiver holds no header for the proven block;
   * - the tip is partway through epoch 0.
   *
   * Undefined errs toward an earlier epoch. A restart seeded from it processes the partially proven epoch again
   * instead of trusting a stale tip.
   */
  public async getLastFullyProvenEpoch(): Promise<EpochNumber | undefined> {
    const proven = await this.getProvenBlockAndEpoch();
    if (!proven) {
      return undefined;
    }
    if (await this.isProvenBlockLastOfItsEpoch(proven.block, proven.epoch)) {
      return proven.epoch;
    }
    return proven.epoch > 0 ? EpochNumber(proven.epoch - 1) : undefined;
  }

  /**
   * The epoch of the first block after the proven tip, or undefined when the archiver does not hold that block.
   *
   * The answer moves forward only when the proven tip does. A caller that proves each epoch it returns therefore
   * proves epochs one at a time, in order.
   */
  public async getNextUnprovenEpoch(): Promise<EpochNumber | undefined> {
    const lastProven = (await this.deps.l2BlockSource.getBlockNumber({ tag: 'proven' })) ?? BlockNumber.ZERO;
    const header = (await this.deps.l2BlockSource.getBlockData({ number: BlockNumber(lastProven + 1) }))?.header;
    if (!header) {
      return undefined;
    }
    return getEpochAtSlot(header.getSlot(), await this.deps.l2BlockSource.getL1Constants());
  }

  /**
   * Reads whether L1 registered this prover's proof of the epoch, taken to have `length` checkpoints, as a full-epoch
   * proof.
   *
   * Returns:
   * - `true`: registered;
   * - `false`: not registered;
   * - `undefined`: L1 could not be read. Each caller decides what that means for it.
   *
   * `true` and `undefined` are cached for one L2 slot. `false` is read from L1 again on every call.
   */
  public async readOwnFullEpochProof(epoch: EpochNumber, length: number): Promise<boolean | undefined> {
    const { slotDuration } = await this.deps.l2BlockSource.getL1Constants();
    const now = this.deps.dateProvider.now();
    for (const [cachedEpoch, entry] of this.ownFullEpochProofs) {
      if (now - entry.readAtMs >= slotDuration * 1000) {
        this.ownFullEpochProofs.delete(cachedEpoch);
      }
    }
    const cached = this.ownFullEpochProofs.get(epoch);
    // A failed read is reused even if the checkpoint count has changed. During a catch-up the count grows on every
    // call, and treating each new count as a fresh read would retry L1 throughout an outage.
    if (cached && (cached.registered === undefined || cached.length === length)) {
      return cached.registered;
    }
    let registered: boolean | undefined;
    try {
      registered = await this.deps.rollupContract.getHasSubmittedFullEpochProof(epoch, length, this.deps.proverId);
    } catch (err) {
      this.log.warn(`Could not read our full-epoch proof registration for epoch ${epoch}`, { epoch, err });
      registered = undefined;
    }
    if (registered !== false) {
      this.ownFullEpochProofs.set(epoch, { length, registered, readAtMs: this.deps.dateProvider.now() });
    }
    return registered;
  }

  private async getProvenBlockAndEpoch(): Promise<{ block: BlockNumber; epoch: EpochNumber } | undefined> {
    const provenBlockNumber = await this.deps.l2BlockSource.getBlockNumber({ tag: 'proven' });
    if (!provenBlockNumber || provenBlockNumber <= 0) {
      return undefined;
    }
    const block = BlockNumber(provenBlockNumber);
    const header = (await this.deps.l2BlockSource.getBlockData({ number: block }))?.header;
    if (!header) {
      return undefined;
    }
    return { block, epoch: getEpochAtSlot(header.getSlot(), await this.deps.l2BlockSource.getL1Constants()) };
  }

  /**
   * The proven block is the last of its epoch if the next block is in a later epoch. With no next block, it is the
   * last one once the archiver reports the epoch complete.
   */
  private async isProvenBlockLastOfItsEpoch(
    provenBlockNumber: BlockNumber,
    provenEpoch: EpochNumber,
  ): Promise<boolean> {
    const nextHeader = (await this.deps.l2BlockSource.getBlockData({ number: BlockNumber(provenBlockNumber + 1) }))
      ?.header;
    if (nextHeader) {
      return getEpochAtSlot(nextHeader.getSlot(), await this.deps.l2BlockSource.getL1Constants()) > provenEpoch;
    }
    return this.deps.l2BlockSource.isEpochComplete(provenEpoch);
  }
}
