import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { FeeJuiceArtifact } from '@aztec-labs/protocol-contracts/fee-juice';
import { AuthRegistryArtifact, STANDARD_AUTH_REGISTRY_ADDRESS } from '@aztec-labs/standard-contracts/auth-registry';
import { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';

import { buildAllowedElement } from './allowed_setup_helpers.js';

let defaultAllowedSetupFunctions: AllowedElement[] | undefined;

/**
 * Returns the default list of functions allowed to run in the setup phase of a transaction.
 *
 * Each entry's `minGas` is the gas the call consumes in setup, which does not depend on its arguments.
 * `allowed_public_setup.test.ts` measures it by running each call through the public processor.
 */
export async function getDefaultAllowedSetupFunctions(): Promise<AllowedElement[]> {
  if (defaultAllowedSetupFunctions === undefined) {
    defaultAllowedSetupFunctions = await Promise.all([
      // AuthRegistry: needed for authwit support via private path (set_authorized_private enqueues _set_authorized)
      buildAllowedElement(AuthRegistryArtifact, { address: STANDARD_AUTH_REGISTRY_ADDRESS }, '_set_authorized', {
        onlySelf: true,
        rejectNullMsgSender: true,
        minGas: new Gas(64, 37_091),
      }),
      // AuthRegistry: needed for authwit support via public path (PublicFeePaymentMethod calls set_authorized directly)
      buildAllowedElement(AuthRegistryArtifact, { address: STANDARD_AUTH_REGISTRY_ADDRESS }, 'set_authorized', {
        rejectNullMsgSender: true,
        minGas: new Gas(64, 36_728),
      }),
      // FeeJuice: needed for claiming on the same tx as a spend (claim_and_end_setup enqueues this)
      buildAllowedElement(FeeJuiceArtifact, { address: ProtocolContractAddress.FeeJuice }, '_increase_public_balance', {
        onlySelf: true,
        minGas: new Gas(64, 37_523),
      }),
    ]);
  }
  return defaultAllowedSetupFunctions;
}
