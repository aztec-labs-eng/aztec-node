import type { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { AztecAddress } from '../aztec-address/index.js';

/** Provides a view into public contract state */
export interface PublicStateSource {
  /** Returns the value for a given slot at a given contract. */
  storageRead: (contractAddress: AztecAddress, slot: Fr) => Promise<Fr>;
}
