import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { Logger } from '@aztec-labs/foundation/log';
import { FunctionSelector, countArgumentsSize, getAllFunctionAbis } from '@aztec-labs/stdlib/abi';
import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';

/**
 * Builds an AllowedElement from a contract artifact, deriving both the function selector
 * and calldata length from the artifact instead of hardcoding signature strings.
 */
export async function buildAllowedElement(
  artifact: ContractArtifact,
  target: { address: AztecAddress } | { classId: Fr },
  functionName: string,
  opts?: { onlySelf?: boolean; rejectNullMsgSender?: boolean; minGas?: Gas },
): Promise<AllowedElement> {
  const allFunctions = getAllFunctionAbis(artifact);
  const fn = allFunctions.find(f => f.name === functionName);
  if (!fn) {
    throw new Error(`Unknown function ${functionName} in artifact ${artifact.name}`);
  }
  const selector = await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters);
  const calldataLength = 1 + countArgumentsSize(fn);
  return {
    ...target,
    selector,
    calldataLength,
    ...(opts?.onlySelf ? { onlySelf: true } : {}),
    ...(opts?.rejectNullMsgSender ? { rejectNullMsgSender: true } : {}),
    ...(opts?.minGas ? { minGas: opts.minGas } : {}),
  } as AllowedElement;
}

/**
 * Logs a warning for each operator-provided setup allow list entry that declares no minimum gas, since the setup gas
 * of calls to it is not checked at admission. Returns the entries it warned about.
 */
export function warnOnSetupEntriesWithoutMinGas(customEntries: AllowedElement[], log: Logger): AllowedElement[] {
  const unmetered = customEntries.filter(entry => entry.minGas === undefined);
  for (const entry of unmetered) {
    const target = 'address' in entry ? { address: entry.address.toString() } : { classId: entry.classId.toString() };
    log.warn(
      'Setup allow list entry has no minimum gas (l2=N, da=N), so the setup gas of calls to it is not checked. Declare the most gas the call can use in setup.',
      { ...target, selector: entry.selector.toString() },
    );
  }
  return unmetered;
}
