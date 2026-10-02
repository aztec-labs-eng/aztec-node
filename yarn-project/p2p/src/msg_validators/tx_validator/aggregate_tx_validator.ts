import type { TxValidationResult, TxValidator } from '@aztec-labs/stdlib/tx';

/**
 * Runs validators in order and stops at the first one that does not pass, returning its result. Cheap validators go
 * first, so a deterministic `invalid` from one of them wins over an `unverifiable` from a later proof check.
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
    for (const validator of this.validators) {
      const result = await validator.validateTx(tx);
      if (result.result !== 'valid') {
        return result;
      }
    }
    return { result: 'valid' };
  }
}
