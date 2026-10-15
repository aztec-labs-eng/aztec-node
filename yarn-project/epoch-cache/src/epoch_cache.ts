import { createEthereumChain } from '@aztec-labs/ethereum/chain';
import { makeL1HttpTransport } from '@aztec-labs/ethereum/client';
import {
  CommitteeNotStableError,
  NoCommitteeError,
  RollupContract,
  isEpochNotStableError,
} from '@aztec-labs/ethereum/contracts';
import { getFinalizedL1Block } from '@aztec-labs/ethereum/queries';
import { maxBigint } from '@aztec-labs/foundation/bigint';
import { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Buffer32 } from '@aztec-labs/foundation/buffer';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import {
  type L1RollupConstants,
  getEpochAtSlot,
  getEpochNumberAtTimestamp,
  getNextL1SlotTimestamp,
  getSlotAtNextL1Block,
  getSlotAtTimestamp,
  getSlotRangeForEpoch,
  getStartTimestampForEpoch,
  getTimestampForSlot,
} from '@aztec-labs/stdlib/epoch-helpers';
import { createPublicClient, encodeAbiParameters, keccak256 } from 'viem';

import { type EpochCacheConfig, getEpochCacheConfigEnvVars } from './config.js';

/** The proposer pipelines by building one slot ahead. */
export const PROPOSER_PIPELINING_SLOT_OFFSET = 1;

/** Flat return type for compound epoch/slot getters. */
export type EpochAndSlot = {
  slot: SlotNumber;
  epoch: EpochNumber;
  ts: bigint;
};

export type EpochCommitteeInfo = {
  committee: EthAddress[] | undefined;
  seed: bigint;
  epoch: EpochNumber;
  /** True if the epoch is within an open escape hatch window. */
  isEscapeHatchOpen: boolean;
};

export type SlotTag = 'now' | 'next' | SlotNumber;

/** Minimal L1 block info used for cache provenance. */
type L1BlockInfo = { number: bigint; hash: `0x${string}`; timestamp: bigint };

/** Resolved cache entry for an epoch whose seed is fixed on L1, with L1 provenance metadata. */
type CachedEpochEntry = {
  kind: 'committee';
  data: EpochCommitteeInfo;
  /** L1 block number at which the committee data was originally queried. */
  lastQueryL1BlockNumber: bigint;
  /** L1 block hash at which the committee data was originally queried. Used to detect reorgs. */
  lastQueryL1BlockHash: `0x${string}`;
  /** Latest L1 block timestamp at the time of the most recent refresh (full fetch or lightweight check). */
  lastRefreshL1Timestamp: bigint;
  /** Whether the L1 block the entry was read at is finalized. */
  finalized: boolean;
};

/** Marker for an epoch whose seed could still change as of an L1 block. Re-checked against L1 once it expires. */
type UnstableEpochEntry = {
  kind: 'unstable';
  /** L1 block at which the seed was found not to be fixed yet. */
  l1BlockNumber: bigint;
  /**
   * Local time in seconds from which the marker no longer applies: one Ethereum slot after that block, or after the
   * check itself if the block is older than the local clock, so a lagging L1 tip is not re-checked on every call.
   */
  expiresAt: bigint;
};

type EpochEntry = CachedEpochEntry | UnstableEpochEntry;

export interface EpochCacheInterface {
  getCommittee(slot: SlotTag | undefined): Promise<EpochCommitteeInfo>;
  getSlotNow(): SlotNumber;
  getTargetSlot(): SlotNumber;
  getEpochNow(): EpochNumber;
  getTargetEpoch(): EpochNumber;
  getEpochAndSlotNow(): EpochAndSlot & { nowMs: bigint };
  getEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint };
  /** Returns epoch/slot info for the next L1 slot with pipeline offset applied. */
  getTargetEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint };
  isEscapeHatchOpen(epoch: EpochNumber): Promise<boolean>;
  isEscapeHatchOpenAtSlot(slot: SlotTag): Promise<boolean>;
  getProposerIndexEncoding(epoch: EpochNumber, slot: SlotNumber, seed: bigint): `0x${string}`;
  computeProposerIndex(slot: SlotNumber, epoch: EpochNumber, seed: bigint, size: bigint): bigint;
  getCurrentAndNextSlot(): { currentSlot: SlotNumber; nextSlot: SlotNumber };
  getTargetAndNextSlot(): { targetSlot: SlotNumber; nextSlot: SlotNumber };
  getProposerAttesterAddressInSlot(slot: SlotNumber): Promise<EthAddress | undefined>;
  getRegisteredValidators(): Promise<EthAddress[]>;
  isInCommittee(slot: SlotTag, validator: EthAddress): Promise<boolean>;
  filterInCommittee(slot: SlotTag, validators: EthAddress[]): Promise<EthAddress[]>;
  getL1Constants(): L1RollupConstants;
  getLagInEpochsForValidatorSet(): number;
}

/**
 * Epoch cache
 *
 * This class is responsible for managing traffic to the l1 node, by caching the validator set.
 * Keeps the last N epochs in cache.
 * It also provides a method to get the current or next proposer, and to check who is in the current slot.
 *
 * Note: This class is very dependent on the system clock being in sync.
 */
export class EpochCache implements EpochCacheInterface {
  /**
   * Single map holding both resolved entries and in-flight promises.
   * A `Promise` value means a fetch is in progress; concurrent callers await it.
   */
  protected cache: Map<EpochNumber, EpochEntry | Promise<EpochEntry>> = new Map();
  private allValidators: Set<string> = new Set();
  private lastValidatorRefresh = 0;
  private readonly log: Logger = createLogger('epoch-cache');

  constructor(
    private rollup: RollupContract,
    private readonly l1constants: L1RollupConstants & {
      lagInEpochsForValidatorSet: number;
      lagInEpochsForRandao: number;
    },
    private readonly dateProvider: DateProvider = new DateProvider(),
    protected readonly config = { cacheSize: 12, validatorRefreshIntervalSeconds: 60 },
  ) {
    this.log.debug(`Initialized EpochCache`, {
      l1constants,
    });
  }

  static async create(
    rollupOrAddress: EthAddress | RollupContract,
    config?: EpochCacheConfig,
    deps: { dateProvider?: DateProvider } = {},
  ) {
    config = config ?? getEpochCacheConfigEnvVars();

    // Load the rollup contract if we were given an address
    let rollup: RollupContract;
    if ('address' in rollupOrAddress) {
      rollup = rollupOrAddress;
    } else {
      const chain = createEthereumChain(config.l1RpcUrls, config.l1ChainId);
      const publicClient = createPublicClient({
        chain: chain.chainInfo,
        transport: makeL1HttpTransport(config.l1RpcUrls, { timeout: config.l1HttpTimeoutMS }),
        pollingInterval: config.viemPollingIntervalMS,
      });
      rollup = new RollupContract(publicClient, rollupOrAddress.toString());
    }

    const [
      l1StartBlock,
      l1GenesisTime,
      proofSubmissionEpochs,
      slotDuration,
      epochDuration,
      lagInEpochsForValidatorSet,
      lagInEpochsForRandao,
      targetCommitteeSize,
      rollupManaLimit,
    ] = await Promise.all([
      rollup.getL1StartBlock(),
      rollup.getL1GenesisTime(),
      rollup.getProofSubmissionEpochs(),
      rollup.getSlotDuration(),
      rollup.getEpochDuration(),
      rollup.getLagInEpochsForValidatorSet(),
      rollup.getLagInEpochsForRandao(),
      rollup.getTargetCommitteeSize(),
      rollup.getManaLimit(),
    ] as const);

    const l1RollupConstants = {
      l1StartBlock,
      l1GenesisTime,
      proofSubmissionEpochs: Number(proofSubmissionEpochs),
      slotDuration: Number(slotDuration),
      epochDuration: Number(epochDuration),
      ethereumSlotDuration: config.ethereumSlotDuration,
      lagInEpochsForValidatorSet: Number(lagInEpochsForValidatorSet),
      lagInEpochsForRandao: Number(lagInEpochsForRandao),
      targetCommitteeSize: Number(targetCommitteeSize),
      rollupManaLimit: Number(rollupManaLimit),
    };

    return new EpochCache(rollup, l1RollupConstants, deps.dateProvider, {
      cacheSize: 12,
      validatorRefreshIntervalSeconds: 60,
    });
  }

  public getL1Constants(): L1RollupConstants {
    return this.l1constants;
  }

  /**
   * The number of epochs by which validator-set sampling lags. The committee for epoch `E` samples the
   * validator set as of `lagInEpochsForValidatorSet` epochs before `E` (see
   * `ValidatorSelectionLib.stableEpochToValidatorSetSampleTime` on L1), so a newly staked validator only
   * becomes eligible for a committee this many epochs after staking.
   */
  public getLagInEpochsForValidatorSet(): number {
    return this.l1constants.lagInEpochsForValidatorSet;
  }

  public getSlotNow(): SlotNumber {
    return this.getEpochAndSlotNow().slot;
  }

  public getTargetSlot(): SlotNumber {
    const slotNow = this.getSlotNow();
    const offset = PROPOSER_PIPELINING_SLOT_OFFSET;
    return SlotNumber(slotNow + offset);
  }

  public getEpochNow(): EpochNumber {
    return this.getEpochAndSlotNow().epoch;
  }

  public getTargetEpoch(): EpochNumber {
    return getEpochAtSlot(this.getTargetSlot(), this.l1constants);
  }

  public getEpochAndSlotNow(): EpochAndSlot & { nowMs: bigint } {
    const nowMs = BigInt(this.dateProvider.now());
    const nowSeconds = nowMs / 1000n;
    return { ...this.getEpochAndSlotAtTimestamp(nowSeconds), nowMs };
  }

  private getEpochAndSlotAtSlot(slot: SlotNumber): EpochAndSlot {
    return this.getEpochAndSlotAtTimestamp(getTimestampForSlot(slot, this.l1constants));
  }

  public getEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    const nowSeconds = this.dateProvider.nowInSeconds();
    const nextSlotTs = getNextL1SlotTimestamp(nowSeconds, this.l1constants);
    return { ...this.getEpochAndSlotAtTimestamp(nextSlotTs), nowSeconds: BigInt(nowSeconds) };
  }

  public getTargetEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    const result = this.getEpochAndSlotInNextL1Slot();
    const offset = PROPOSER_PIPELINING_SLOT_OFFSET;
    const targetSlot = SlotNumber(result.slot + offset);
    return { ...result, slot: targetSlot, epoch: getEpochAtSlot(targetSlot, this.l1constants) };
  }

  private getEpochAndSlotAtTimestamp(ts: bigint): EpochAndSlot {
    const slot = getSlotAtTimestamp(ts, this.l1constants);
    const epoch = getEpochNumberAtTimestamp(ts, this.l1constants);
    return {
      slot,
      epoch,
      ts: getTimestampForSlot(slot, this.l1constants),
    };
  }

  public getCommitteeForEpoch(epoch: EpochNumber): Promise<EpochCommitteeInfo> {
    const [startSlot] = getSlotRangeForEpoch(epoch, this.l1constants);
    return this.getCommittee(startSlot);
  }

  /** Returns whether the escape hatch is open for the given epoch. */
  public async isEscapeHatchOpen(epoch: EpochNumber): Promise<boolean> {
    const info = await this.getCommitteeForEpoch(epoch);
    return info.isEscapeHatchOpen;
  }

  /**
   * Returns whether the escape hatch is open for the epoch containing the given slot.
   *
   * This is a lightweight helper intended for callers that already have a slot number and only
   * need the escape hatch flag (without pulling full committee info).
   */
  public async isEscapeHatchOpenAtSlot(slot: SlotTag = 'now'): Promise<boolean> {
    const epoch =
      slot === 'now'
        ? this.getEpochNow()
        : slot === 'next'
          ? this.getEpochAndSlotInNextL1Slot().epoch
          : getEpochAtSlot(slot, this.l1constants);

    return await this.isEscapeHatchOpen(epoch);
  }

  /**
   * Get the current validator set.
   *
   * Returns cached data if the entry is finalized or still fresh (queried less than one
   * Ethereum slot ago). Stale non-finalized entries are re-queried, and concurrent callers
   * coalesce on the same in-flight promise so the L1 query happens only once.
   *
   * Throws {@link CommitteeNotStableError} while the epoch's sample seed can still change on L1. Callers should treat
   * that as "not known yet": the same query succeeds once the seed is fixed.
   */
  public async getCommittee(slot: SlotTag = 'now'): Promise<EpochCommitteeInfo> {
    const { epoch, ts } = this.getEpochAndTimestamp(slot);

    const cached = this.cache.get(epoch);

    // In-flight promise: another caller is already fetching this epoch — just await it.
    if (cached instanceof Promise) {
      return this.getCommitteeFromEntry(epoch, await cached);
    }

    // Resolved entry: return it if finalized or still fresh.
    if (cached?.kind === 'committee' && (cached.finalized || !this.isStale(cached))) {
      return cached.data;
    }

    // The seed was not fixed as of the last check, and that check is less than one Ethereum slot old.
    if (cached?.kind === 'unstable' && !this.isExpired(cached)) {
      return this.getCommitteeFromEntry(epoch, cached);
    }

    // Stale non-finalized entry: do a lightweight refresh first (check block hash + finalized block).
    // Only fall back to a full re-fetch if the L1 block was reorged. Otherwise, do a full fetch.
    const promise =
      cached?.kind === 'committee' ? this.refreshStaleEntry(cached, epoch, ts) : this.fetchAndCache(epoch, ts);
    this.cache.set(epoch, promise);
    return this.getCommitteeFromEntry(epoch, await promise);
  }

  private getCommitteeFromEntry(epoch: EpochNumber, entry: EpochEntry): EpochCommitteeInfo {
    if (entry.kind === 'unstable') {
      throw new CommitteeNotStableError(BigInt(epoch), entry.l1BlockNumber);
    }
    return entry.data;
  }

  private getEpochAndTimestamp(slot: SlotTag = 'now'): { epoch: EpochNumber; ts: bigint } {
    if (slot === 'now') {
      return this.getEpochAndSlotNow();
    } else if (slot === 'next') {
      return this.getEpochAndSlotInNextL1Slot();
    } else {
      return this.getEpochAndSlotAtSlot(slot);
    }
  }

  /** Evicts oldest cache entries (resolved or in-flight) beyond cacheSize. */
  private purgeCache(): void {
    if (this.cache.size <= this.config.cacheSize) {
      return;
    }
    const toPurge = Array.from(this.cache.keys())
      .sort((a, b) => Number(b - a))
      .slice(this.config.cacheSize);
    toPurge.forEach(key => this.cache.delete(key));
  }

  /** Returns true if a non-finalized cache entry is older than one Ethereum slot. */
  private isStale(entry: CachedEpochEntry): boolean {
    const nowSeconds = BigInt(this.dateProvider.nowInSeconds());
    return nowSeconds - entry.lastRefreshL1Timestamp >= BigInt(this.l1constants.ethereumSlotDuration);
  }

  private isExpired(entry: UnstableEpochEntry): boolean {
    return BigInt(this.dateProvider.nowInSeconds()) >= entry.expiresAt;
  }

  /** Whether a cached epoch entry has been marked as finalized. Returns undefined if not cached, in-flight or unstable. */
  public isFinalized(epoch: EpochNumber): boolean | undefined {
    const entry = this.cache.get(epoch);
    if (!entry || entry instanceof Promise || entry.kind !== 'committee') {
      return undefined;
    }
    return entry.finalized;
  }

  /** Returns the latest L1 timestamp stored in the cached entry. Undefined if not cached, in-flight or unstable. */
  public getCachedLastRefreshL1Timestamp(epoch: EpochNumber): bigint | undefined {
    const entry = this.cache.get(epoch);
    if (!entry || entry instanceof Promise || entry.kind !== 'committee') {
      return undefined;
    }
    return entry.lastRefreshL1Timestamp;
  }

  /** Computes the sampling timestamp for an epoch's committee data. */
  private getSamplingTimestamp(epoch: EpochNumber): bigint {
    const { lagInEpochsForRandao, epochDuration, slotDuration } = this.l1constants;
    const epochStartTs = getStartTimestampForEpoch(epoch, this.l1constants);
    return epochStartTs - BigInt(lagInEpochsForRandao) * BigInt(epochDuration) * BigInt(slotDuration);
  }

  /**
   * Whether the sample seed for `epoch` is fixed as of the given L1 block. The seed for epoch E hashes the randao
   * that L1 checkpoints in epoch S = E - lagInEpochsForRandao, under the key start(S). It is fixed once that randao
   * is written, or once S is over, since any later checkpoint is keyed at a later epoch's start.
   */
  private async isSeedFixed(epoch: EpochNumber, block: L1BlockInfo): Promise<boolean> {
    const { targetCommitteeSize, lagInEpochsForRandao, epochDuration, slotDuration } = this.l1constants;

    // The seed is irrelevant when the committee is empty and anyone may propose.
    if (targetCommitteeSize === 0) {
      return true;
    }

    // Epochs sampled before genesis read the zero randao that precedes the genesis checkpoint.
    const samplingEpoch = BigInt(epoch) - BigInt(lagInEpochsForRandao);
    if (samplingEpoch < 0n) {
      return true;
    }

    const samplingEpochStart = this.getSamplingTimestamp(epoch);
    const samplingEpochEnd = samplingEpochStart + BigInt(epochDuration) * BigInt(slotDuration);
    if (block.timestamp >= samplingEpochEnd) {
      return true;
    }
    if (block.timestamp < samplingEpochStart) {
      return false;
    }

    // The v6 rollup's committee and seed views do not revert while the sampled epoch's randao can still change, so
    // infer the randao write from storage: setupEpoch is the only writer of the sampled epoch's committee commitment,
    // and it checkpoints that epoch's randao before storing the commitment. A bare checkpointRandao call goes
    // undetected and falls back to the end-of-epoch rule above. This read can be dropped once every supported rollup
    // reverts with ValidatorSelection__EpochNotStable instead (v7 onwards).
    return await this.rollup.isEpochSetUp(EpochNumber.fromBigInt(samplingEpoch), { blockNumber: block.number });
  }

  /**
   * Lightweight refresh for a stale non-finalized entry. Queries only the block hash at
   * the original block number and the finalized block — avoids the expensive
   * getCommitteeAt and getSampleSeedAt calls on the rollup contract.
   *
   * If the block hash still matches (no L1 reorg), we keep the existing data and just
   * update the provenance timestamp. If the finalized block has caught up, we promote the
   * entry to finalized. If there was a reorg (hash mismatch), we fall back to a full fetch,
   * and drop the stale entry if that fetch fails.
   */
  private async refreshStaleEntry(stale: CachedEpochEntry, epoch: EpochNumber, ts: bigint): Promise<EpochEntry> {
    let blockAtOriginal: L1BlockInfo, l1FinalizedBlock: L1BlockInfo | undefined, latestBlock: L1BlockInfo;
    try {
      [blockAtOriginal, l1FinalizedBlock, latestBlock] = await Promise.all([
        this.rollup.client.getBlock({ blockNumber: stale.lastQueryL1BlockNumber, includeTransactions: false }),
        getFinalizedL1Block(this.rollup.client),
        this.rollup.client.getBlock({ includeTransactions: false }),
      ]);
    } catch (err) {
      this.cache.set(epoch, stale);
      throw err;
    }

    if (blockAtOriginal.hash === stale.lastQueryL1BlockHash) {
      // No reorg: the data is still valid. Check if we can now mark it as finalized.
      const refreshed: CachedEpochEntry = {
        ...stale,
        lastRefreshL1Timestamp: latestBlock.timestamp,
        finalized: this.isEntryFinalized(stale.data.committee, stale.lastQueryL1BlockNumber, l1FinalizedBlock),
      };
      this.cache.set(epoch, refreshed);
      return refreshed;
    }

    // Reorg detected: block hash mismatch. Do a full re-fetch.
    // Pass the already-fetched blocks to avoid redundant queries.
    this.log.warn(`L1 reorg detected for epoch ${epoch}: block ${stale.lastQueryL1BlockNumber} hash changed`, {
      epoch,
      expectedHash: stale.lastQueryL1BlockHash,
      actualHash: blockAtOriginal.hash,
    });
    return this.fetchAndCache(epoch, ts, { latestBlock, finalizedBlock: l1FinalizedBlock });
  }

  /**
   * Fetches committee data from L1, determines finalization status, and stores in the cache. If the epoch's seed can
   * still change as of the latest L1 block, stores an unstable marker that expires one Ethereum slot later instead.
   * Removes the epoch from the cache if the fetch fails.
   *
   * When called from refreshStaleEntry after a reorg, the latest and finalized blocks are
   * passed in to avoid redundant L1 queries.
   */
  private async fetchAndCache(
    epoch: EpochNumber,
    ts: bigint,
    prefetched?: { latestBlock: L1BlockInfo; finalizedBlock: L1BlockInfo | undefined },
  ): Promise<EpochEntry> {
    try {
      const entry = await this.fetchEntry(epoch, ts, prefetched);
      this.cache.set(epoch, entry);
      this.purgeCache();
      return entry;
    } catch (err) {
      this.cache.delete(epoch);
      throw err;
    }
  }

  private async fetchEntry(
    epoch: EpochNumber,
    ts: bigint,
    prefetched?: { latestBlock: L1BlockInfo; finalizedBlock: L1BlockInfo | undefined },
  ): Promise<EpochEntry> {
    // Pin the rollup reads to one L1 block so the entry's provenance matches the data it holds. The escape hatch flag
    // is only partly pinned: the hatch address is resolved at the latest block, and any read error counts as closed.
    const latestBlock = prefetched?.latestBlock ?? (await this.rollup.client.getBlock({ includeTransactions: false }));
    const blockNumber = latestBlock.number;
    const unstable: UnstableEpochEntry = {
      kind: 'unstable',
      l1BlockNumber: blockNumber,
      expiresAt:
        maxBigint(latestBlock.timestamp, BigInt(this.dateProvider.nowInSeconds())) +
        BigInt(this.l1constants.ethereumSlotDuration),
    };

    if (!(await this.isSeedFixed(epoch, latestBlock))) {
      this.log.debug(`Committee for epoch ${epoch} is not stable yet as of L1 block ${blockNumber}`, {
        epoch,
        l1BlockNumber: blockNumber,
        l1BlockTimestamp: latestBlock.timestamp,
      });
      return unstable;
    }

    let committee: EthAddress[] | undefined, seedBuffer: Buffer32, isEscapeHatchOpen: boolean;
    let finalizedBlock: L1BlockInfo | undefined;
    try {
      [committee, seedBuffer, finalizedBlock, isEscapeHatchOpen] = await Promise.all([
        this.rollup.getCommitteeAt(ts, { blockNumber }),
        this.rollup.getSampleSeedAt(ts, { blockNumber }),
        prefetched !== undefined ? prefetched.finalizedBlock : getFinalizedL1Block(this.rollup.client),
        this.rollup.isEscapeHatchOpen(epoch, { blockNumber }),
      ]);
    } catch (err) {
      if (isEpochNotStableError(err)) {
        return unstable;
      }
      throw err;
    }

    // Reads by block number follow the canonical chain, so a reorg mid-fetch could mix the seed check above with
    // committee data from another fork. Confirm the queried block is still canonical before trusting the reads.
    const queriedBlock = await this.rollup.client.getBlock({ blockNumber, includeTransactions: false });
    if (queriedBlock.hash !== latestBlock.hash) {
      throw new Error(`L1 block ${blockNumber} was reorged out while reading the committee for epoch ${epoch}`);
    }

    const entry: CachedEpochEntry = {
      kind: 'committee',
      data: { committee, seed: seedBuffer.toBigInt(), epoch, isEscapeHatchOpen },
      lastQueryL1BlockNumber: blockNumber,
      lastQueryL1BlockHash: latestBlock.hash,
      lastRefreshL1Timestamp: latestBlock.timestamp,
      finalized: this.isEntryFinalized(committee, blockNumber, finalizedBlock),
    };
    return entry;
  }

  /**
   * An entry is read only once its seed is fixed, so its committee and seed can no longer change once the L1 block it
   * was read at is finalized. The escape hatch flag carries no such guarantee, since its read treats errors as closed
   * and resolves the hatch address at the latest block. Empty committees are never marked finalized so they always get re-queried after TTL. If L1 has no
   * finalized block yet (devnet startup), entries stay unfinalized.
   */
  private isEntryFinalized(
    committee: EthAddress[] | undefined,
    queryL1BlockNumber: bigint,
    finalizedBlock: L1BlockInfo | undefined,
  ): boolean {
    const hasCommittee = !!(committee && committee.length > 0);
    return hasCommittee && finalizedBlock !== undefined && finalizedBlock.number >= queryL1BlockNumber;
  }

  /**
   * Get the ABI encoding of the proposer index - see ValidatorSelectionLib.sol computeProposerIndex
   */
  getProposerIndexEncoding(epoch: EpochNumber, slot: SlotNumber, seed: bigint): `0x${string}` {
    return encodeAbiParameters(
      [
        { type: 'uint256', name: 'epoch' },
        { type: 'uint256', name: 'slot' },
        { type: 'uint256', name: 'seed' },
      ],
      [BigInt(epoch), BigInt(slot), seed],
    );
  }

  public computeProposerIndex(slot: SlotNumber, epoch: EpochNumber, seed: bigint, size: bigint): bigint {
    // if committe size is 0, then mod 1 is 0
    if (size === 0n) {
      return 0n;
    }
    return BigInt(keccak256(this.getProposerIndexEncoding(epoch, slot, seed))) % size;
  }

  /** Returns the current and next L2 slot in next eth L1 Slot. */
  public getCurrentAndNextSlot(): { currentSlot: SlotNumber; nextSlot: SlotNumber } {
    const currentSlot = this.getSlotNow();
    const next = this.getEpochAndSlotInNextL1Slot();

    return {
      currentSlot,
      nextSlot: next.slot,
    };
  }

  /** Returns the target and next L2 slot in the next L1 slot. */
  public getTargetAndNextSlot(): { targetSlot: SlotNumber; nextSlot: SlotNumber } {
    const nowSeconds = BigInt(this.dateProvider.nowInSeconds());
    const offset = PROPOSER_PIPELINING_SLOT_OFFSET;

    const currentSlot = getSlotAtTimestamp(nowSeconds, this.l1constants);
    const targetSlot = SlotNumber(currentSlot + offset);

    const nextL2SlotOnL1 = getSlotAtNextL1Block(nowSeconds, this.l1constants);
    const nextSlot = SlotNumber(nextL2SlotOnL1 + offset);

    return { targetSlot, nextSlot };
  }

  /**
   * Get the proposer attester address in the given L2 slot
   * @returns The proposer attester address. If the committee does not exist, we throw a NoCommitteeError.
   * If the committee is empty (i.e. target committee size is 0, and anyone can propose), we return undefined.
   */
  public getProposerAttesterAddressInSlot(slot: SlotNumber): Promise<EthAddress | undefined> {
    const epochAndSlot = this.getEpochAndSlotAtSlot(slot);
    return this.getProposerAttesterAddressAt(epochAndSlot);
  }

  /**
   * Get the proposer attester address in the next slot
   * @returns The proposer attester address. If the committee does not exist, we throw a NoCommitteeError.
   * If the committee is empty (i.e. target committee size is 0, and anyone can propose), we return undefined.
   */
  public getProposerAttesterAddressInNextSlot(): Promise<EthAddress | undefined> {
    const epochAndSlot = this.getEpochAndSlotInNextL1Slot();
    return this.getProposerAttesterAddressAt(epochAndSlot);
  }

  /**
   * Get the proposer attester address at a given epoch and slot
   * @param when - The epoch and slot to get the proposer attester address at
   * @returns The proposer attester address. If the committee does not exist, we throw a NoCommitteeError.
   * If the committee is empty (i.e. target committee size is 0, and anyone can propose), we return undefined.
   */
  private async getProposerAttesterAddressAt(when: EpochAndSlot) {
    const { epoch, slot } = when;
    const { committee, seed } = await this.getCommittee(slot);
    if (!committee) {
      throw new NoCommitteeError();
    } else if (committee.length === 0) {
      return undefined;
    }

    const proposerIndex = this.computeProposerIndex(slot, epoch, seed, BigInt(committee.length));
    return committee[Number(proposerIndex)];
  }

  public getProposerFromEpochCommittee(
    epochCommitteeInfo: EpochCommitteeInfo,
    slot: SlotNumber,
  ): EthAddress | undefined {
    if (!epochCommitteeInfo.committee || epochCommitteeInfo.committee.length === 0) {
      return undefined;
    }
    const proposerIndex = this.computeProposerIndex(
      slot,
      epochCommitteeInfo.epoch,
      epochCommitteeInfo.seed,
      BigInt(epochCommitteeInfo.committee.length),
    );

    return epochCommitteeInfo.committee[Number(proposerIndex)];
  }

  /** Check if a validator is in the given slot's committee */
  async isInCommittee(slot: SlotTag, validator: EthAddress): Promise<boolean> {
    const { committee } = await this.getCommittee(slot);
    if (!committee) {
      return false;
    }
    return committee.some(v => v.equals(validator));
  }

  /** From the set of given addresses, return all that are on the committee for the given slot */
  async filterInCommittee(slot: SlotTag, validators: EthAddress[]): Promise<EthAddress[]> {
    const { committee } = await this.getCommittee(slot);
    if (!committee) {
      return [];
    }
    const committeeSet = new Set(committee.map(v => v.toString()));
    return validators.filter(v => committeeSet.has(v.toString()));
  }

  async getRegisteredValidators(): Promise<EthAddress[]> {
    const validatorRefreshIntervalMs = this.config.validatorRefreshIntervalSeconds * 1000;
    const validatorRefreshTime = this.lastValidatorRefresh + validatorRefreshIntervalMs;
    const now = this.dateProvider.now();
    if (validatorRefreshTime < now) {
      const currentSet = await this.rollup.getAttesters(BigInt(Math.floor(now / 1000)));
      this.allValidators = new Set(currentSet.map(v => v.toString()));
      this.lastValidatorRefresh = now;
    }
    return Array.from(this.allValidators.keys()).map(v => EthAddress.fromString(v));
  }
}
