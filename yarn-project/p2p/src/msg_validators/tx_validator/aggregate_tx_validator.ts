import type { TxValidationResult, TxValidator } from '@aztec-labs/stdlib/tx';

/**
 * Runs validators in order and stops at the first `invalid` result. An `unverifiable` result does not stop the run, so
 * an `invalid` from any validator takes precedence over it regardless of order; the first `unverifiable` is returned
 * only when no validator found the tx invalid.
 */
export class AggregateTxValidator<T> implements TxValidator<T> {
  readonly validators: TxValidator<T>[];
  constructor(...validators: TxValidator<T>[]) {
    if (validators.length === 0) {
      throw new Error('At least one validator must be provided');
    }

    this.validators = validators;
  }

  async validateTx(tx: T): Promise<TxValidationResult> {
    let unverifiable: TxValidationResult | undefined;
    for (const validator of this.validators) {
      const result = await validator.validateTx(tx);
      if (result.result === 'invalid') {
        return result;
      }
      if (result.result === 'unverifiable') {
        unverifiable ??= result;
      }
    }
    return unverifiable ?? { result: 'valid' };
  }
}
