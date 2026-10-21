import type { ViemPublicDebugClient } from '@aztec-labs/ethereum/types';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { Hex } from 'viem';
import type { ZodSchema } from 'zod';

import { callTraceSchema } from './debug_tx.js';
import { traceTransactionResponseSchema } from './trace_tx.js';

type TraceMethod = 'debug_traceTransaction' | 'trace_transaction';

/**
 * Outcome of probing a trace method: `unsupported` when the request fails, `malformed` when the endpoint answers but
 * the response does not pass the schema the archiver parses it with.
 */
type TraceProbeResult = 'supported' | 'unsupported' | 'malformed';

/**
 * Helper function to test a trace method with validation
 *
 * @param client - The Viem public debug client
 * @param txHash - Transaction hash to trace
 * @param schema - Zod schema to validate the response
 * @param method - Name of the RPC method ('debug_traceTransaction' or 'trace_transaction')
 * @param blockType - Type of block being tested ('recent' or 'old')
 * @param logger - Logger instance
 */
async function testTraceMethod(
  client: ViemPublicDebugClient,
  txHash: Hex,
  schema: ZodSchema,
  method: TraceMethod,
  blockType: string,
  logger: Logger,
): Promise<TraceProbeResult> {
  let result: unknown;
  try {
    // Make request with appropriate params based on method name
    result = await client.request(
      method === 'debug_traceTransaction'
        ? { method, params: [txHash, { tracer: 'callTracer' }] }
        : { method, params: [txHash] },
    );
  } catch (error) {
    logger.warn(`${method} failed for ${blockType} blocks: ${error}`);
    return 'unsupported';
  }

  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    logger.warn(`${method} returned a trace that failed validation for ${blockType} blocks`, {
      method,
      txHash,
      issues: parsed.error.issues.slice(0, 5),
    });
    return 'malformed';
  }

  logger.debug(`${method} works for ${blockType} blocks`);
  return 'supported';
}

/** Result of trace availability checks */
export interface TraceAvailability {
  /** Whether debug_traceTransaction works for recent blocks */
  debugTraceRecent: boolean;
  /** Whether trace_transaction works for recent blocks */
  traceTransactionRecent: boolean;
  /** Whether debug_traceTransaction works for old blocks (512 blocks ago) */
  debugTraceOld: boolean;
  /** Whether trace_transaction works for old blocks (512 blocks ago) */
  traceTransactionOld: boolean;
  /** Whether no recent block had a transaction to probe with, so availability could not be determined */
  noTxToProbe: boolean;
  /** Methods the endpoint served but whose response failed validation, which points at the archiver, not the endpoint */
  malformedTraceMethods: TraceMethod[];
}

/**
 * Validates the availability of debug/trace methods on the Ethereum client.
 *
 * @param client - The Viem public debug client
 * @param bindings - Optional logger bindings for context
 * @returns Object indicating which trace methods are available for recent and old blocks
 */
export async function validateTraceAvailability(
  client: ViemPublicDebugClient,
  bindings?: LoggerBindings,
): Promise<TraceAvailability> {
  const logger = createLogger('archiver:validate_trace', bindings);
  const result: TraceAvailability = {
    debugTraceRecent: false,
    traceTransactionRecent: false,
    debugTraceOld: false,
    traceTransactionOld: false,
    noTxToProbe: false,
    malformedTraceMethods: [],
  };

  const probe = async (txHash: Hex, schema: ZodSchema, method: TraceMethod, blockType: string) => {
    const outcome = await testTraceMethod(client, txHash, schema, method, blockType, logger);
    if (outcome === 'malformed' && !result.malformedTraceMethods.includes(method)) {
      result.malformedTraceMethods.push(method);
    }
    return outcome === 'supported';
  };

  try {
    // Get the latest block
    let latestBlock = await client.getBlock({ blockTag: 'latest' });
    let attempts = 10;

    // Loop back to find a block with transactions (handles dev/test scenarios)
    while (!hasTxs(latestBlock) && latestBlock.number && latestBlock.number > 0n && --attempts > 0) {
      logger.debug(`Block ${latestBlock.number} has no transactions, checking previous block`);
      latestBlock = await client.getBlock({ blockNumber: latestBlock.number - 1n });
    }

    if (!hasTxs(latestBlock)) {
      logger.warn('No blocks with transactions found from latest back to genesis, cannot validate trace availability');
      result.noTxToProbe = true;
      return result;
    }

    // Get a transaction from the found block
    const recentTxHash = latestBlock.transactions[0] as Hex;

    // Test debug_traceTransaction with recent block
    result.debugTraceRecent = await probe(recentTxHash, callTraceSchema, 'debug_traceTransaction', 'recent');

    // Test trace_transaction with recent block
    result.traceTransactionRecent = await probe(
      recentTxHash,
      traceTransactionResponseSchema,
      'trace_transaction',
      'recent',
    );

    // Get a block from 512 blocks ago
    const oldBlockNumber = latestBlock.number ? latestBlock.number - 512n : null;
    if (!oldBlockNumber || oldBlockNumber < 0n) {
      logger.debug('Cannot test old blocks, blockchain too short');
      return result;
    }

    let oldBlock = await client.getBlock({ blockNumber: oldBlockNumber });
    attempts = 10;

    // Loop back to find a block with transactions (handles dev/test scenarios)
    while (!hasTxs(oldBlock) && oldBlock.number && oldBlock.number > 0n && --attempts > 0) {
      logger.debug(`Block ${oldBlock.number} has no transactions, checking previous block`);
      oldBlock = await client.getBlock({ blockNumber: oldBlock.number - 1n });
    }

    if (!hasTxs(oldBlock)) {
      logger.debug(
        'No blocks with transactions found from old block back to genesis, cannot validate trace availability for old blocks',
      );
      return result;
    }

    const oldTxHash = oldBlock.transactions[0] as Hex;

    // Test debug_traceTransaction with old block
    result.debugTraceOld = await probe(oldTxHash, callTraceSchema, 'debug_traceTransaction', 'old');

    // Test trace_transaction with old block
    result.traceTransactionOld = await probe(oldTxHash, traceTransactionResponseSchema, 'trace_transaction', 'old');
  } catch (error) {
    logger.warn(`Error validating debug_traceTransaction and trace_transaction availability: ${error}`);
  }

  return result;
}

function hasTxs(block: { transactions?: Hex[] }): boolean {
  return Array.isArray(block.transactions) && block.transactions.length > 0;
}

/**
 * Validates trace availability and logs appropriate messages based on the results.
 * Optionally throws an error if no trace methods are available and ethereumAllowNoDebugHosts is false.
 *
 * @param client - The Viem public debug client
 * @param ethereumAllowNoDebugHosts - If false, throws an error when no trace methods are available
 * @param bindings - Optional logger bindings for context
 * @throws Error if ethereumAllowNoDebugHosts is false and no trace methods are available
 */
export async function validateAndLogTraceAvailability(
  client: ViemPublicDebugClient,
  ethereumAllowNoDebugHosts: boolean,
  bindings?: LoggerBindings,
): Promise<void> {
  const logger = createLogger('archiver:validate_trace', bindings);
  logger.debug('Validating trace/debug method availability...');

  const availability = await validateTraceAvailability(client, bindings);

  // Check if we have support for old blocks (either debug or trace)
  const hasOldBlockSupport = availability.debugTraceOld || availability.traceTransactionOld;

  if (hasOldBlockSupport) {
    // Ideal case: we have trace support for old blocks
    const methods: string[] = [];
    if (availability.debugTraceOld) {
      methods.push('debug_traceTransaction');
    }
    if (availability.traceTransactionOld) {
      methods.push('trace_transaction');
    }
    logger.info(
      `Ethereum client supports trace methods for old blocks (${methods.join(', ')}). Archiver can retrieve historical transaction traces.`,
    );
  } else if (availability.debugTraceRecent || availability.traceTransactionRecent) {
    // Warning case: only recent block support
    const methods: string[] = [];
    if (availability.debugTraceRecent) {
      methods.push('debug_traceTransaction');
    }
    if (availability.traceTransactionRecent) {
      methods.push('trace_transaction');
    }
    logger.warn(
      `Ethereum client only supports trace methods for recent blocks (${methods.join(', ')}). Historical transaction traces may not be available.`,
    );
  } else if (availability.noTxToProbe) {
    // An idle dev or test chain can have no recent transaction to trace, which says nothing about the endpoint
    logger.warn('Starting without confirming that the Ethereum debug client supports trace methods');
  } else {
    // Error case: no support at all
    const malformed = availability.malformedTraceMethods;
    const errorMessage =
      malformed.length > 0
        ? `Ethereum debug client returned traces that failed validation for ${malformed.join(', ')}, ` +
          'so the archiver cannot read checkpoints published through contracts it does not recognize ' +
          'and stops syncing at the first one. The endpoint serves the method, so this is an archiver ' +
          'parsing issue rather than an endpoint misconfiguration; please report it.'
        : 'Ethereum debug client does not support debug_traceTransaction or trace_transaction methods. ' +
          'The archiver needs a trace to read checkpoints published through contracts it does not recognize, ' +
          'and stops syncing at the first one it cannot read. Point ETHEREUM_DEBUG_HOSTS at a trace-capable endpoint.';

    if (ethereumAllowNoDebugHosts) {
      logger.warn(`${errorMessage} Continuing because ETHEREUM_ALLOW_NO_DEBUG_HOSTS is set to true.`);
    } else {
      logger.error(errorMessage);
      throw new Error(`${errorMessage} Set ETHEREUM_ALLOW_NO_DEBUG_HOSTS=true to start anyway.`);
    }
  }
}
