import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

/** Wire form of a contract class log. */
export type ContractClassLogData = {
  contractAddress: AztecAddress;
  fields: Fr[];
  emittedLength: number;
};
