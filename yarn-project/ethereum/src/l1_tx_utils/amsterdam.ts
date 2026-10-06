import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';

import { AMSTERDAM_MAX_L1_TX_LIMIT, MAX_L1_TX_LIMIT } from './constants.js';

/**
 * Returns whether an L1 block was produced under the Amsterdam (Glamsterdam) execution-layer fork, which adds the
 * EIP-7928 `blockAccessListHash` header field. Accepts both viem-formatted blocks (viem keeps unknown RPC fields) and
 * raw `eth_getBlockByNumber` results.
 */
export function isAmsterdamBlock(block: object | null | undefined): boolean {
  return !!block && 'blockAccessListHash' in block && !!block.blockAccessListHash;
}

/** Returns the gas limit cap we apply to an L1 tx, depending on whether the Amsterdam fork is active. */
export function getMaxL1TxGasLimit(isAmsterdam: boolean): bigint {
  return isAmsterdam ? AMSTERDAM_MAX_L1_TX_LIMIT : MAX_L1_TX_LIMIT;
}

/** Source of the latest L1 block, such as a viem client or an L1TxUtils instance. */
export type LatestL1BlockSource = { getBlock(): Promise<object> };

/**
 * Tracks whether the Amsterdam fork is active on L1 by inspecting the latest block. Activation is cached for good since
 * the fork does not revert. Until then, a block seen through {@link observe} within the last `maxBlockAgeMs` answers
 * {@link isActive} without another RPC call, so callers that already fetch the latest block do not pay for a second
 * fetch.
 */
export class AmsterdamForkDetector {
  private active = false;
  private lastObservedAtMs: number | undefined;

  constructor(
    private readonly blockSource: LatestL1BlockSource,
    private readonly opts: { maxBlockAgeMs?: number; dateProvider?: DateProvider; log?: Logger } = {},
  ) {}

  /** Records a freshly fetched latest L1 block. */
  public observe(block: object | null | undefined): void {
    if (isAmsterdamBlock(block)) {
      this.active = true;
    }
    this.lastObservedAtMs = this.now();
  }

  /** Returns whether the Amsterdam fork is active, fetching the latest L1 block unless a recent one was observed. */
  public async isActive(): Promise<boolean> {
    if (this.active) {
      return true;
    }
    const maxBlockAgeMs = this.opts.maxBlockAgeMs ?? 12_000;
    if (this.lastObservedAtMs !== undefined && this.now() - this.lastObservedAtMs < maxBlockAgeMs) {
      return false;
    }
    try {
      this.observe(await this.blockSource.getBlock());
    } catch (err) {
      (this.opts.log ?? createLogger('ethereum:amsterdam-fork-detector')).warn(
        'Failed to fetch latest L1 block to detect the Amsterdam fork, assuming it is not active',
        err,
      );
    }
    return this.active;
  }

  private now(): number {
    return (this.opts.dateProvider ?? new DateProvider()).now();
  }
}
