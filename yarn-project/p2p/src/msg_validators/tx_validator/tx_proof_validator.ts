import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { ClientProtocolCircuitVerifier } from '@aztec-labs/stdlib/interfaces/server';
import {
  TX_ERROR_INVALID_PROOF,
  TX_ERROR_PROOF_UNVERIFIABLE,
  Tx,
  type TxValidationResult,
  type TxValidator,
} from '@aztec-labs/stdlib/tx';

/**
 * Checks a tx's client proof. A proof is `invalid` only when a verification ran and rejected it; when the verifier could
 * not check it, for whatever reason, the result is `unverifiable` and says nothing about the tx.
 */
export class TxProofValidator implements TxValidator<Tx> {
  public readonly identifier: symbol = Symbol('TxProofValidator');

  #log: Logger;

  constructor(
    private verifier: ClientProtocolCircuitVerifier,
    bindings?: LoggerBindings,
  ) {
    this.#log = createLogger('p2p:tx_validator:proof', bindings);
  }

  async validateTx(tx: Tx): Promise<TxValidationResult> {
    let valid: boolean;
    try {
      ({ valid } = await this.verifier.verifyProof(tx));
    } catch (err) {
      this.#log.warn(`Could not verify proof of tx ${tx.getTxHash().toString()}`, {
        txHash: tx.getTxHash().toString(),
        err,
      });
      return { result: 'unverifiable', reason: [TX_ERROR_PROOF_UNVERIFIABLE] };
    }
    if (!valid) {
      this.#log.verbose(`Rejecting tx ${tx.getTxHash().toString()} for invalid proof`);
      return { result: 'invalid', reason: [TX_ERROR_INVALID_PROOF] };
    }
    this.#log.trace(`Accepted ${tx.getTxHash().toString()} with valid proof`);
    return { result: 'valid' };
  }
}
