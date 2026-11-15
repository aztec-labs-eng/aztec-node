import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';

export type EpochProofStatusDeps = {
  l2BlockSource: Pick<L2BlockSource, 'getBlockNumber' | 'getBlockData' | 'isEpochComplete' | 'getL1Constants'>;
  rollupContract: Pick<RollupContract, 'getHasSubmittedFullEpochProof'>;
  proverId: EthAddress;
  dateProvider: DateProvider;
  bindings?: LoggerBindings;
};

/**
 * Answers what L1 has proven so far: where the proven tip is, which epochs it fully covers, and whether this prover
 * holds a full-epoch proof of an epoch. Reads the proven tip from the archiver on every call.
 */
export class EpochProofStatus {
  private readonly log: Logger;
  /**
   * Reads of our full-epoch proof registration from the last L2 slot that did not find it missing: `true`
   * (registered) or `undefined` (L1 could not be read), with the checkpoint count and when it was read. An epoch is
   * then read once per L2 slot rather than on every call: a confirmed registration still notices an L1 reorg that
   * drops it, and an L1 outage costs one slow read per slot. Entries older than a slot are dropped on each read, so
   * the map holds at most the epochs read within one slot.
   */
  private readonly ownFullEpochProofs = new Map<
    EpochNumber,
    { length: number; registered: true | undefined; readAtMs: number }
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
   * The last epoch whose blocks are all proven: the proven tip's epoch when the tip is that epoch's last block,
   * otherwise the epoch before it. Undefined when no such epoch exists.
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

  /** The epoch of the first block after the proven tip, or undefined when the archiver does not hold that block. */
  public async getNextUnprovenEpoch(): Promise<EpochNumber | undefined> {
    const lastProven = (await this.deps.l2BlockSource.getBlockNumber({ tag: 'proven' })) ?? BlockNumber.ZERO;
    const header = (await this.deps.l2BlockSource.getBlockData({ number: BlockNumber(lastProven + 1) }))?.header;
    if (!header) {
      return undefined;
    }
    return getEpochAtSlot(header.getSlot(), await this.deps.l2BlockSource.getL1Constants());
  }

  /**
   * Whether L1 registered this prover's proof of the epoch's `length` checkpoints as a full-epoch proof, or undefined
   * if L1 could not be read. Callers decide what an unread registration means for them. Answers other than `false`
   * are reused for one L2 slot.
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
    // A failed read is reused whatever the count: while a catch-up fills the store, the count changes from call to
    // call, and each change would otherwise retry L1 during an outage.
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
