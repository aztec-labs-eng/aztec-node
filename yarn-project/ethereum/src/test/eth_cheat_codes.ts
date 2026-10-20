import { toBigIntBE, toHex } from '@aztec-labs/foundation/bigint-buffer';
import { keccak256 } from '@aztec-labs/foundation/crypto/keccak';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { createLogger } from '@aztec-labs/foundation/log';
import { Semaphore } from '@aztec-labs/foundation/queue';
import { pluralize } from '@aztec-labs/foundation/string';
import type { DateProvider, TestDateProvider } from '@aztec-labs/foundation/timer';
import { Buffer } from 'buffer';
import {
  type Chain,
  type Hex,
  type Transaction,
  createPublicClient,
  fallback,
  hexToNumber,
  http,
  numberToHex,
} from 'viem';
import { foundry } from 'viem/chains';

import type { ViemPublicClient } from '../types.js';

/** Interval mining that a finished pause hands back to anvil on the next tick of the block grid. */
type PendingResume = { interval: number; timer: ReturnType<typeof setTimeout> };

/**
 * Mining state of the test anvil, shared by every {@link EthCheatCodes} instance in the process: e2e builds several over
 * one anvil (the fixture's, `CheatCodes.eth`, each `RollupCheatCodes`), and a pause or pending resume started by one
 * must be visible to the others. Assumes every mining-mode cheat code in the process targets one anvil: other anvils may
 * be started and stopped alongside it, but not paused or switched between mining modes.
 */
const anvilMining: {
  /** Serializes changes to anvil's mining mode against the pending resume. Never held while a caller's code runs. */
  lock: Semaphore;
  /** Ports of the anvil the latest pause targeted, which the pause state and any pending resume belong to. */
  ownerPorts?: string[];
  /**
   * Mining mode captured by the pause in progress, restored when it ends. `nextTimestamp` is the next block's timestamp
   * a caller chose during the pause, which a resume on the grid would overwrite if no block has used it yet.
   */
  paused?: { interval: number | null; automine: boolean; nextTimestamp?: number };
  pendingResume?: PendingResume;
  /** Bumped on reset, so a resume being scheduled across a reset does not arm a timer for the next anvil. */
  generation: number;
} = { lock: new Semaphore(1), generation: 0 };

/** Stops a pending resume and returns the interval it would have restored. */
function takePendingResume(): number | undefined {
  const pending = anvilMining.pendingResume;
  if (!pending) {
    return undefined;
  }
  clearTimeout(pending.timer);
  anvilMining.pendingResume = undefined;
  return pending.interval;
}

/**
 * Cancels any pending interval-mining resume and forgets the pause state, if they belong to the anvil listening on
 * `port`. Called when that anvil is stopped, so no timer outlives it and the next anvil starts clean. Stopping any other
 * anvil, such as a throwaway one a test starts next to its main one, leaves the state alone.
 */
export function resetAnvilMiningState(port: number): void {
  // The owner is kept, so the reset on the anvil's close still clears a timer armed while it was shutting down.
  if (!anvilMining.ownerPorts?.includes(String(port))) {
    return;
  }
  takePendingResume();
  anvilMining.paused = undefined;
  anvilMining.generation++;
}

/**
 * A tick missed by at most this long, because a pause ended or the resume timer fired that much after it, is still
 * mined straight away with its grid timestamp: the block lands up to this late rather than leaving a gap in the chain.
 * A tick missed by more is skipped, like a missed L1 slot, and mining resumes on the next one.
 */
const OVERDUE_TICK_GRACE_MS = 1000;

/** A grid block mined at most this long after its tick restarts anvil's countdown from it; a later one does not. */
const ON_TIME_TOLERANCE_MS = 100;

/**
 * A class that provides utility functions for interacting with ethereum (L1).
 */
export class EthCheatCodes {
  public readonly publicClient: ViemPublicClient;
  constructor(
    /**
     * The RPC URL to use for interacting with the chain
     */
    public rpcUrls: string[],
    /**
     * The date provider to use for time operations
     */
    public dateProvider: DateProvider | TestDateProvider,
    /**
     * The logger to use for the eth cheatcodes
     */
    public logger = createLogger('ethereum:cheat_codes'),
    /**
     * The chain configuration provided to Anvil
     */
    public chain: Chain = foundry,
  ) {
    this.publicClient = createPublicClient({
      transport: fallback(this.rpcUrls.map(url => http(url, { batch: false }))),
      chain: chain,
    });
  }

  public rpcCall(method: string, params: any[]) {
    this.logger.debug(`Calling ${method} with params: ${jsonStringify(params)} on ${this.rpcUrls.join(', ')}`);
    return this.doRpcCall(method, params);
  }

  private async doRpcCall(method: string, params: any[]) {
    return (await this.publicClient.transport.request({
      method,
      params,
    })) as any;
  }

  /**
   * Get the auto mine status of the underlying chain
   * @returns True if automine is on, false otherwise
   */
  public async isAutoMining(): Promise<boolean> {
    try {
      const res = await this.doRpcCall('anvil_getAutomine', []);
      return res;
    } catch (err) {
      this.logger.error(`Calling "anvil_getAutomine" failed with:`, err);
    }
    return false;
  }

  /**
   * Get the current blocknumber
   * @returns The current block number
   */
  public async blockNumber(): Promise<number> {
    const res = await this.doRpcCall('eth_blockNumber', []);
    return parseInt(res, 16);
  }

  /**
   * Get the current chainId
   * @returns The current chainId
   */
  public async chainId(): Promise<number> {
    const res = await this.doRpcCall('eth_chainId', []);
    return parseInt(res, 16);
  }

  /**
   * Get the timestamp of the latest mined L1 block.
   * Note: this is NOT the current time — it's the discrete timestamp of the last block.
   * Between blocks, the actual chain time advances but no new block reflects it.
   * @returns The latest block timestamp in seconds
   */
  public async lastBlockTimestamp(): Promise<number> {
    const res = await this.doRpcCall('eth_getBlockByNumber', ['latest', true]);
    return parseInt(res.timestamp, 16);
  }

  /**
   * Get the timestamp of the pending L1 block — the block that anvil will mine next.
   * Reflects any prior `setNextBlockTimestamp` call or the configured block interval.
   * @returns The pending block timestamp in seconds.
   */
  public async nextBlockTimestamp(): Promise<number> {
    const res = await this.doRpcCall('eth_getBlockByNumber', ['pending', false]);
    return parseInt(res.timestamp, 16);
  }

  /**
   * Advance the chain by a number of blocks
   * @param numberOfBlocks - The number of blocks to mine
   */
  public async mine(numberOfBlocks: number | bigint = 1): Promise<void> {
    await this.withMiningLock(() => this.doMine(Number(numberOfBlocks)));
    this.logger.warn(`Mined ${numberOfBlocks} L1 blocks`);
  }

  private async doMine(numberOfBlocks = 1): Promise<void> {
    try {
      await this.doRpcCall('hardhat_mine', [numberOfBlocks]);
    } catch (err) {
      throw new Error(`Error mining: ${err}`);
    }
  }

  /**
   * Mines a single block with evm_mine
   */
  public async evmMine(opts: { silent?: boolean } = {}): Promise<void> {
    await this.withMiningLock(() => this.doEvmMine());
    if (!opts.silent) {
      this.logger.warn(`Mined 1 L1 block with evm_mine`);
    }
  }

  private async doEvmMine(): Promise<void> {
    try {
      await this.doRpcCall('evm_mine', []);
    } catch (err) {
      throw new Error(`Error mining: ${err}`);
    }
  }

  /**
   * Set the balance of an account
   * @param account - The account to set the balance for
   * @param balance - The balance to set
   */
  public async setBalance(account: EthAddress | Hex, balance: bigint): Promise<void> {
    try {
      await this.rpcCall('anvil_setBalance', [account.toString(), toHex(balance)]);
    } catch (err) {
      throw new Error(`Error setting balance for ${account}: ${err}`);
    }
    this.logger.warn(`Set balance for ${account} to ${balance}`);
  }

  public async getBalance(account: EthAddress | Hex): Promise<bigint> {
    const res = await this.doRpcCall('eth_getBalance', [account.toString(), 'latest']);
    return BigInt(res);
  }

  /**
   * Set the interval between successive blocks (block time). This does NOT enable interval mining.
   * @param interval - The interval to use between blocks
   */
  public async setBlockInterval(interval: number): Promise<void> {
    try {
      await this.rpcCall('anvil_setBlockTimestampInterval', [interval]);
    } catch (err) {
      throw new Error(`Error setting block interval: ${err}`);
    }
    this.logger.warn(`Set L1 block interval to ${interval}`);
  }

  /**
   * Set the next block base fee per gas
   * @param baseFee - The base fee to set
   */
  public async setNextBlockBaseFeePerGas(baseFee: bigint | number): Promise<void> {
    try {
      await this.rpcCall('anvil_setNextBlockBaseFeePerGas', [baseFee.toString()]);
    } catch (err) {
      throw new Error(`Error setting next block base fee per gas: ${err}`);
    }
    this.logger.warn(`Set L1 next block base fee per gas to ${baseFee}`);
  }

  /**
   * Get interval mining if set. A pending resume left by {@link execWithPausedAnvil} counts as set, although anvil
   * itself reports interval mining as off until the resume fires.
   */
  public async getIntervalMining(): Promise<number | null> {
    return await this.withMiningLock(
      async () => anvilMining.pendingResume?.interval ?? (await this.doGetIntervalMining()),
    );
  }

  private async doGetIntervalMining(): Promise<number | null> {
    try {
      return await this.doRpcCall('anvil_getIntervalMining', []);
    } catch (err) {
      throw new Error(`Error getting interval mining: ${err}`);
    }
  }

  /**
   * Enable interval mining at the given interval (block time). Replaces any pending resume left by
   * {@link execWithPausedAnvil}.
   * @param seconds - The interval to use between blocks
   */
  public async setIntervalMining(seconds: number, opts: { silent?: boolean } = {}): Promise<void> {
    await this.withMiningLock(async () => {
      takePendingResume();
      await this.doSetIntervalMining(seconds);
    });
    if (!opts.silent) {
      this.logger.warn(`Set L1 interval mining to ${seconds} seconds`);
    }
  }

  private async doSetIntervalMining(seconds: number): Promise<void> {
    try {
      await this.rpcCall('anvil_setIntervalMining', [seconds]);
    } catch (err) {
      throw new Error(`Error setting interval mining: ${err}`);
    }
  }

  /**
   * Starts interval mining from a freshly mined block and syncs the date provider to the block timestamp.
   */
  public async startIntervalMiningWithFreshBlock(seconds: number): Promise<void> {
    if (seconds <= 0) {
      throw new Error(`Interval mining requires a positive interval, got ${seconds}`);
    }

    await this.withMiningLock(async () => {
      takePendingResume();
      await this.doSetAutomine(false);
      await this.doSetIntervalMining(0);
      await this.doEvmMine();
      await this.syncDateProvider();
      await this.doSetIntervalMining(seconds);
    });
    this.logger.warn(`Started L1 interval mining at ${seconds} seconds from a fresh block`);
  }

  /**
   * Set the automine status of the underlying anvil chain
   * @param automine - The automine status to set
   */
  public async setAutomine(automine: boolean, opts: { silent?: boolean } = {}): Promise<void> {
    await this.withMiningLock(() => this.doSetAutomine(automine));
    if (!opts.silent) {
      this.logger.warn(`Set L1 automine to ${automine}`);
    }
  }

  private async doSetAutomine(automine: boolean): Promise<void> {
    try {
      await this.rpcCall('anvil_setAutomine', [automine]);
    } catch (err) {
      throw new Error(`Error setting automine: ${err}`);
    }
  }

  /**
   * Drop a transaction from the mempool
   * @param txHash - The transaction hash
   */
  public async dropTransaction(txHash: Hex): Promise<void> {
    try {
      await this.rpcCall('anvil_dropTransaction', [txHash]);
    } catch (err) {
      throw new Error(`Error dropping transaction: ${err}`);
    }
    this.logger.warn(`Dropped transaction ${txHash}`);
  }

  /**
   * Set the next block timestamp. A resume on the block grid after {@link execWithPausedAnvil} would overwrite it, so
   * interval mining is instead restarted straight away: now if a resume is pending, or when the current pause ends if
   * no block mined during the pause has used the timestamp.
   * @param timestamp - The timestamp to set the next block to
   */
  public async setNextBlockTimestamp(timestamp: number | Date): Promise<void> {
    const seconds = timestamp instanceof Date ? Math.floor(timestamp.getTime() / 1000) : timestamp;
    await this.withMiningLock(async () => {
      const pendingInterval = takePendingResume();
      if (pendingInterval !== undefined) {
        await this.doSetIntervalMining(pendingInterval);
      }
      if (anvilMining.paused) {
        anvilMining.paused.nextTimestamp = seconds;
      }
      try {
        await this.rpcCall('evm_setNextBlockTimestamp', [seconds]);
      } catch (err: any) {
        throw new Error(`Error setting next block timestamp: ${err.message}`);
      }
    });
    this.logger.warn(`Set L1 next block timestamp to ${timestamp}`);
  }

  /**
   * Set the next block timestamp and mines the block.
   * Optionally resets interval mining so the next block is mined in `blockInterval` seconds from now.
   * Always updates the injected date provider to follow L1 time.
   * @param timestamp - The timestamp to set the next block to
   */
  public async warp(
    timestamp: number | bigint,
    opts: { silent?: boolean; resetBlockInterval?: boolean } = {},
  ): Promise<void> {
    await this.withMiningLock(async () => {
      let blockInterval: number | null = null;
      try {
        // Load current block interval and disable it. A pending resume would put mining back on the grid from
        // before the warp, so take it over: the warp re-phases the grid onto its own timestamp.
        if (opts.resetBlockInterval) {
          blockInterval = takePendingResume() ?? (await this.doGetIntervalMining());
          if (blockInterval !== null) {
            await this.doSetIntervalMining(0);
          }
        }
        // Set the timestamp of the next block to be mined
        await this.rpcCall('evm_setNextBlockTimestamp', [Number(timestamp)]);
        // And mine a block so the timestamp goes into effect now
        await this.doMine();
        // Update the injected date provider so it follows L1 time
        if ('setTime' in this.dateProvider) {
          this.dateProvider.setTime(Number(timestamp) * 1000);
        }
      } catch (err) {
        throw new Error(`Error warping: ${err}`);
      } finally {
        // Restore interval mining so the next block is mined in `blockInterval` seconds from this one
        if (opts.resetBlockInterval && blockInterval !== null && blockInterval > 0) {
          await this.doSetIntervalMining(blockInterval);
        }
      }
    });
    if (!opts.silent) {
      this.logger.warn(`Warped L1 timestamp to ${timestamp}`);
    }
  }

  /**
   * Load the value at a storage slot of a contract address on eth
   * @param contract - The contract address
   * @param slot - The storage slot
   * @returns - The value at the storage slot
   */
  public async load(contract: EthAddress, slot: bigint): Promise<bigint> {
    const res = await this.rpcCall('eth_getStorageAt', [contract.toString(), toHex(slot), 'latest']);
    return BigInt(res);
  }

  /**
   * Set the value at a storage slot of a contract address on eth
   * @param contract - The contract address
   * @param slot - The storage slot
   * @param value - The value to set the storage slot to
   */
  public async store(
    contract: EthAddress,
    slot: bigint,
    value: bigint,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    // for the rpc call, we need to change value to be a 32 byte hex string.
    try {
      await this.rpcCall('hardhat_setStorageAt', [contract.toString(), toHex(slot), toHex(value, true)]);
    } catch (err) {
      throw new Error(`Error setting storage for contract ${contract} at ${slot}: ${err}`);
    }
    if (!opts.silent) {
      this.logger.warn(`Set L1 storage for contract ${contract} at ${slot} to ${value}`);
    }
  }

  /**
   * Computes the slot value for a given map and key.
   * @param baseSlot - The base slot of the map (specified in Aztec.nr contract)
   * @param key - The key to lookup in the map
   * @returns The storage slot of the value in the map
   */
  public keccak256(baseSlot: bigint, key: bigint): bigint {
    // abi encode (removing the 0x) - concat key and baseSlot (both padded to 32 bytes)
    const abiEncoded = toHex(key, true).substring(2) + toHex(baseSlot, true).substring(2);
    return toBigIntBE(keccak256(Buffer.from(abiEncoded, 'hex')));
  }

  /**
   * Send transactions impersonating an externally owned account or contract.
   * @param who - The address to impersonate
   */
  public async startImpersonating(who: EthAddress | Hex): Promise<void> {
    try {
      // Since the `who` impersonated will sometimes be a contract without funds, we fund it if needed.
      if ((await this.getBalance(who)) === 0n) {
        await this.setBalance(who, 10n * 10n ** 18n);
      }

      await this.rpcCall('hardhat_impersonateAccount', [who.toString()]);
    } catch (err) {
      throw new Error(`Error impersonating ${who}: ${err}`);
    }
    this.logger.warn(`Impersonating ${who}`);
  }

  /**
   * Stop impersonating an account that you are currently impersonating.
   * @param who - The address to stop impersonating
   */
  public async stopImpersonating(who: EthAddress | Hex): Promise<void> {
    try {
      await this.rpcCall('hardhat_stopImpersonatingAccount', [who.toString()]);
    } catch (err) {
      throw new Error(`Error when stopping the impersonation of ${who}: ${err}`);
    }
    this.logger.warn(`Stopped impersonating ${who}`);
  }

  /**
   * Set the bytecode for a contract
   * @param contract - The contract address
   * @param bytecode - The bytecode to set
   */
  public async etch(contract: EthAddress, bytecode: `0x${string}`): Promise<void> {
    try {
      await this.rpcCall('hardhat_setCode', [contract.toString(), bytecode]);
    } catch (err) {
      throw new Error(`Error setting bytecode for ${contract}: ${err}`);
    }
    this.logger.warn(`Set bytecode for ${contract} to ${bytecode}`);
  }

  /**
   * Get the bytecode for a contract
   * @param contract - The contract address
   * @returns The bytecode for the contract
   */
  public async getBytecode(contract: EthAddress): Promise<`0x${string}`> {
    return await this.doRpcCall('eth_getCode', [contract.toString(), 'latest']);
  }

  /**
   * Get the raw transaction object for a given transaction hash
   * @param txHash - The transaction hash
   * @returns The raw transaction
   */
  public async getRawTransaction(txHash: Hex): Promise<`0x${string}`> {
    return await this.doRpcCall('debug_getRawTransaction', [txHash]);
  }

  /**
   * Get the trace for a given transaction hash
   * @param txHash - The transaction hash
   * @returns The trace
   */
  public async debugTraceTransaction(txHash: Hex): Promise<any> {
    return await this.doRpcCall('debug_traceTransaction', [txHash]);
  }

  /**
   * Triggers a reorg of the given depth, removing those blocks from the chain.
   * @param depth - The depth of the reorg
   */
  public reorg(depth: number): Promise<void> {
    return this.execWithPausedAnvil(() => {
      return this.rpcCall('anvil_rollback', [depth]);
    });
  }

  /**
   * Causes Anvil to reorg until the given block number is the new tip
   * @param blockNumber - The block number that's going to be the new tip
   */
  public reorgTo(blockNumber: number): Promise<void> {
    if (blockNumber <= 0) {
      throw new Error(`Can't reorg to block before genesis: ${blockNumber}`);
    }

    return this.execWithPausedAnvil(async () => {
      const currentTip = await this.publicClient.getBlockNumber();
      if (currentTip < BigInt(blockNumber)) {
        this.logger.warn(
          `Can't call anvil_rollback, chain tip is behind target block: ${currentTip} < ${BigInt(blockNumber)}`,
        );
        return;
      }

      const depth = Number(currentTip - BigInt(blockNumber) + 1n);
      await this.rpcCall('anvil_rollback', [depth]);
      this.logger.warn(`Reorged L1 chain to block number ${blockNumber} (depth ${depth})`);
    });
  }

  /**
   * Triggers a reorg of the given depth, optionally replacing it with new blocks.
   * The resulting block height will be the same as the original chain.
   * @param depth - The depth of the reorg
   * @param newBlocks - The blocks to replace the old ones with, each represented as a list of txs. An unsigned
   * request without `gas` has its gas limit estimated by anvil against the chain *before* the rollback, so a call
   * that costs more once the rolled-back state is restored (a storage slot that goes back to zero, say) is mined
   * out of gas. Set `gas` explicitly whenever the replacement re-executes work the reorg undid.
   */
  public async reorgWithReplacement(
    depth: number,
    newBlocks: (
      | Hex
      | { to: EthAddress | Hex; input?: Hex; from?: EthAddress | Hex; value?: number | bigint; gas?: bigint }
    )[][] = [],
  ): Promise<void> {
    this.logger.verbose(`Preparing L1 reorg with depth ${depth}`);
    try {
      await this.withMiningLock(() =>
        this.rpcCall('anvil_reorg', [
          depth,
          newBlocks.flatMap((txs, index) =>
            txs.map(tx => [
              typeof tx === 'string'
                ? tx
                : { value: 0, ...tx, ...(tx.gas === undefined ? {} : { gas: numberToHex(tx.gas) }) },
              index,
            ]),
          ),
        ]),
      );
    } catch (err) {
      throw new Error(`Error reorging: ${err}`);
    }
    this.logger.warn(`Reorged L1 chain with depth ${depth} and ${newBlocks.length} new blocks`, { depth, newBlocks });
  }

  public traceTransaction(txHash: Hex): Promise<any> {
    return this.doRpcCall('trace_transaction', [txHash]);
  }

  public async getTxPoolStatus(): Promise<{ pending: number; queued: number }> {
    const { pending, queued } = await this.doRpcCall('txpool_status', []);
    return { pending: hexToNumber(pending), queued: hexToNumber(queued) };
  }

  public async getTxPoolContents(): Promise<TxPoolTransaction[]> {
    const txpoolContent = await this.doRpcCall('txpool_content', []);
    return mapTxPoolContent(txpoolContent);
  }

  /**
   * Mines empty blocks while leaving any pending transactions untouched in the mempool.
   *
   * Never manipulates the mempool, so it is immune to the race that dropping and re-adding txs has against a
   * concurrent publisher that is monitoring and re-broadcasting the same in-flight tx (with that approach the
   * in-flight tx could reappear in the pool and be swept into the "empty" block, mining a proposal the caller
   * expected to stay pending). Works in two steps: first the block gas limit is temporarily lowered below the
   * intrinsic cost of any transaction (21000 gas) and the blocks are mined, so no pending tx is includable;
   * then those blocks are reorged out and replaced with empty blocks mined at the restored gas limit. The
   * reorg is needed because anvil applies a new gas limit only to future blocks: without it the just-mined
   * blocks would keep the tiny gas limit, and an `eth_call` against `latest` (whose gas is capped by the
   * block gas limit) would revert with "intrinsic gas too high".
   *
   * The replacement blocks advance L1 time. `anvil_reorg` stamps each replacement as `parent + N*interval`,
   * so on its own it would freeze L1 time at the parent timestamp; callers that measure elapsed L1 time
   * (L1TxUtils stall/timeout detection, `syncDateProvider`-driven slot advancement) rely on it moving
   * forward. We reproduce the wall-clock advance the mine step just made (at least 1s per block) via a
   * temporary block-timestamp interval, then restore any pre-existing interval.
   */
  public async mineEmptyBlock(blockCount: number = 1): Promise<void> {
    await this.execWithPausedAnvil(async () => {
      const originalGasLimit = await this.getBlockGasLimit();
      const parentTimestamp = await this.lastBlockTimestamp();
      // anvil has no getter for the block-timestamp interval, but the pending block is stamped
      // `latest + interval`, so this delta is the standing interval (0 when none is set).
      const priorInterval = (await this.nextBlockTimestamp()) - parentTimestamp;
      try {
        await this.setBlockGasLimit(1n);
        await this.doMine(blockCount);
      } finally {
        await this.setBlockGasLimit(originalGasLimit);
      }
      const advance = (await this.lastBlockTimestamp()) - parentTimestamp;
      const perBlockInterval = Math.max(1, Math.floor(advance / blockCount));
      // Replace the tiny-gas-limit blocks with empty blocks at the restored gas limit, keeping the same
      // height. The reorged-out blocks held no transactions, so nothing returns to the pool.
      await this.doRpcCall('anvil_setBlockTimestampInterval', [perBlockInterval]);
      try {
        await this.doRpcCall('anvil_reorg', [blockCount, []]);
      } finally {
        if (priorInterval > 0) {
          await this.doRpcCall('anvil_setBlockTimestampInterval', [priorInterval]);
        } else {
          await this.doRpcCall('anvil_removeBlockTimestampInterval', []);
        }
      }
    });

    this.logger.warn(`Mined ${blockCount} empty L1 ${pluralize('block', blockCount)}`);
  }

  /** Returns the gas limit of the latest mined L1 block. */
  public async getBlockGasLimit(): Promise<bigint> {
    const block = await this.doRpcCall('eth_getBlockByNumber', ['latest', false]);
    return BigInt(block.gasLimit);
  }

  /** Sets the block gas limit applied to subsequently mined L1 blocks. */
  public async setBlockGasLimit(gasLimit: bigint): Promise<void> {
    await this.doRpcCall('anvil_setBlockGasLimit', [toHex(gasLimit)]);
  }

  /**
   * Runs `fn` with automine and interval mining off, so no block is mined while it runs. Called while another pause is
   * in progress, it just runs `fn` and leaves the mining mode to that pause.
   *
   * Automine comes back straight away. Interval mining comes back in the background, on the grid the chain was
   * already on (see {@link scheduleResume}), so the caller never waits for an L1 tick.
   */
  public async execWithPausedAnvil<T>(fn: () => Promise<T>): Promise<T> {
    const ownsPause = await this.withMiningLock(async () => {
      if (anvilMining.paused) {
        return false;
      }
      await this.pauseMining();
      return true;
    });
    if (!ownsPause) {
      return await fn();
    }

    try {
      return await fn();
    } finally {
      await this.withMiningLock(() => this.restoreMining());
    }
  }

  public async syncDateProvider() {
    const timestamp = await this.lastBlockTimestamp();
    if ('setTime' in this.dateProvider) {
      this.dateProvider.setTime(timestamp * 1000);
    }
  }

  private async withMiningLock<T>(fn: () => Promise<T>): Promise<T> {
    await anvilMining.lock.acquire();
    try {
      return await fn();
    } finally {
      anvilMining.lock.release();
    }
  }

  private async pauseMining(): Promise<void> {
    // A resume still pending from an earlier pause is taken over: anvil reports interval mining as off meanwhile.
    const interval = takePendingResume() ?? (await this.doGetIntervalMining());
    const paused = { interval, automine: await this.isAutoMining() };
    anvilMining.paused = paused;
    anvilMining.ownerPorts = this.rpcUrls.map(url => new URL(url).port);
    try {
      if (interval !== null) {
        await this.doSetIntervalMining(0);
      }
      if (paused.automine) {
        await this.doSetAutomine(false);
      }
    } catch (err) {
      await this.restoreMining();
      throw err;
    }
  }

  private async restoreMining(): Promise<void> {
    const saved = anvilMining.paused;
    anvilMining.paused = undefined;
    if (saved?.automine) {
      try {
        await this.doSetAutomine(true);
      } catch (err) {
        this.logger.warn(`Failed to reenable automining: ${err}`);
      }
    }
    if (saved?.interval) {
      try {
        await this.scheduleResume(saved.interval, saved.nextTimestamp);
      } catch (err) {
        this.logger.warn(`Failed to schedule interval mining on the block grid, restarting it now: ${err}`);
        try {
          await this.doSetIntervalMining(saved.interval);
        } catch (err) {
          this.logger.warn(`Failed to reenable interval mining: ${err}`);
        }
      }
    }
  }

  /**
   * Re-enables interval mining so the next block lands on the grid the chain is already on: the first
   * `latest + k * interval` tick the node clock has not yet passed. Anvil restarts its countdown from zero on
   * `anvil_setIntervalMining`, so re-enabling it right after a pause would mine the next block late while still
   * stamping it `latest + interval`, leaving L1 time behind the node clock for good. Instead mining stays off until
   * that tick, when a background timer mines the tick's block and restarts the countdown from it.
   *
   * A tick the pause ran past by up to {@link OVERDUE_TICK_GRACE_MS} is mined straight away; one missed by more is
   * skipped, so the lag stays bounded, at the cost of a gap in the chain like a missed L1 slot. Must be called holding
   * the mining lock.
   *
   * @param nextTimestamp - A next-block timestamp a caller set during the pause. Unless a block has already used it, it
   * is kept: interval mining restarts straight away instead, so the resume does not overwrite it.
   */
  private async scheduleResume(interval: number, nextTimestamp?: number): Promise<void> {
    const generation = anvilMining.generation;
    const latest = await this.lastBlockTimestamp();
    if (anvilMining.generation !== generation) {
      return;
    }
    if (nextTimestamp !== undefined && latest < nextTimestamp) {
      await this.doSetIntervalMining(interval);
      return;
    }
    const nowMs = this.dateProvider.now();
    const ticks = Math.max(1, Math.ceil((nowMs - OVERDUE_TICK_GRACE_MS - latest * 1000) / (interval * 1000)));
    const tick = latest + ticks * interval;
    const delayMs = tick * 1000 - nowMs;
    if (delayMs > interval * 1000) {
      // The chain is ahead of the node clock (say, a warp the date provider could not follow), so no tick is due
      // within an interval: restart the countdown now, as anvil would.
      await this.doSetIntervalMining(interval);
      return;
    }
    const resume: PendingResume = {
      interval,
      timer: setTimeout(() => void this.resumeOnGrid(resume, latest, tick), Math.max(0, delayMs)),
    };
    anvilMining.pendingResume = resume;
  }

  private async resumeOnGrid(resume: PendingResume, latest: number, tick: number) {
    try {
      await this.withMiningLock(async () => {
        if (anvilMining.pendingResume !== resume) {
          return;
        }
        anvilMining.pendingResume = undefined;
        try {
          const chainMoved = (await this.lastBlockTimestamp()) !== latest;
          const firedMs = this.dateProvider.now();
          if (chainMoved || firedMs - tick * 1000 > OVERDUE_TICK_GRACE_MS) {
            // Blocks were mined or rolled back while mining was off, so the grid may have moved; or the timer ran
            // late (a busy event loop, a wait on the lock), and mining the old tick now would put L1 behind again.
            await this.scheduleResume(resume.interval);
            return;
          }
          await this.doRpcCall('evm_setNextBlockTimestamp', [tick]);
          await this.doEvmMine();
          if (this.dateProvider.now() - tick * 1000 > ON_TIME_TOLERANCE_MS) {
            // The tick was mined late, so a countdown restarted now would keep every later block that late too: wait
            // for the next tick and restart it there instead.
            await this.scheduleResume(resume.interval);
            return;
          }
        } catch (err) {
          this.logger.warn(`Failed to mine the L1 block due at ${tick}, restarting interval mining off the grid`, {
            err: String(err),
            tick,
          });
        }
        await this.doSetIntervalMining(resume.interval);
      });
    } catch (err) {
      this.logger.error(`Failed to resume L1 interval mining`, err, { interval: resume.interval, tick });
    }
  }
}

type TxPoolState = 'pending' | 'queued';

interface TxPoolContent {
  pending: Record<Hex, Record<string, Transaction>>;
  queued: Record<Hex, Record<string, Transaction>>;
}

export type TxPoolTransaction = Transaction & {
  poolState: TxPoolState;
};

function mapTxPoolContent(content: TxPoolContent): TxPoolTransaction[] {
  const result: TxPoolTransaction[] = [];

  const processPool = (pool: Record<Hex, Record<string, Transaction>>, poolState: TxPoolState) => {
    for (const txsByNonce of Object.values(pool)) {
      for (const tx of Object.values(txsByNonce)) {
        result.push({ ...tx, poolState });
      }
    }
  };

  processPool(content.pending, 'pending');
  processPool(content.queued, 'queued');

  return result;
}
