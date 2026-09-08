import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Contract } from '@aztec-labs/aztec.js/contracts';
import { prepTx } from '@aztec-labs/cli/utils';
import type { LogFn } from '@aztec-labs/foundation/log';

import type { CLIWallet } from '../utils/wallet.js';

export async function createAuthwit(
  wallet: CLIWallet,
  from: AztecAddress,
  functionName: string,
  caller: AztecAddress,
  functionArgsIn: any[],
  contractArtifactPath: string,
  contractAddress: AztecAddress,
  log: LogFn,
) {
  const { functionArgs, contractArtifact, isPrivate } = await prepTx(
    contractArtifactPath,
    functionName,
    functionArgsIn,
    log,
  );

  if (!isPrivate) {
    throw new Error(
      'Cannot create an authwit for a public function. To allow a third party to call a public function, please authorize the action via the authorize-action command',
    );
  }

  const contract = Contract.at(contractAddress, contractArtifact, wallet);
  const call = await contract.methods[functionName](...functionArgs).getFunctionCall();

  const witness = await wallet.createAuthWit(from, { caller, call });

  log(`Created authorization witness for action ${functionName} on contract ${contractAddress} for caller ${caller}`);

  return witness;
}
