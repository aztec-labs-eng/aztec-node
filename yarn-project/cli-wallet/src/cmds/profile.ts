import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { AuthWitness } from '@aztec-labs/aztec.js/authorization';
import { Contract } from '@aztec-labs/aztec.js/contracts';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { prepTx } from '@aztec-labs/cli/utils';
import type { LogFn } from '@aztec-labs/foundation/log';
import { serializePrivateExecutionSteps } from '@aztec-labs/stdlib/kernel';
import { promises as fs } from 'fs';
import path from 'path';

import type { CLIFeeArgs } from '../utils/options/fees.js';
import { printProfileResult } from '../utils/profiling.js';
import type { CLIWallet } from '../utils/wallet.js';

export async function profile(
  wallet: CLIWallet,
  node: AztecNode,
  from: AztecAddress,
  functionName: string,
  functionArgsIn: any[],
  contractArtifactPath: string,
  contractAddress: AztecAddress,
  debugOutputPath: string | undefined,
  feeOpts: CLIFeeArgs,
  authWitnesses: AuthWitness[],
  log: LogFn,
) {
  const { functionArgs, contractArtifact } = await prepTx(contractArtifactPath, functionName, functionArgsIn, log);

  const contract = Contract.at(contractAddress, contractArtifact, wallet);
  const call = contract.methods[functionName](...functionArgs);

  const { paymentMethod, gasSettings } = await feeOpts.toUserFeeOptions(node, wallet, from);
  const result = await call.profile({
    fee: { gasSettings, paymentMethod },
    from,
    profileMode: 'full',
    authWitnesses,
    skipProofGeneration: false,
  });
  printProfileResult(result.stats, log, true, result.executionSteps);
  if (debugOutputPath) {
    const ivcInputsPath = path.join(debugOutputPath, 'ivc-inputs.msgpack');
    log(`Debug output written to ${ivcInputsPath}.`);
    await fs.writeFile(ivcInputsPath, serializePrivateExecutionSteps(result.executionSteps));
  }
}
