import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type {
  ContractClassIdPreimage,
  ContractClassWithId,
  ContractInstanceWithAddress,
} from '@aztec-labs/stdlib/contract';

/** A non-protocol contract deployed at a canonical artifact-derived address. */
export interface StandardContract {
  /** Canonical deployed instance. */
  instance: ContractInstanceWithAddress;
  /** Contract class of this contract. */
  contractClass: ContractClassWithId & ContractClassIdPreimage;
  /** Complete contract artifact. */
  artifact: ContractArtifact;
  /** Deployment address for the canonical instance. */
  address: AztecAddress;
}
