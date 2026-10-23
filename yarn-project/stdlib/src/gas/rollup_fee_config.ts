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
   * Last config successfully read from L1. Usually at most one polling interval old, but it stays at the last good
   * read for as long as L1 reads keep failing.
   */
  getFeeConfig(): RollupFeeConfig;
}

/**
 * Default polling interval. Each pass reads L1's block number through the client's cache, and reads the fee settings
 * only when that block is newer than the last read, so it is cheap.
 */
const DEFAULT_POLLING_INTERVAL_MS = 1_000;

/** Keeps a RollupFeeConfig in step with L1 by polling the rollup. */
export class RollupFeeConfigTracker implements RollupFeeConfigProvider {
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
    const l1BlockNumber = await rollup.client.getBlockNumber();
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

  /**
   * One pass of the polling loop: reads the config at L1's latest block. It takes the client's cached block number and
   * skips blocks it has already read, so a pass within the cache window costs no new reads, and a lagging RPC node
   * cannot move the value back. A failed read only logs: the last value stays until a later pass succeeds.
   */
  private async poll(): Promise<void> {
    try {
      const l1BlockNumber = await this.rollup.client.getBlockNumber();
      if (l1BlockNumber <= this.latest.l1BlockNumber) {
        return;
      }
      this.update(await readRollupFeeConfig(this.rollup, l1BlockNumber));
    } catch (err) {
      this.log.warn(`Failed to refresh rollup fee config from L1, keeping the last value`, {
        err,
        l1BlockNumber: this.latest.l1BlockNumber,
      });
    }
  }

  private update(config: RollupFeeConfig): void {
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
}

/**
 * A provider that never reads L1, for tests and for nodes that run without one. The default leaves the mana limit
 * effectively unbounded.
 */
export class TestRollupFeeConfigProvider implements RollupFeeConfigProvider {
  private config: RollupFeeConfig;

  constructor(config: Partial<RollupFeeConfig> = {}) {
    this.config = { ...DEFAULT_TEST_ROLLUP_FEE_CONFIG, ...config };
  }

  /** Replaces some of the values, as a governance update would. */
  public setFeeConfig(config: Partial<RollupFeeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public getFeeConfig(): RollupFeeConfig {
    return this.config;
  }
}

const DEFAULT_TEST_ROLLUP_FEE_CONFIG: RollupFeeConfig = {
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
