import { pick } from '@aztec-labs/foundation/collection';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import { formatEther } from 'viem';

import { Multicall3 } from './contracts/multicall.js';
import {
  type FeesPerGas,
  L1TxUtils,
  type SendCostRequirement,
  TxUtilsState,
  computeSendCost,
} from './l1_tx_utils/index.js';

/**
 * Selection rank per publisher state (lower is better). IDLE and MINED rank equally: a publisher whose sends keep
 * failing (e.g. for lack of funds) never leaves IDLE, so ranking IDLE above MINED would let it beat a working one.
 * In-flight states come next, and cancelled or not-mined states last since they represent failures to mine.
 */
const stateRank: Record<TxUtilsState, number> = {
  [TxUtilsState.IDLE]: 0,
  [TxUtilsState.MINED]: 0,
  [TxUtilsState.SPEED_UP]: 1,
  [TxUtilsState.SENT]: 1,
  [TxUtilsState.CANCELLED]: 2,
  [TxUtilsState.NOT_MINED]: 2,
};

// Which states represent a busy publisher that we should avoid if possible
const busyStates: TxUtilsState[] = [
  TxUtilsState.SENT,
  TxUtilsState.SPEED_UP,
  TxUtilsState.CANCELLED,
  TxUtilsState.NOT_MINED,
];

const LOW_BALANCE_WARNING_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_LOW_BALANCE_WARNING_MULTIPLIER = 4;

export type PublisherFilter<UtilsType extends L1TxUtils> = (utils: UtilsType) => boolean;

/** Config accepted by PublisherManager. */
type PublisherManagerConfig = {
  publisherAllowInvalidStates?: boolean;
  publisherFundingThreshold?: bigint;
  publisherFundingAmount?: bigint;
  /** Warn when a publisher balance is below this multiple of the ETH required for a send. */
  publisherLowBalanceWarningMultiplier?: number;
};

/** Metrics emitted by the PublisherManager when evaluating whether publishers can afford a send. */
export interface IPublisherManagerMetrics {
  /** Records the latest ETH amount (in wei) a publisher must hold to afford a send. */
  recordRequiredBalance(required: bigint): void;
  /** Records that a publisher balance is below the low-balance warning level. */
  recordLowBalance(address: string): void;
}

/** Balance snapshot of a publisher considered for an L1 send. */
export type PublisherBalanceInfo = {
  address: string;
  balance: bigint;
  state: string;
  /** Balance at which a previous send was rejected for insufficient funds, if the publisher is backed off. */
  insufficientFundsAtBalance?: bigint;
};

/** Thrown when publishers are available but none holds enough ETH to afford the requested L1 send. */
export class NoAffordablePublisherError extends Error {
  constructor(
    public readonly required: bigint,
    public readonly requirement: SendCostRequirement,
    public readonly fees: FeesPerGas,
    public readonly publishers: PublisherBalanceInfo[],
  ) {
    super(
      `No publisher can afford the L1 send: requires ${formatEther(required)} ETH ` +
        `(balances: ${publishers.map(p => `${p.address}=${formatEther(p.balance)}`).join(', ') || 'none'})`,
    );
    this.name = 'NoAffordablePublisherError';
  }

  /** Structured context for logging. */
  public toLogContext() {
    return {
      required: this.required,
      gasLimit: this.requirement.gasLimit,
      blobCount: this.requirement.blobCount,
      maxFeePerGas: this.fees.maxFeePerGas,
      maxFeePerBlobGas: this.fees.maxFeePerBlobGas,
      publishers: this.publishers,
    };
  }
}

type PublisherWithBalance<UtilsType> = { publisher: UtilsType; balance: bigint };

export class PublisherManager<UtilsType extends L1TxUtils = L1TxUtils> {
  private static readonly FUNDING_CHECK_INTERVAL_MS = 2 * 60 * 1000;
  private log: Logger;
  private config: PublisherManagerConfig;
  protected funder?: UtilsType;
  protected readonly fundingPromise?: RunningPromise;
  private started = false;
  private readonly metrics?: IPublisherManagerMetrics;
  /** Last time a low-balance warning was logged, per publisher address (and for the funding threshold check). */
  private readonly lastLowBalanceWarningAt = new Map<string, number>();

  constructor(
    protected publishers: UtilsType[],
    config: PublisherManagerConfig,
    opts?: { bindings?: LoggerBindings; funder?: UtilsType; metrics?: IPublisherManagerMetrics },
  ) {
    this.funder = opts?.funder;
    this.metrics = opts?.metrics;
    this.log = createLogger('publisher:manager', opts?.bindings);
    this.log.info(`PublisherManager initialized with ${publishers.length} publishers.`);
    this.publishers = publishers;
    this.config = pick(
      config,
      'publisherAllowInvalidStates',
      'publisherFundingThreshold',
      'publisherFundingAmount',
      'publisherLowBalanceWarningMultiplier',
    );

    const hasThreshold = this.config.publisherFundingThreshold !== undefined;
    const hasAmount = this.config.publisherFundingAmount !== undefined;
    if (hasThreshold !== hasAmount) {
      this.log.warn(`Incomplete funding config: both publisherFundingThreshold and publisherFundingAmount must be set`);
    }

    if (this.funder) {
      const funderAddress = this.funder.getSenderAddress();
      if (publishers.some(p => p.getSenderAddress().equals(funderAddress))) {
        this.log.error(`Funding account ${funderAddress} is also a publisher, disabling funding to avoid self-funding`);
        this.funder = undefined;
      }
    }

    if (this.funder && hasThreshold && hasAmount) {
      this.fundingPromise = new RunningPromise(
        () => this.triggerFundingIfNeeded(),
        this.log,
        PublisherManager.FUNDING_CHECK_INTERVAL_MS,
      );
    }
  }

  /**
   * Clears any interrupted flag left by a previous {@link stop} so publishing works again after a restart,
   * loads the state of all publishers and the funder, and starts periodic funding checks. Idempotent: a
   * start while already started is a no-op, so it never re-runs `loadStateAndResumeMonitoring` (which
   * would spawn a duplicate background monitor per pending nonce). Lifecycle calls are expected to be
   * serialized by the caller.
   */
  public async start(): Promise<void> {
    if (this.started) {
      this.log.debug('PublisherManager already started, ignoring start');
      return;
    }

    // Clear the interrupted flag set by a previous stop() so a restarted manager can publish again.
    // On a first start this is a no-op (the flag is already clear).
    this.publishers.forEach(pub => pub.restart());
    this.funder?.restart();

    await Promise.all([
      ...this.publishers.map(pub => pub.loadStateAndResumeMonitoring()),
      this.funder?.loadStateAndResumeMonitoring(),
    ]);

    this.fundingPromise?.start();
    // Marked started only once fully up, so a start that failed to load state can be retried.
    this.started = true;
  }

  /**
   * Stops the funding loop, interrupts all publishers so no further L1 txs are sent, and waits (bounded)
   * for their in-flight tx monitor loops to wind down. Idempotent, and the manager may be restarted
   * afterwards via {@link start}, which clears the interrupted flag.
   */
  public async stop(): Promise<void> {
    this.started = false;
    await this.fundingPromise?.stop();
    this.publishers.forEach(pub => pub.interrupt());
    this.funder?.interrupt();
    // Wait for in-flight tx monitor loops to observe the interrupt, so no L1 requests are still
    // being issued after shutdown (e.g. against an anvil instance a test is about to tear down).
    await Promise.all([
      ...this.publishers.map(pub => pub.waitMonitoringStopped()),
      this.funder?.waitMonitoringStopped(),
    ]);
  }

  /**
   * Finds and prioritises an available publisher. Candidates must pass the filter and not be busy (unless
   * `publisherAllowInvalidStates` is set and no idle publisher remains), and are ranked by state (see `stateRank`), then
   * highest balance, then least recently used. Publishers backed off after an insufficient funds rejection are skipped
   * until their balance increases or the backoff expires.
   *
   * With a `requirement`, only publishers whose balance covers the worst-case cost of that send are eligible, and a
   * {@link NoAffordablePublisherError} is thrown if there are none. Without one, selection is lenient: it prefers funded
   * publishers but falls back to unfunded ones rather than failing, for sends that are fine to attempt and lose.
   */
  public async getAvailablePublisher(
    filter: PublisherFilter<UtilsType> = () => true,
    opts?: { requirement?: SendCostRequirement },
  ): Promise<UtilsType> {
    this.log.debug(`Getting available publisher`, {
      publishers: this.publishers.map(p => ({
        address: p.getSenderAddress(),
        state: p.state,
        lastMined: p.lastMinedAtBlockNumber,
      })),
      requirement: opts?.requirement,
    });

    const filtered = this.publishers.filter(pub => filter(pub));
    let validPublishers = filtered.filter(pub => !busyStates.includes(pub.state));

    // If none found but we allow invalid (busy) states, try again including them. When the send has a requirement we
    // also consider busy ones, so that an idle but unaffordable publisher does not hide a busy affordable one. Busy
    // publishers still rank below idle ones.
    if (this.config.publisherAllowInvalidStates && (validPublishers.length === 0 || opts?.requirement)) {
      if (validPublishers.length === 0) {
        this.log.warn(`No valid publishers found. Trying again including invalid states.`);
      }
      validPublishers = filtered;
    }

    if (validPublishers.length === 0) {
      throw new Error(`Failed to find an available publisher.`);
    }

    const withBalance = await this.getBalances(validPublishers);

    let candidates: PublisherWithBalance<UtilsType>[];
    if (opts?.requirement) {
      candidates = await this.getAffordable(withBalance, opts.requirement);
    } else {
      candidates = this.getLenientCandidates(withBalance);
    }

    const sortedPublishers = candidates.sort((a, b) => {
      const stateComparison = stateRank[a.publisher.state] - stateRank[b.publisher.state];
      if (stateComparison !== 0) {
        return stateComparison;
      }
      if (a.balance !== b.balance) {
        return b.balance > a.balance ? 1 : -1;
      }
      const lastUsedComparison = Number(
        (a.publisher.lastMinedAtBlockNumber ?? 0n) - (b.publisher.lastMinedAtBlockNumber ?? 0n),
      );
      return lastUsedComparison;
    });

    return sortedPublishers[0].publisher;
  }

  /**
   * Checks that at least one publisher passing the filter can afford a send with the given requirement, regardless of
   * whether it is busy right now. Meant for gating long-running work whose result is published much later.
   * @throws NoAffordablePublisherError if no publisher can afford it.
   */
  public async checkAffordablePublisher(
    requirement: SendCostRequirement,
    filter: PublisherFilter<UtilsType> = () => true,
  ): Promise<void> {
    const publishers = this.publishers.filter(pub => filter(pub));
    await this.getAffordable(await this.getBalances(publishers), requirement);
  }

  private getBalances(publishers: UtilsType[]): Promise<PublisherWithBalance<UtilsType>[]> {
    return Promise.all(publishers.map(async publisher => ({ publisher, balance: await publisher.getSenderBalance() })));
  }

  /** Returns the publishers that can afford the requirement, or throws NoAffordablePublisherError if none. */
  private async getAffordable(
    publishers: PublisherWithBalance<UtilsType>[],
    requirement: SendCostRequirement,
  ): Promise<PublisherWithBalance<UtilsType>[]> {
    if (publishers.length === 0) {
      throw new Error(`Failed to find an available publisher.`);
    }
    // All publishers share the L1 network, so fees are fetched once rather than per publisher.
    const fees = await publishers[0].publisher.getFeesPerGas(undefined, requirement.blobCount > 0, 0);
    const required = computeSendCost(fees, requirement);
    this.metrics?.recordRequiredBalance(required);
    this.warnOnLowBalances(publishers, required);

    const affordable = publishers.filter(
      p => p.balance >= required && !p.publisher.isBackedOffForInsufficientFunds(p.balance),
    );
    if (affordable.length === 0) {
      throw new NoAffordablePublisherError(
        required,
        requirement,
        fees,
        publishers.map(({ publisher, balance }) => ({
          address: publisher.getSenderAddress().toString(),
          balance,
          state: TxUtilsState[publisher.state],
          insufficientFundsAtBalance: publisher.getInsufficientFundsAtBalance(),
        })),
      );
    }
    return affordable;
  }

  /**
   * Prefers publishers that are funded and not backed off after an insufficient funds rejection, but never returns an
   * empty list: if every candidate is excluded, falls back to the full set so lenient sends still have something to try.
   */
  private getLenientCandidates(publishers: PublisherWithBalance<UtilsType>[]): PublisherWithBalance<UtilsType>[] {
    const usable = publishers.filter(p => p.balance > 0n && !p.publisher.isBackedOffForInsufficientFunds(p.balance));
    if (usable.length > 0) {
      return usable;
    }
    const funded = publishers.filter(p => p.balance > 0n);
    if (funded.length > 0) {
      return funded;
    }
    this.log.warn(`All candidate publishers have zero balance; selecting from unfunded publishers.`);
    return publishers;
  }

  /** Records a metric for every publisher below the low-balance level, and warns at most once per interval each. */
  private warnOnLowBalances(publishers: PublisherWithBalance<UtilsType>[], required: bigint): void {
    const multiplier = this.config.publisherLowBalanceWarningMultiplier ?? DEFAULT_LOW_BALANCE_WARNING_MULTIPLIER;
    const warningLevel = (required * BigInt(Math.round(multiplier * 1000))) / 1000n;

    for (const { publisher, balance } of publishers) {
      if (balance >= warningLevel) {
        continue;
      }
      const address = publisher.getSenderAddress().toString();
      this.metrics?.recordLowBalance(address);
      if (this.shouldWarn(address)) {
        this.log.warn(`Publisher balance is low relative to the ETH required for an L1 send`, {
          address,
          balance,
          required,
          multiplier,
          warningLevel,
        });
      }
    }

    const { publisherFundingThreshold } = this.config;
    if (
      this.funder &&
      publisherFundingThreshold !== undefined &&
      publisherFundingThreshold < warningLevel &&
      this.shouldWarn('funding-threshold')
    ) {
      this.log.warn(`Publisher funding threshold is below the low-balance warning level`, {
        publisherFundingThreshold,
        warningLevel,
        required,
        multiplier,
      });
    }
  }

  private shouldWarn(key: string): boolean {
    const now = Date.now();
    const last = this.lastLowBalanceWarningAt.get(key);
    if (last !== undefined && now - last < LOW_BALANCE_WARNING_INTERVAL_MS) {
      return false;
    }
    this.lastLowBalanceWarningAt.set(key, now);
    return true;
  }

  /** Check all publisher balances and fund those below threshold. */
  private async triggerFundingIfNeeded(): Promise<void> {
    const { funder, config } = this;
    if (!funder || config.publisherFundingThreshold === undefined || config.publisherFundingAmount === undefined) {
      return;
    }

    const allBalances = await Promise.all(
      this.publishers.map(async pub => ({ balance: await pub.getSenderBalance(), publisher: pub })),
    );
    const lowBalance = allBalances.filter(p => p.balance < config.publisherFundingThreshold!);
    if (lowBalance.length === 0) {
      return;
    }

    const fundingAmount = config.publisherFundingAmount!;
    const funderBalance = await funder.getSenderBalance();

    if (funderBalance < 10n * fundingAmount) {
      this.log.warn(`Funding account balance is low`, { funderBalance, threshold: 10n * fundingAmount });
    }
    const affordableCount = Number(funderBalance / fundingAmount);
    if (affordableCount === 0) {
      this.log.error(`Funding account balance too low to fund any publisher`, { funderBalance, fundingAmount });
      return;
    }
    if (affordableCount < lowBalance.length) {
      this.log.warn(`Funder can only afford ${affordableCount}/${lowBalance.length} publishers`, {
        funderBalance,
        fundingAmount,
      });
    }

    const toFund = lowBalance.slice(0, affordableCount).map(p => p.publisher);
    await this.fundPublishers(toFund);
  }

  /** Fund publishers via a single Multicall3 aggregate3Value transaction. */
  private async fundPublishers(publishers: UtilsType[]): Promise<void> {
    const fundingAmount = this.config.publisherFundingAmount!;
    const calls = publishers.map(pub => ({
      to: pub.getSenderAddress().toString(),
      value: fundingAmount,
    }));

    await Multicall3.forwardValue(calls, this.funder!, this.log);
    this.log.info(`Funded ${publishers.length} publishers`);
  }
}
