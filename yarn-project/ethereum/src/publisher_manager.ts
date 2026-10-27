import { maxBy, pick } from '@aztec-labs/foundation/collection';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import { formatEther } from 'viem';

import { Multicall3 } from './contracts/multicall.js';
import {
  type FeesPerGas,
  INSUFFICIENT_FUNDS_BACKOFF_MS,
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
const NO_AFFORDABLE_PUBLISHER_WARNING_KEY = 'no-affordable-publisher';

export type PublisherFilter<UtilsType extends L1TxUtils> = (utils: UtilsType) => boolean;

/** Config accepted by PublisherManager. */
type PublisherManagerConfig = {
  publisherAllowInvalidStates?: boolean;
  publisherFundingThreshold?: bigint;
  publisherFundingAmount?: bigint;
  /** Warn when a publisher balance is below this multiple of the ETH required for the reference send. */
  publisherLowBalanceWarningMultiplier?: number;
};

/** A send the periodic balance check prices at current fees, to report whether publishers can afford it. */
export type ReferenceSend = {
  /** Short name of the send for logs, such as "proposal" or "epoch proof". */
  name: string;
  requirement: SendCostRequirement;
};

/** Balances read by a periodic balance check, and how many reference sends each publisher can afford. */
export type PublisherBalanceSnapshot = {
  /** Publishers whose balance could be read. */
  publishers: {
    address: string;
    balance: bigint;
    /**
     * Number of reference sends the balance covers at current fees, 0 while backed off after an insufficient funds
     * rejection. Unset without a reference send or if fees could not be read.
     */
    sendsAffordable?: number;
  }[];
  funder?: { address: string; balance: bigint };
  /** ETH needed for the reference send at current fees. Unset without a reference send or if fees could not be read. */
  required?: bigint;
};

/** Metrics emitted by the PublisherManager from its periodic balance check. */
export interface IPublisherManagerMetrics {
  /** Records the latest balance snapshot, replacing the previous one. Undefined clears it once the manager stops. */
  recordBalanceSnapshot(snapshot: PublisherBalanceSnapshot | undefined): void;
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

  /**
   * ETH the best funded publisher that is not backed off after an insufficient funds rejection is missing to afford the
   * send. Undefined if every publisher is backed off.
   */
  public shortfall(): bigint | undefined {
    const richest = this.getRichestNotBackedOff();
    return richest === undefined ? undefined : this.required - richest.balance;
  }

  /** Tells the operator which publisher to fund and with how much ETH for the send to become affordable. */
  public describeFunding(): string {
    const richest = this.getRichestNotBackedOff();
    if (richest === undefined || this.required <= richest.balance) {
      const minutes = INSUFFICIENT_FUNDS_BACKOFF_MS / 60_000;
      return (
        `every publisher is backed off after an insufficient funds rejection ` +
        `until its balance increases or ${minutes} minutes pass`
      );
    }
    const shortfall = formatEther(this.required - richest.balance);
    const others = this.publishers.filter(p => p.address !== richest.address);
    const alternative =
      others.length === 0
        ? ''
        : `, or top up any of ${others.map(p => p.address).join(', ')} to ${formatEther(this.required)} ETH`;
    return `fund ${richest.address} with ${shortfall} ETH more${alternative}`;
  }

  /** Structured context for logging. */
  public toLogContext() {
    return {
      required: this.required,
      shortfall: this.shortfall(),
      gasLimit: this.requirement.gasLimit,
      blobCount: this.requirement.blobCount,
      maxFeePerGas: this.fees.maxFeePerGas,
      maxFeePerBlobGas: this.fees.maxFeePerBlobGas,
      publishers: this.publishers,
    };
  }

  private getRichestNotBackedOff(): PublisherBalanceInfo | undefined {
    return maxBy(
      this.publishers.filter(p => p.insufficientFundsAtBalance === undefined),
      p => p.balance,
    );
  }
}

type PublisherWithBalance<UtilsType> = { publisher: UtilsType; balance: bigint };

export class PublisherManager<UtilsType extends L1TxUtils = L1TxUtils> {
  private static readonly BALANCE_CHECK_INTERVAL_MS = 60 * 1000;
  protected log: Logger;
  private config: PublisherManagerConfig;
  protected funder?: UtilsType;
  protected readonly balanceCheckPromise: RunningPromise;
  private started = false;
  private readonly metrics?: IPublisherManagerMetrics;
  private readonly referenceSend?: ReferenceSend;
  /** Whether the balance check has run since the last start, so the first one logs a summary of all balances. */
  private loggedBalanceSummary = false;
  /** Last time a balance warning was logged, per publisher address or per kind of warning. */
  private readonly lastLowBalanceWarningAt = new Map<string, number>();

  constructor(
    protected publishers: UtilsType[],
    config: PublisherManagerConfig,
    opts?: {
      bindings?: LoggerBindings;
      funder?: UtilsType;
      metrics?: IPublisherManagerMetrics;
      /**
       * Send the balance check prices to report whether publishers can afford it. Without one, balances are still
       * recorded, but affordability is neither recorded nor warned about.
       */
      referenceSend?: ReferenceSend;
    },
  ) {
    this.funder = opts?.funder;
    this.metrics = opts?.metrics;
    this.referenceSend = opts?.referenceSend;
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

    this.balanceCheckPromise = new RunningPromise(
      () => this.checkBalances(),
      this.log,
      PublisherManager.BALANCE_CHECK_INTERVAL_MS,
    );
  }

  /**
   * Clears any interrupted flag left by a previous {@link stop} so publishing works again after a restart,
   * loads the state of all publishers and the funder, and starts the periodic balance check, which also tops up
   * publishers if funding is configured. Idempotent: a start while already started is a no-op, so it never re-runs
   * `loadStateAndResumeMonitoring` (which would spawn a duplicate background monitor per pending nonce). Lifecycle
   * calls are expected to be serialized by the caller.
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

    this.loggedBalanceSummary = false;
    this.lastLowBalanceWarningAt.delete(NO_AFFORDABLE_PUBLISHER_WARNING_KEY);
    this.balanceCheckPromise.start();
    // Marked started only once fully up, so a start that failed to load state can be retried.
    this.started = true;
  }

  /**
   * Stops the balance check loop, interrupts all publishers so no further L1 txs are sent, and waits (bounded)
   * for their in-flight tx monitor loops to wind down. Idempotent, and the manager may be restarted
   * afterwards via {@link start}, which clears the interrupted flag.
   */
  public async stop(): Promise<void> {
    this.started = false;
    await this.balanceCheckPromise.stop();
    this.metrics?.recordBalanceSnapshot(undefined);
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
   * Reads the balance of every publisher and the funder, prices the reference send at current fees, records metrics,
   * logs balances that are low or cannot afford the reference send, and tops up publishers below the funding threshold
   * if funding is configured. Runs once a minute while started.
   */
  protected async checkBalances(): Promise<void> {
    const funder = this.funder;
    const [publisherBalances, funderBalance] = await Promise.all([
      Promise.all(this.publishers.map(publisher => this.tryGetBalance(publisher))),
      funder ? this.tryGetBalance(funder) : undefined,
    ]);
    const withBalance = this.publishers.flatMap((publisher, i) => {
      const balance = publisherBalances[i];
      return balance === undefined ? [] : [{ publisher, balance }];
    });
    const cost = await this.tryGetReferenceCost();
    const required = cost !== undefined && cost.required > 0n ? cost.required : undefined;

    const snapshot: PublisherBalanceSnapshot = {
      publishers: withBalance.map(({ publisher, balance }) => ({
        address: publisher.getSenderAddress().toString(),
        balance,
        sendsAffordable:
          required === undefined
            ? undefined
            : publisher.hasActiveInsufficientFundsBackoff(balance)
              ? 0
              : Number(balance / required),
      })),
      funder:
        funder && funderBalance !== undefined
          ? { address: funder.getSenderAddress().toString(), balance: funderBalance }
          : undefined,
      required,
    };
    this.metrics?.recordBalanceSnapshot(snapshot);

    this.logBalances(withBalance, snapshot, cost?.fees);
    if (required !== undefined) {
      this.warnOnLowBalances(withBalance, required);
    }

    await this.fundIfNeeded(withBalance, funderBalance);
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

    const affordable = publishers.filter(
      p => p.balance >= required && !p.publisher.isBackedOffForInsufficientFunds(p.balance),
    );
    if (affordable.length === 0) {
      throw new NoAffordablePublisherError(required, requirement, fees, this.toBalanceInfo(publishers));
    }
    return affordable;
  }

  private toBalanceInfo(publishers: PublisherWithBalance<UtilsType>[]): PublisherBalanceInfo[] {
    return publishers.map(({ publisher, balance }) => ({
      address: publisher.getSenderAddress().toString(),
      balance,
      state: TxUtilsState[publisher.state],
      insufficientFundsAtBalance: publisher.hasActiveInsufficientFundsBackoff(balance)
        ? publisher.getInsufficientFundsAtBalance()
        : undefined,
    }));
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

  private async tryGetBalance(utils: UtilsType): Promise<bigint | undefined> {
    try {
      return await utils.getSenderBalance();
    } catch (err) {
      const address = utils.getSenderAddress().toString();
      if (this.shouldWarn(`balance-read:${address}`)) {
        this.log.warn(`Failed to read L1 balance of account`, { address, err });
      }
      return undefined;
    }
  }

  private async tryGetReferenceCost(): Promise<{ fees: FeesPerGas; required: bigint } | undefined> {
    const { referenceSend } = this;
    if (referenceSend === undefined || this.publishers.length === 0) {
      return undefined;
    }
    try {
      // All publishers share the L1 network, so fees are fetched once rather than per publisher.
      const fees = await this.publishers[0].getFeesPerGas(undefined, referenceSend.requirement.blobCount > 0, 0);
      return { fees, required: computeSendCost(fees, referenceSend.requirement) };
    } catch (err) {
      if (this.shouldWarn('fee-read')) {
        this.log.warn(`Failed to read L1 fees to check whether publishers can afford a ${referenceSend.name}`, { err });
      }
      return undefined;
    }
  }

  /**
   * Logs a summary of all balances on the first check after a start, and an error (at most once per interval) while no
   * publisher can afford the reference send.
   */
  private logBalances(
    publishers: PublisherWithBalance<UtilsType>[],
    snapshot: PublisherBalanceSnapshot,
    fees: FeesPerGas | undefined,
  ): void {
    const firstCheck = !this.loggedBalanceSummary;
    this.loggedBalanceSummary = true;
    const { referenceSend } = this;
    const { required } = snapshot;
    const context = {
      publishers: snapshot.publishers.map(p => ({
        address: p.address,
        balance: formatEther(p.balance),
        sendsAffordable: p.sendsAffordable,
      })),
      referenceSend: referenceSend?.name,
      required: required === undefined ? undefined : formatEther(required),
      funder: snapshot.funder && { address: snapshot.funder.address, balance: formatEther(snapshot.funder.balance) },
    };

    const allRead = publishers.length === this.publishers.length;
    const noneAffordable =
      referenceSend !== undefined &&
      required !== undefined &&
      fees !== undefined &&
      allRead &&
      snapshot.publishers.length > 0 &&
      snapshot.publishers.every(p => (p.sendsAffordable ?? 0) < 1);

    if (!noneAffordable) {
      // Only a publisher seen affording the send ends an episode. A check that could not tell (failed reads) must not
      // reset the rate limit, or alternating failed and empty checks would log the error on every empty one.
      if (snapshot.publishers.some(p => (p.sendsAffordable ?? 0) >= 1)) {
        this.lastLowBalanceWarningAt.delete(NO_AFFORDABLE_PUBLISHER_WARNING_KEY);
      }
      if (firstCheck) {
        this.log.info(`Publisher balances`, context);
      }
      return;
    }

    if (this.shouldWarn(NO_AFFORDABLE_PUBLISHER_WARNING_KEY)) {
      const err = new NoAffordablePublisherError(
        required,
        referenceSend.requirement,
        fees,
        this.toBalanceInfo(publishers),
      );
      this.log.error(`No publisher can afford a ${referenceSend.name} at current L1 fees: ${err.describeFunding()}`, {
        ...context,
        shortfall: err.shortfall(),
      });
    }
  }

  /** Warns at most once per interval for every publisher below the low-balance level. */
  private warnOnLowBalances(publishers: PublisherWithBalance<UtilsType>[], required: bigint): void {
    const multiplier = this.config.publisherLowBalanceWarningMultiplier ?? DEFAULT_LOW_BALANCE_WARNING_MULTIPLIER;
    const warningLevel = (required * BigInt(Math.round(multiplier * 1000))) / 1000n;

    for (const { publisher, balance } of publishers) {
      if (balance >= warningLevel) {
        continue;
      }
      const address = publisher.getSenderAddress().toString();
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

  /** Funds the publishers below the funding threshold, using the balances read in the same balance check. */
  private async fundIfNeeded(
    publishers: PublisherWithBalance<UtilsType>[],
    funderBalance: bigint | undefined,
  ): Promise<void> {
    const { funder, config } = this;
    const { publisherFundingThreshold, publisherFundingAmount: fundingAmount } = config;
    if (!funder || publisherFundingThreshold === undefined || fundingAmount === undefined) {
      return;
    }

    const lowBalance = publishers.filter(p => p.balance < publisherFundingThreshold);
    if (lowBalance.length === 0 || funderBalance === undefined) {
      return;
    }

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
    await this.fundPublishers(funder, toFund, fundingAmount);
  }

  /** Fund publishers via a single Multicall3 aggregate3Value transaction. */
  private async fundPublishers(funder: UtilsType, publishers: UtilsType[], fundingAmount: bigint): Promise<void> {
    const calls = publishers.map(pub => ({
      to: pub.getSenderAddress().toString(),
      value: fundingAmount,
    }));

    await Multicall3.forwardValue(calls, funder, this.log);
    this.log.info(`Funded ${publishers.length} publishers`);
  }
}
