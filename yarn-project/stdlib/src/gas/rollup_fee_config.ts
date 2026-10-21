import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';

/** Rollup fee settings that governance can change on L1, as read at one L1 block. */
export type RollupFeeConfig = {
  manaTarget: bigint;
  /** Read from L1 (getManaLimit), not derived as 2 x target. */
  manaLimit: bigint;
  provingCostPerManaInEth: bigint;
  protocolFeeMarginBps: number;
  /** L1 block the values were read at. */
  l1BlockNumber: bigint;
};

/** Source of the rollup's live fee settings. */
export interface RollupFeeConfigProvider {
  /**
   * Last config successfully read from L1. Usually at most one refresh interval old, but it stays at the last good
   * read for as long as L1 reads keep failing.
   */
  getFeeConfig(): RollupFeeConfig;
  /** Config as of the given L1 block, for callers pricing fees at a pinned block. */
  getFeeConfigAt(l1BlockNumber: bigint): Promise<RollupFeeConfig>;
  /**
   * Re-reads L1 now and returns the result. For a caller about to reject on a cached limit. Afterwards
   * getFeeConfig() returns this value or a newer one. Rejects when the read fails, leaving the cached value as it
   * was, so the caller can tell a confirmed limit from one it could not re-read.
   */
  refresh(): Promise<RollupFeeConfig>;
}

/** Default refresh interval: one L1 slot. */
const DEFAULT_POLLING_INTERVAL_MS = 12_000;

/** How many pinned reads are kept, so pinned readers on the same few sync points share them. */
const PINNED_READS_TO_KEEP = 8;

/** Keeps a RollupFeeConfig in step with L1 by polling the rollup. */
export class RollupFeeConfigTracker implements RollupFeeConfigProvider {
  /** Pinned reads by L1 block number, including the ones still in flight. */
  private readonly pinnedReads = new Map<bigint, Promise<RollupFeeConfig>>();
  private readonly loop: RunningPromise;

  private constructor(
    private readonly rollup: RollupContract,
    private latest: RollupFeeConfig,
    pollingIntervalMs: number,
    private readonly log: Logger,
  ) {
    this.loop = new RunningPromise(() => this.poll(), log, pollingIntervalMs);
  }

  /** Does the first read, so getFeeConfig() always has a value. */
  public static async create(
    rollup: RollupContract,
    opts: { pollingIntervalMs?: number; logger?: Logger } = {},
  ): Promise<RollupFeeConfigTracker> {
    const log = opts.logger ?? createLogger('rollup-fee-config');
    const l1BlockNumber = await rollup.client.getBlockNumber({ cacheTime: 0 });
    const initial = await readRollupFeeConfig(rollup, l1BlockNumber);
    log.info(`Read rollup fee config at L1 block ${l1BlockNumber}`, initial);
    return new RollupFeeConfigTracker(rollup, initial, opts.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS, log);
  }

  public start(): void {
    this.loop.start();
  }

  public async stop(): Promise<void> {
    await this.loop.stop();
  }

  public getFeeConfig(): RollupFeeConfig {
    return this.latest;
  }

  public getFeeConfigAt(l1BlockNumber: bigint): Promise<RollupFeeConfig> {
    const cached = this.pinnedReads.get(l1BlockNumber);
    if (cached) {
      return cached;
    }

    const read = readRollupFeeConfig(this.rollup, l1BlockNumber).then(config => {
      this.offer(config);
      return config;
    });
    this.pinnedReads.set(l1BlockNumber, read);
    // A failed read is dropped so the next caller for that block retries it. The rejection still reaches the caller.
    read.catch(() => {
      if (this.pinnedReads.get(l1BlockNumber) === read) {
        this.pinnedReads.delete(l1BlockNumber);
      }
    });
    this.evictOldestPinnedReads();
    return read;
  }

  /** Re-reads L1 at its latest block. Rejects when the read fails, keeping the last value. */
  public async refresh(): Promise<RollupFeeConfig> {
    const l1BlockNumber = await this.rollup.client.getBlockNumber({ cacheTime: 0 });
    this.offer(await readRollupFeeConfig(this.rollup, l1BlockNumber));
    return this.latest;
  }

  /** One pass of the polling loop. A failed read only logs: the last value stays until a later pass succeeds. */
  private async poll(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.log.warn(`Failed to refresh rollup fee config from L1, keeping the last value`, {
        err,
        l1BlockNumber: this.latest.l1BlockNumber,
      });
    }
  }

  /** Takes the read as the latest value unless it is older: a lagging RPC node must not move the value back. */
  private offer(config: RollupFeeConfig): void {
    if (config.l1BlockNumber <= this.latest.l1BlockNumber) {
      return;
    }
    const previous = this.latest;
    this.latest = config;
    if (
      config.manaTarget !== previous.manaTarget ||
      config.manaLimit !== previous.manaLimit ||
      config.provingCostPerManaInEth !== previous.provingCostPerManaInEth ||
      config.protocolFeeMarginBps !== previous.protocolFeeMarginBps
    ) {
      this.log.info(`Rollup fee config changed at L1 block ${config.l1BlockNumber}`, config);
    }
  }

  private evictOldestPinnedReads(): void {
    while (this.pinnedReads.size > PINNED_READS_TO_KEEP) {
      let oldest: bigint | undefined;
      for (const blockNumber of this.pinnedReads.keys()) {
        if (oldest === undefined || blockNumber < oldest) {
          oldest = blockNumber;
        }
      }
      this.pinnedReads.delete(oldest!);
    }
  }
}

/**
 * A provider that never reads L1, for tests and for nodes that run without one. The default leaves the mana limit
 * effectively unbounded.
 */
export class FixedRollupFeeConfigProvider implements RollupFeeConfigProvider {
  private config: RollupFeeConfig;

  constructor(config: Partial<RollupFeeConfig> = {}) {
    this.config = { ...DEFAULT_FIXED_ROLLUP_FEE_CONFIG, ...config };
  }

  /** Replaces some of the values, as a governance update would. */
  public setFeeConfig(config: Partial<RollupFeeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getFeeConfig(): RollupFeeConfig {
    return this.config;
  }

  public getFeeConfigAt(_l1BlockNumber: bigint): Promise<RollupFeeConfig> {
    return Promise.resolve(this.config);
  }

  public refresh(): Promise<RollupFeeConfig> {
    return Promise.resolve(this.config);
  }
}

const DEFAULT_FIXED_ROLLUP_FEE_CONFIG: RollupFeeConfig = {
  manaTarget: BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 2)),
  manaLimit: BigInt(Number.MAX_SAFE_INTEGER),
  provingCostPerManaInEth: 0n,
  protocolFeeMarginBps: 0,
  l1BlockNumber: 0n,
};

/** Reads every fee setting at the same L1 block, so the values describe one state. */
async function readRollupFeeConfig(rollup: RollupContract, l1BlockNumber: bigint): Promise<RollupFeeConfig> {
  const opts = { blockNumber: l1BlockNumber };
  const [manaTarget, manaLimit, provingCostPerManaInEth, protocolFeeMarginBps] = await Promise.all([
    rollup.getManaTarget(opts),
    rollup.getManaLimit(opts),
    rollup.getProvingCostPerMana(opts),
    rollup.getProtocolFeeMargin(opts),
  ]);
  return { manaTarget, manaLimit, provingCostPerManaInEth, protocolFeeMarginBps, l1BlockNumber };
}
