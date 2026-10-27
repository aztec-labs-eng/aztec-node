import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { FunctionCall, FunctionSelector, FunctionType } from '@aztec-labs/stdlib/abi';
import { AuthWitness } from '@aztec-labs/stdlib/auth-witness';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { ExecutionPayload } from '@aztec-labs/stdlib/tx';

import { AccountFeePaymentMode, DefaultAccountEntrypoint } from './account_entrypoint.js';
import type { ChainInfo } from './interfaces.js';

describe('DefaultAccountEntrypoint', () => {
  let address: AztecAddress;
  let entrypoint: DefaultAccountEntrypoint;
  let chainInfo: ChainInfo;
  let txNonce: Fr;
  let calls: FunctionCall[];

  beforeEach(async () => {
    address = await AztecAddress.random();
    entrypoint = new DefaultAccountEntrypoint(address, {
      createAuthWit: () => Promise.resolve(new AuthWitness(Fr.ZERO, [])),
    });
    chainInfo = { chainId: new Fr(1), version: new Fr(1) };
    txNonce = Fr.random();
    calls = [
      FunctionCall.from({
        name: 'transfer',
        to: await AztecAddress.random(),
        selector: FunctionSelector.random(),
        type: FunctionType.PRIVATE,
        hideMsgSender: false,
        isStatic: false,
        args: [Fr.random()],
        returnType: { kind: 'field' as const },
      }),
    ];
  });

  /** Returns the arguments the account entrypoint is called with to run `calls`, paid for by `feePayer`. */
  async function getEntrypointArgs(feePayer: AztecAddress | undefined, feePaymentMode?: AccountFeePaymentMode) {
    const exec = new ExecutionPayload(calls, [], [], [], feePayer);
    const wrapped = await entrypoint.wrapExecutionPayload(exec, chainInfo, { txNonce, feePaymentMode });
    return wrapped.calls[0].args;
  }

  it('pays with its fee juice when nothing pays the fee', async () => {
    expect(await getEntrypointArgs(undefined)).toEqual(
      await getEntrypointArgs(undefined, AccountFeePaymentMode.PREEXISTING_FEE_JUICE),
    );
  });

  it('claims fee juice when it is the fee payer', async () => {
    expect(await getEntrypointArgs(address)).toEqual(
      await getEntrypointArgs(address, AccountFeePaymentMode.FEE_JUICE_WITH_CLAIM),
    );
  });

  it('leaves the fee to any other fee payer', async () => {
    const feePayer = await AztecAddress.random();
    expect(await getEntrypointArgs(feePayer)).toEqual(
      await getEntrypointArgs(feePayer, AccountFeePaymentMode.EXTERNAL),
    );
  });

  it('uses an explicit fee payment mode over the derived one', async () => {
    const feePayer = await AztecAddress.random();
    expect(await getEntrypointArgs(feePayer, AccountFeePaymentMode.PREEXISTING_FEE_JUICE)).not.toEqual(
      await getEntrypointArgs(feePayer),
    );
  });
});
