import { Fr } from '@aztec/foundation/curves/bn254';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';
import type { GasSettings } from '@aztec/stdlib/gas';
import type { ExecutionPayload, TxExecutionRequest } from '@aztec/stdlib/tx';

import { z } from 'zod';

/**
 * Information on the connected chain. Used by wallets when constructing transactions to protect against replay
 * attacks.
 */
export type ChainInfo = {
  /** The L1 chain id */
  chainId: Fr;
  /** The version of the rollup  */
  version: Fr;
};

/**
 * Zod schema for ChainInfo
 */
export const ChainInfoSchema = z.object({
  chainId: Fr.schema,
  version: Fr.schema,
});

/**
 * Creates transaction execution requests out of a set of function calls, a fee payment method and
 * general options for the transaction
 */
export interface EntrypointInterface {
  /**
   * Generates an execution request out of set of function calls.
   * @param exec - The execution intents to be run.
   * @param gasSettings - The gas settings for the transaction.
   * @param chainInfo - Chain information (chainId and version) for replay protection.
   * @param options - Miscellaneous tx options that enable/disable features of the entrypoint
   * @returns The authenticated transaction execution request.
   */
  createTxExecutionRequest(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options?: any,
  ): Promise<TxExecutionRequest>;

  /**
   * Wraps an execution payload such that it is executed *via* this entrypoint.
   * This returns an ExecutionPayload with the entrypoint as the caller for the wrapped payload.
   * Useful for account self-funding deployments and batching calls beyond the limit
   * of a single entrypoint call.
   *
   * Entrypoints that authorize the wrapped payload with an auth witness bind `gasSettings` into it and record them
   * on the returned payload, committing the transaction to those exact settings.
   *
   * @param exec - The execution payload to wrap
   * @param gasSettings - The gas settings the transaction executing the wrapped payload will use
   * @param chainInfo - Chain information (chainId and version) for replay protection
   * @param options - Implementation-specific options
   * @returns A new execution payload with a single call to this entrypoint
   * @throws Error if the payload cannot be wrapped (e.g., exceeds call limit)
   */
  wrapExecutionPayload(
    exec: ExecutionPayload,
    gasSettings: GasSettings,
    chainInfo: ChainInfo,
    options?: any,
  ): Promise<ExecutionPayload>;
}

/**
 * Asserts that the gas settings a transaction is being assembled with match the ones already bound into the
 * execution payload's auth witness (if any). A mismatch would produce a transaction whose witness fails
 * verification during simulation or proving, so this surfaces the problem with a clear error instead.
 * @param exec - The execution payload, possibly carrying bound gas settings
 * @param gasSettings - The gas settings the transaction is being assembled with
 */
export function assertMatchesBoundGasSettings(exec: ExecutionPayload, gasSettings: GasSettings): void {
  if (exec.gasSettings && !exec.gasSettings.equals(gasSettings)) {
    throw new Error(
      'The execution payload binds gas settings that differ from the ones provided for the transaction. ' +
        'Rebuild the payload with the desired gas settings or assemble the transaction with the bound ones.',
    );
  }
}

/** Creates authorization witnesses. */
export interface AuthWitnessProvider {
  /**
   * Computes an authentication witness from either a message hash
   * @param messageHash - The message hash to approve
   * @returns The authentication witness
   */
  createAuthWit(messageHash: Fr | Buffer): Promise<AuthWitness>;
}
