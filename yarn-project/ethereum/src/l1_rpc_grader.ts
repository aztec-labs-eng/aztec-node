import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { executeTimeout } from '@aztec-labs/foundation/timer';

import type { L1RpcGraderConfig } from './l1_reader.js';

/** Queries the grader sends to a single L1 RPC URL, identified by its index in the configured list. */
export type L1RpcProbes = {
  /** Returns the latest block number the URL reports. */
  getBlockNumber(index: number): Promise<bigint>;
  /** Returns the chain id the URL reports. */
  getChainId(index: number): Promise<number>;
};

/** Options for {@link L1RpcGrader}. */
export type L1RpcGraderOptions = {
  /** Grader settings. */
  config: L1RpcGraderConfig;
  /** Chain id every URL must report. A URL on another chain is never used. */
  chainId: number;
  /** Called with the new order, as indices into the configured URLs, whenever it changes. */
  onOrderChange?: (order: readonly number[]) => void;
  /** Logger for demotions, restorations and chain mismatches. */
  logger?: Logger;
};

/**
 * Tracks whether a URL's recent samples were good or bad. The URL is demoted once `threshold` of its last `window`
 * samples are bad, so a URL that alternates between good and bad answers is still demoted when `threshold` is below
 * `window`. It is restored once `threshold` samples in a row are good.
 */
class SampleWindow {
  private samples: boolean[] = [];
  private goodStreak = 0;
  private demoted = false;

  constructor(
    private readonly threshold: number,
    private readonly window: number,
  ) {}

  public isDemoted(): boolean {
    return this.demoted;
  }

  public record(bad: boolean): void {
    this.samples.push(bad);
    if (this.samples.length > this.window) {
      this.samples.shift();
    }
    this.goodStreak = bad ? 0 : this.goodStreak + 1;

    if (!this.demoted && this.samples.filter(sample => sample).length >= this.threshold) {
      this.demoted = true;
    } else if (this.demoted && this.goodStreak >= this.threshold) {
      this.demoted = false;
      // The bad samples that caused the demotion are still in the window and would demote the URL again at once.
      this.samples = [];
    }
  }
}

type UrlState = {
  /** Whether the URL reported the expected chain id. Checked until a probe succeeds, then never again. */
  chain: 'unchecked' | 'ok' | 'mismatch';
  /** Recent samples, where both lagging and failed probes count as bad. */
  samples: SampleWindow;
  /** Blocks behind the head in the URL's last successful probe. A failed probe leaves it as it was. */
  blocksBehind?: bigint;
  /** Whether the URL's last probe failed or timed out. */
  unreachable: boolean;
};

type ProbeResult = { type: 'ok'; blockNumber: bigint } | { type: 'unreachable' } | { type: 'wrong-chain' };

/**
 * Probes every L1 RPC URL for its latest block number on a fixed interval, and orders the URLs so that requests go to
 * the ones that keep up with the chain. The head is the highest block number any URL has reported so far, so losing
 * the URL that is furthest ahead does not make a lagging one look caught up. A sample is bad when the URL trails the
 * head by more than `l1RpcGraderMaxBlocksBehind` blocks, which also absorbs a shallow reorg, or when its probe fails or
 * times out. Only a probe that answers within that many blocks is good, so a failed probe never counts towards
 * restoring a URL that was demoted for lagging: it stays out until it shows that it caught up.
 *
 * The order is the healthy URLs in the configured order. Demoted URLs are left out, unless `l1RpcGraderKeepDemoted`
 * is set, which puts them after the healthy ones in the configured order. When every URL is demoted, the grader falls
 * back to the configured order. A URL that reports a chain id other than the expected one is never used again, not
 * even in that fallback, so the order is empty when every URL is on the wrong chain.
 */
export class L1RpcGrader {
  private readonly states: UrlState[];
  private order: readonly number[];
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private currentRound: Promise<void> | undefined;
  private allDemoted = false;
  private head = -1n;
  private readonly log: Logger;

  constructor(
    private readonly urls: readonly string[],
    private readonly probes: L1RpcProbes,
    private readonly opts: L1RpcGraderOptions,
  ) {
    const { l1RpcGraderThreshold: threshold, l1RpcGraderWindow: window } = opts.config;
    if (!Number.isInteger(threshold) || threshold < 1 || !Number.isInteger(window) || window < threshold) {
      throw new Error(`Invalid L1 RPC grader settings: need 1 <= threshold (${threshold}) <= window (${window})`);
    }
    this.log = opts.logger ?? createLogger('ethereum:l1-rpc-grader');
    this.states = urls.map(() => ({
      chain: 'unchecked',
      samples: new SampleWindow(threshold, window),
      unreachable: false,
    }));
    this.order = urls.map((_, index) => index);
  }

  /**
   * Starts probing, with the first round right away. It can be started again after {@link stop}, keeping what it has
   * learnt about each URL. The timer does not keep the process alive.
   */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.currentRound;
  }

  /**
   * Returns the order in which requests should try the URLs, as indices into the configured URLs. It is empty only when
   * every URL is on the wrong chain.
   */
  public getOrder(): readonly number[] {
    return this.order;
  }

  /** Probes every URL once and updates the order. Runs on the grader's interval once started. */
  public async probeAll(): Promise<void> {
    const results = await Promise.all(this.urls.map((_, index) => this.probe(index)));
    const heights = results.flatMap(result => (result.type === 'ok' ? [result.blockNumber] : []));
    const head = heights.reduce((max, height) => (height > max ? height : max), this.head);
    this.head = head;
    const wasDemoted = this.states.map((_, index) => this.isDemoted(index));

    const maxBlocksBehind = BigInt(this.opts.config.l1RpcGraderMaxBlocksBehind);
    results.forEach((result, index) => {
      const state = this.states[index];
      if (result.type === 'wrong-chain') {
        return;
      }
      state.unreachable = result.type === 'unreachable';
      if (result.type === 'ok') {
        state.blocksBehind = head - result.blockNumber;
      }
      state.samples.record(result.type === 'unreachable' || head - result.blockNumber > maxBlocksBehind);
    });

    this.states.forEach((state, index) => {
      const demoted = this.isDemoted(index);
      if (demoted && !wasDemoted[index]) {
        this.log.info(`Demoted L1 RPC URL ${this.describe(index)}`, {
          url: this.describe(index),
          unreachable: state.unreachable,
          blocksBehind: state.blocksBehind,
          head,
        });
      } else if (!demoted && wasDemoted[index]) {
        this.log.info(`Restored L1 RPC URL ${this.describe(index)}`, { url: this.describe(index), head });
      }
    });

    this.updateOrder();
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentRound = this.probeAll()
        .catch(err => this.log.warn('Failed to grade L1 RPC URLs', { err }))
        .finally(() => {
          if (this.running) {
            this.schedule(this.opts.config.l1RpcGraderIntervalMS);
          }
        });
    }, delayMs);
    this.timer.unref();
  }

  private async probe(index: number): Promise<ProbeResult> {
    const state = this.states[index];
    if (state.chain === 'mismatch') {
      return { type: 'wrong-chain' };
    }
    const timeout = this.opts.config.l1RpcGraderProbeTimeoutMS;
    try {
      if (state.chain === 'unchecked') {
        const chainId = await executeTimeout(() => this.probes.getChainId(index), timeout);
        if (chainId !== this.opts.chainId) {
          state.chain = 'mismatch';
          this.log.error(`L1 RPC URL ${this.describe(index)} is on the wrong chain and will not be used`, {
            url: this.describe(index),
            chainId,
            expectedChainId: this.opts.chainId,
          });
          return { type: 'wrong-chain' };
        }
        state.chain = 'ok';
      }
      return { type: 'ok', blockNumber: await executeTimeout(() => this.probes.getBlockNumber(index), timeout) };
    } catch {
      // Probe errors are not logged: viem includes the full URL, API key and all, in its error messages.
      return { type: 'unreachable' };
    }
  }

  private isDemoted(index: number): boolean {
    return this.states[index].samples.isDemoted();
  }

  private updateOrder(): void {
    const all = this.urls.map((_, index) => index);
    const usable = all.filter(index => this.states[index].chain !== 'mismatch');
    const healthy = usable.filter(index => !this.isDemoted(index));
    const demoted = usable.filter(index => this.isDemoted(index));
    const eligible = this.opts.config.l1RpcGraderKeepDemoted ? [...healthy, ...demoted] : healthy;

    const allDemoted = eligible.length === 0;
    const order = allDemoted ? usable : eligible;
    if (allDemoted && !this.allDemoted) {
      if (usable.length === 0) {
        this.log.error('Every L1 RPC URL is on the wrong chain, so L1 requests will fail', {
          expectedChainId: this.opts.chainId,
        });
      } else {
        this.log.warn('Every L1 RPC URL is demoted, so all of them are used in the configured order', {
          urls: order.map(index => this.describe(index)),
        });
      }
    }
    this.allDemoted = allDemoted;

    if (order.length === this.order.length && order.every((index, i) => index === this.order[i])) {
      return;
    }
    this.order = order;
    this.opts.onOrderChange?.(order);
  }

  /** Names a URL by its 1-based position and host only, since API keys usually sit in the path or query string. */
  private describe(index: number): string {
    return `#${index + 1} ${describeHost(this.urls[index])}`;
  }
}

function describeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid URL)';
  }
}
