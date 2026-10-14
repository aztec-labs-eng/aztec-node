import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type FallbackTransport, type HttpTransport, fallback, http } from 'viem';

/**
 * Serializes the cheat-code requests this process sends to one anvil instance. A multi-request cheat op runs as a
 * single queued job, so no other queued request interleaves with it.
 *
 * Anvil's own interval mining runs on an internal timer that no request queue can hold back, so pausing it is the
 * only way to keep a block out of a read-modify-write, and restarting it shifts every later block off its schedule.
 * An anvil started with client-side mining instead leaves block production to this queue: a timer enqueues one
 * `evm_mine` per interval, stamped one interval after its parent and mined when the node clock reaches that stamp. A
 * cheat op holding the queue then delays the next block by only as long as the op takes, and the grid never moves.
 *
 * Only requests sent through {@link createAnvilTransport} are serialized. Other viem clients pointed at the same anvil
 * (a node's publisher and archiver) are not, which is safe because with automine off their transactions change no
 * state until a queued mine includes them.
 */
export class AnvilQueue {
  private readonly queue = new SerialQueue();
  private readonly held = new AsyncLocalStorage<true>();
  private readonly request: (method: string, params: unknown[]) => Promise<any>;
  private closed = false;

  private miningInterval: number | undefined;
  private minerTimer: NodeJS.Timeout | undefined;
  /** Wall-clock time of the last mine, or of the miner (re)start. Spaces out blocks when the grid is out of reach. */
  private lastMineWallMs = 0;

  constructor(
    public readonly rpcUrl: string,
    /** Whether this process mines the blocks on this anvil, instead of anvil's own interval timer. */
    public readonly clientSideMining: boolean,
    private readonly dateProvider: DateProvider = new DateProvider(),
    private readonly log: Logger = createLogger('ethereum:anvil-queue'),
  ) {
    // The transport's config request skips viem's retry wrapper, so a timed-out `evm_mine` is never sent twice.
    const { config } = http(rpcUrl, { batch: false })({});
    this.request = (method, params) => config.request({ method, params });
    this.queue.start();
  }

  /**
   * Runs `fn` as one queued job, so no other request queued for this anvil, including a block mine, runs until it
   * settles. Requests `fn` sends while it holds the queue run in place rather than queueing behind it.
   */
  public run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held.getStore()) {
      return fn();
    }
    return this.queue.put(() => this.held.run(true, fn));
  }

  /** The client-side mining interval in seconds, or undefined when the client-side miner is stopped. */
  public getMiningInterval(): number | undefined {
    return this.miningInterval;
  }

  /**
   * Starts the client-side miner at the given interval in seconds, or stops it when `seconds` is 0. Also sets anvil's
   * block timestamp interval, so the next block is always stamped one interval after its parent unless a cheat op
   * set an explicit next timestamp.
   */
  public async setMiningInterval(seconds: number): Promise<void> {
    if (!this.clientSideMining) {
      throw new Error(`Anvil at ${this.rpcUrl} was not started with client-side mining`);
    }
    this.clearMinerTimer();
    if (seconds <= 0) {
      this.miningInterval = undefined;
      return;
    }
    await this.run(() => this.request('anvil_setBlockTimestampInterval', [seconds]));
    this.miningInterval = seconds;
    this.lastMineWallMs = Date.now();
    this.scheduleTick(0);
  }

  /** Stops the miner and lets every queued request settle. Later requests are rejected. */
  public async close(): Promise<void> {
    this.closed = true;
    this.miningInterval = undefined;
    this.clearMinerTimer();
    await this.queue.end();
  }

  private clearMinerTimer() {
    if (this.minerTimer !== undefined) {
      clearTimeout(this.minerTimer);
      this.minerTimer = undefined;
    }
  }

  private scheduleTick(delayMs: number) {
    if (this.closed || this.miningInterval === undefined) {
      return;
    }
    this.clearMinerTimer();
    // Ticks are scheduled from inside a queued job; the timer must not inherit that job's hold on the queue, or the
    // next tick would bypass the queue instead of waiting for whatever cheat op holds it.
    this.minerTimer = this.held.exit(() =>
      setTimeout(
        () => {
          this.minerTimer = undefined;
          this.run(() => this.tick()).catch(err => {
            if (!this.closed) {
              this.log.warn(`Client-side L1 mining tick failed`, { err, rpcUrl: this.rpcUrl });
              this.scheduleTick(1000);
            }
          });
        },
        Math.max(0, delayMs),
      ),
    );
    this.minerTimer.unref?.();
  }

  /**
   * Mines the pending block once the node clock reaches its timestamp. The pending timestamp is one interval after
   * the tip unless a cheat op set it explicitly, so this follows warps, explicit timestamps and reorgs alike. A
   * block falling due late (a cheat op held the queue) is mined at once to get back on the grid. When the grid is
   * more than an interval behind the node clock (a deep rollback rewound the tip), there is no catching up without a
   * burst of blocks, so the miner keeps anvil's own cadence of one block per interval instead.
   */
  private async tick(): Promise<void> {
    const interval = this.miningInterval;
    if (this.closed || interval === undefined) {
      return;
    }
    const intervalMs = interval * 1000;
    const pending = await this.request('eth_getBlockByNumber', ['pending', false]);
    const timestamp = parseInt(pending.timestamp, 16);
    const nowWallMs = Date.now();

    let delayMs = timestamp * 1000 - this.dateProvider.now();
    if (delayMs < -intervalMs) {
      delayMs = this.lastMineWallMs + intervalMs - nowWallMs;
    }
    // Never mine faster than twice per interval, whatever the timestamps say.
    delayMs = Math.max(delayMs, this.lastMineWallMs + intervalMs / 2 - nowWallMs);
    if (delayMs > 0) {
      this.scheduleTick(delayMs);
      return;
    }

    await this.request('evm_mine', [timestamp]);
    this.lastMineWallMs = Date.now();
    this.log.trace(`Mined L1 block at ${timestamp}`, { timestamp, interval });
    this.scheduleTick((timestamp + interval) * 1000 - this.dateProvider.now());
  }
}

const queues = new Map<string, AnvilQueue>();

const queueKey = (rpcUrl: string) => rpcUrl.replace(/\/+$/, '');

/** Returns the queue for the anvil at `rpcUrls[0]`, creating one without client-side mining if none is registered. */
export function getAnvilQueue(rpcUrls: string[]): AnvilQueue {
  const key = queueKey(rpcUrls[0]);
  let queue = queues.get(key);
  if (!queue) {
    queue = new AnvilQueue(key, false);
    queues.set(key, queue);
  }
  return queue;
}

/** Registers a fresh queue for an anvil this process just started, replacing any queue left from an earlier one. */
export function registerAnvilQueue(
  rpcUrl: string,
  opts: { clientSideMining: boolean; dateProvider?: DateProvider; log?: Logger },
): AnvilQueue {
  const key = queueKey(rpcUrl);
  const queue = new AnvilQueue(key, opts.clientSideMining, opts.dateProvider, opts.log);
  queues.set(key, queue);
  return queue;
}

/** Closes and forgets the queue registered for `rpcUrl`, if it is still the given one. */
export async function unregisterAnvilQueue(queue: AnvilQueue): Promise<void> {
  if (queues.get(queue.rpcUrl) === queue) {
    queues.delete(queue.rpcUrl);
  }
  await queue.close();
}

/** A viem transport whose every request goes through the {@link AnvilQueue} of the anvil at `rpcUrls[0]`. */
export function createAnvilTransport(rpcUrls: string[]): FallbackTransport<HttpTransport[]> {
  const inner = fallback(rpcUrls.map(url => http(url, { batch: false })));
  const queued = <T>(fn: () => Promise<T>) => getAnvilQueue(rpcUrls).run(fn);
  return params => {
    const transport = inner(params);
    // `request` backs viem's actions and retries; `config.request` is the raw request that cheat codes send.
    const request: typeof transport.request = (args, options) => queued(() => transport.request(args, options));
    const configRequest: typeof transport.config.request = (args, options) =>
      queued(() => transport.config.request(args, options));
    return { ...transport, request, config: { ...transport.config, request: configRequest } };
  };
}
