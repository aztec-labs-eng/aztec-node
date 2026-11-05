import { INITIAL_CHECKPOINT_NUMBER } from '@aztec-labs/constants';
import { getL1RpcErrorCode, getPublicClient, getRpcUrlsFromClient } from '@aztec-labs/ethereum/client';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { L1ContractAddresses } from '@aztec-labs/ethereum/l1-contract-addresses';
import type { L1BlockId } from '@aztec-labs/ethereum/l1-types';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';

import type { BlockStore } from '../store/block_store.js';

/** L1 contract addresses named in the startup error, whose logs the archiver and slasher need. */
export type HistoricalLogsContractAddresses = Pick<
  L1ContractAddresses,
  'rollupAddress' | 'inboxAddress' | 'registryAddress'
>;

/** The reads the check makes on a single L1 RPC URL. */
export type L1HistoryEndpoint = {
  url: string;
  getBlockHash(blockNumber: bigint): Promise<Buffer32>;
  /** Returns the endpoint's `web3_clientVersion`, or undefined when it cannot be read. */
  getClientVersion(): Promise<string | undefined>;
  rollup: Pick<RollupContract, 'getCheckpointProposedEvents'> & {
    getOwnershipTransferredEventsAtDeploy(): Promise<readonly unknown[]>;
  };
};

type CheckpointSource = Pick<BlockStore, 'getLatestCheckpointNumber' | 'getCheckpointData'>;

/** A Rollup event the local data says was emitted, and the L1 block it was emitted in. */
type ExpectedEvent = {
  name: string;
  at: L1BlockId;
  fetch(rollup: L1HistoryEndpoint['rollup']): Promise<readonly unknown[]>;
};

type ProbeResult = { status: 'served' } | { status: 'empty' } | { status: 'unchecked'; reason: string; err?: unknown };

/**
 * Checks that no configured L1 RPC URL silently drops the Rollup logs the archiver needs. Each URL is asked for the
 * latest local checkpoint's `CheckpointProposed` event, or for the Rollup's deployment `OwnershipTransferred` event
 * when there is no local checkpoint. Checking from where sync resumes, rather than from deployment, lets full nodes
 * pass as long as they keep the logs sync will read.
 *
 * Startup fails when a URL returns no event from a block it holds with the expected hash, since that URL stays in the
 * fallback transport and would answer sync reads the same way. With `skipCheck` that failure is logged as a warning.
 * Any other failure, such as JSON-RPC error 4444 for pruned history, is logged and startup continues: the fallback
 * transport moves past a URL that errors.
 */
export async function validateAndLogHistoricalLogsAvailability(
  client: ViemPublicClient,
  blocks: CheckpointSource,
  l1Start: L1BlockId,
  addresses: HistoricalLogsContractAddresses,
  skipCheck: boolean,
  bindings?: LoggerBindings,
): Promise<void> {
  const log = createLogger('archiver:validate_historical_logs', bindings);
  const urls = getRpcUrlsFromClient(client);
  const chainId = client.chain?.id;
  if (urls.length === 0 || chainId === undefined) {
    log.warn('Could not determine the L1 RPC URLs or chain ID from the public client; skipping historical logs check.');
    return;
  }
  const endpoints = urls.map(url => makeEndpoint(url, chainId, addresses));
  await checkL1RpcHistory(endpoints, blocks, l1Start, addresses, skipCheck, log);
}

/** Runs the check on the given endpoints. See {@link validateAndLogHistoricalLogsAvailability}. */
export async function checkL1RpcHistory(
  endpoints: L1HistoryEndpoint[],
  blocks: CheckpointSource,
  l1Start: L1BlockId,
  addresses: HistoricalLogsContractAddresses,
  skipCheck: boolean,
  log: Logger,
): Promise<void> {
  const expected = await getExpectedEvent(blocks, l1Start);
  for (const endpoint of endpoints) {
    const { url } = endpoint;
    const result = await probe(endpoint, expected);
    if (result.status === 'served') {
      log.debug(`L1 RPC ${url} returned the ${expected.name}`, { url });
    } else if (result.status === 'unchecked') {
      log.warn(`Could not check historical logs on L1 RPC ${url}: ${result.reason}`, { url, err: result.err });
    } else {
      const message = buildErrorMessage(url, await endpoint.getClientVersion(), expected, addresses);
      if (!skipCheck) {
        throw new Error(message);
      }
      log.warn(`${message}\nContinuing because ARCHIVER_SKIP_HISTORICAL_LOGS_CHECK is true.`);
    }
  }
}

async function getExpectedEvent(blocks: CheckpointSource, l1Start: L1BlockId): Promise<ExpectedEvent> {
  const latest = await blocks.getLatestCheckpointNumber();
  const checkpoint = latest >= INITIAL_CHECKPOINT_NUMBER ? await blocks.getCheckpointData(latest) : undefined;
  if (checkpoint === undefined) {
    return {
      name: 'Rollup deployment OwnershipTransferred event',
      at: l1Start,
      fetch: rollup => rollup.getOwnershipTransferredEventsAtDeploy(),
    };
  }
  const at = { l1BlockNumber: checkpoint.l1.blockNumber, l1BlockHash: Buffer32.fromString(checkpoint.l1.blockHash) };
  return {
    name: `CheckpointProposed event for checkpoint ${latest}`,
    at,
    fetch: rollup => rollup.getCheckpointProposedEvents(at.l1BlockNumber, at.l1BlockNumber),
  };
}

/** An empty result only counts when the endpoint holds the expected block, so a reorged block is not mistaken for it. */
async function probe(endpoint: L1HistoryEndpoint, expected: ExpectedEvent): Promise<ProbeResult> {
  const { l1BlockNumber, l1BlockHash } = expected.at;
  try {
    if ((await expected.fetch(endpoint.rollup)).length > 0) {
      return { status: 'served' };
    }
    return (await endpoint.getBlockHash(l1BlockNumber)).equals(l1BlockHash)
      ? { status: 'empty' }
      : { status: 'unchecked', reason: `it holds another block at height ${l1BlockNumber}` };
  } catch (err) {
    return { status: 'unchecked', reason: describeError(err), err };
  }
}

function buildErrorMessage(
  url: string,
  clientVersion: string | undefined,
  expected: ExpectedEvent,
  addresses: HistoricalLogsContractAddresses,
): string {
  return [
    `L1 RPC at ${url} (client ${clientVersion ?? 'unknown'}) returned no ${expected.name} ` +
      `from L1 block ${expected.at.l1BlockNumber} (${expected.at.l1BlockHash.toString()}), which it holds.`,
    `This L1 node returns empty results for logs it has pruned, so the archiver would silently miss data during L1 ` +
      `sync, even alongside other L1 RPC URLs. Either:`,
    `  - upgrade it to a client version that answers pruned ranges with an error,`,
    `  - keep the logs of the Rollup (${addresses.rollupAddress.toString()}) and Inbox ` +
      `(${addresses.inboxAddress.toString()}) with Reth's prune.segments.receipts_log_filter, plus the Registry ` +
      `(${addresses.registryAddress.toString()}) on sequencers and validators, or`,
    `  - remove its URL from ETHEREUM_HOSTS.`,
    `Set ARCHIVER_SKIP_HISTORICAL_LOGS_CHECK=true to bypass this check at your own risk.`,
  ].join('\n');
}

function describeError(err: unknown): string {
  const code = getL1RpcErrorCode(err);
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0];
  return code === undefined ? message : `JSON-RPC error ${code}: ${message}`;
}

function makeEndpoint(url: string, chainId: number, addresses: HistoricalLogsContractAddresses): L1HistoryEndpoint {
  const client = getPublicClient({ l1RpcUrls: [url], l1ChainId: chainId });
  return {
    url,
    getBlockHash: async blockNumber =>
      Buffer32.fromString((await client.getBlock({ blockNumber, includeTransactions: false })).hash),
    getClientVersion: async () => {
      try {
        const version = await client.request({ method: 'web3_clientVersion' });
        return typeof version === 'string' ? version : undefined;
      } catch {
        return undefined;
      }
    },
    rollup: new RollupContract(client, addresses.rollupAddress.toString()),
  };
}
