import type { ContractArtifact } from '@aztec-labs/aztec.js/abi';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractInstanceWithAddress } from '@aztec-labs/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';

import { accountFunding, prepareFeeSession } from './fees.js';
import type { FeePolicy } from './types.js';

describe('payment-method fee policy', () => {
  let fpc: ContractInstanceWithAddress;
  let paymentMethod: FeePaymentMethod;
  let policy: FeePolicy;
  let registered: AztecAddress[];
  // Registers contracts; any balance read or tx would throw.
  let wallet: Wallet;

  beforeEach(async () => {
    fpc = { address: await AztecAddress.random() } as ContractInstanceWithAddress;
    paymentMethod = {
      getExecutionPayload: () => Promise.resolve({ calls: [{}, {}] }),
    } as unknown as FeePaymentMethod;
    policy = { kind: 'payment-method', paymentMethod, instance: fpc, artifact: {} as ContractArtifact };
    registered = [];
    wallet = {
      registerContract: (instance: ContractInstanceWithAddress) => {
        registered.push(instance.address);
        return Promise.resolve(instance);
      },
    } as unknown as Wallet;
  });

  it('funds an account with work without reading its balance', async () => {
    const account = await AztecAddress.random();
    await expect(accountFunding(policy, wallet, account, true)).resolves.toEqual({ kind: 'payment-method' });
  });

  it('registers the paying contract and pays every tx with the method', async () => {
    const address = await AztecAddress.random();
    const session = await prepareFeeSession({
      local: false,
      node: {} as AztecNode,
      wallet,
      accounts: [{ address, policy, funding: { kind: 'payment-method' } }],
      state: { addresses: {}, pendingClaims: {} },
      persist: () => {},
      reporter: {},
    });

    expect(registered).toEqual([fpc.address]);
    expect(session.next(address).fee).toEqual({ paymentMethod });
    expect(session.next(address).fee).toEqual({ paymentMethod });
    expect(session.hasPendingClaim(address)).toBe(false);
    await expect(session.feeCallCount(address)).resolves.toBe(2);
  });
});
