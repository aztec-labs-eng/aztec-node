/**
 * The `@aztec/accounts/schnorr` export provides an account contract implementation that uses Schnorr signatures with a Grumpkin key for authentication, and a separate Grumpkin key for encryption.
 * This is the suggested account contract type for most use cases within Aztec.
 *
 * @packageDocumentation
 */
import { getAccountContractAddress } from '@aztec/aztec.js/account';
import { Fr } from '@aztec/foundation/curves/bn254';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import { loadContractArtifact } from '@aztec/stdlib/abi';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';

import { deriveSecretKeyFromSigningKey } from '../../utils/key_derivation.js';
import { SchnorrBaseAccountContract } from '../account_contract.js';

/**
 * Lazily loads the contract artifact
 * @returns The contract artifact for the schnorr account contract
 */
export async function getSchnorrAccountContractArtifact() {
  // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
  // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
  // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
  // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
  // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
  const { default: schnorrAccountContractJson } = await import('../../../artifacts/SchnorrAccount.json');
  return loadContractArtifact(schnorrAccountContractJson);
}

/**
 * Account contract that authenticates transactions using Schnorr signatures
 * verified against a Grumpkin public key stored in an immutable encrypted note.
 * Lazily loads the contract artifact
 */
export class SchnorrAccountContract extends SchnorrBaseAccountContract {
  constructor(signingPrivateKey: GrumpkinScalar) {
    super(signingPrivateKey);
  }

  override getContractArtifact(): Promise<ContractArtifact> {
    return getSchnorrAccountContractArtifact();
  }
}

/**
 * Compute the address of a schnorr account contract.
 * @param signingPrivateKey - The account's signing private key.
 * @param salt - The contract address salt.
 * @param secretKey - Seed for the account's privacy keys. Derived from the signing key when omitted.
 */
export async function getSchnorrAccountContractAddress(
  signingPrivateKey: GrumpkinScalar,
  salt: Fr,
  secretKey?: Fr,
): Promise<AztecAddress> {
  const resolvedSecretKey = secretKey ?? (await deriveSecretKeyFromSigningKey(signingPrivateKey));
  const accountContract = new SchnorrAccountContract(signingPrivateKey);
  return await getAccountContractAddress(accountContract, resolvedSecretKey, salt);
}
