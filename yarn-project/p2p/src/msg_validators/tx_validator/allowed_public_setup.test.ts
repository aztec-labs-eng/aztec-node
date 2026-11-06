import { PUBLIC_TX_L2_GAS_OVERHEAD, TX_DA_GAS_OVERHEAD } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { PublicProcessorTestEnv, type TestEnqueuedCall } from '@aztec-labs/simulator/public/fixtures';
import { STANDARD_AUTH_REGISTRY_ADDRESS } from '@aztec-labs/standard-contracts/auth-registry';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { Gas } from '@aztec-labs/stdlib/gas';
import type { AllowedElement } from '@aztec-labs/stdlib/interfaces/server';
import type { Tx } from '@aztec-labs/stdlib/tx';

import { getDefaultAllowedSetupFunctions } from './allowed_public_setup.js';
import { PhasesTxValidator } from './phases_validator.js';

describe('default setup allow list minimum gas', () => {
  const feePayer = AztecAddress.fromNumberUnsafe(42);
  const account = AztecAddress.fromNumberUnsafe(111);
  const otherAccount = AztecAddress.fromNumberUnsafe(222);
  // Gas the tester reports as used by private execution for a tx without teardown. Setup gets what the limits leave.
  const privateGasUsed = new Gas(TX_DA_GAS_OVERHEAD, PUBLIC_TX_L2_GAS_OVERHEAD);

  let env: PublicProcessorTestEnv;

  beforeEach(async () => {
    env = await PublicProcessorTestEnv.create();
    await env.tester.registerFeeJuiceContract();
    await env.tester.registerAuthContract();
    await env.tester.setFeePayerBalance(feePayer);
  });

  afterEach(async () => {
    await env[Symbol.asyncDispose]();
  });

  type SetupCase = { name: string; call: TestEnqueuedCall & { fnName: string }; otherArgs: unknown[] };

  const cases: SetupCase[] = [
    {
      name: 'AuthRegistry._set_authorized',
      call: {
        sender: STANDARD_AUTH_REGISTRY_ADDRESS,
        address: STANDARD_AUTH_REGISTRY_ADDRESS,
        fnName: '_set_authorized',
        args: [account, new Fr(7), true],
      },
      otherArgs: [otherAccount, new Fr(Fr.MODULUS - 1n), false],
    },
    {
      name: 'AuthRegistry.set_authorized',
      call: {
        sender: account,
        address: STANDARD_AUTH_REGISTRY_ADDRESS,
        fnName: 'set_authorized',
        args: [new Fr(7), true],
      },
      otherArgs: [new Fr(Fr.MODULUS - 1n), false],
    },
    {
      name: 'FeeJuice._increase_public_balance',
      call: {
        sender: ProtocolContractAddress.FeeJuice,
        address: ProtocolContractAddress.FeeJuice,
        fnName: '_increase_public_balance',
        args: [account, 1000n],
      },
      otherArgs: [otherAccount, 2n ** 120n],
    },
  ];

  /** Builds a tx whose only public call is the given setup call. Without gas limits it gets the per-tx maximums. */
  const makeTx = (call: TestEnqueuedCall, gasLimits?: Gas): Promise<Tx> =>
    env.tester.createTx(feePayer, [call], [], undefined, feePayer, undefined, gasLimits);

  const processTx = async (tx: Tx) => {
    const [processed, failed] = await env.processor.process([tx]);
    return { processed, failed };
  };

  const findDefaultEntry = async (tx: Tx): Promise<AllowedElement> => {
    const defaults = await getDefaultAllowedSetupFunctions();
    const [request] = tx.data.forPublic!.nonRevertibleAccumulatedData.publicCallRequests;
    const selector = tx.publicFunctionCalldata[0].values[0];
    const entry = defaults.find(
      e => 'address' in e && e.address.equals(request.contractAddress) && e.selector.toField().equals(selector),
    );
    expect(entry).toBeDefined();
    return entry!;
  };

  it.each(cases)('$name consumes exactly its minGas in setup', async ({ call, otherArgs }) => {
    const tx = await makeTx(call);
    const entry = await findDefaultEntry(tx);
    expect(entry.minGas).toBeDefined();
    const minGas = entry.minGas!;

    const measured = await processTx(tx);
    expect(measured.failed).toEqual([]);
    expect(measured.processed).toHaveLength(1);
    expect(measured.processed[0].revertCode.isOK()).toBe(true);
    // The tx has no app logic or teardown, so all of its public gas was consumed by setup.
    expect(measured.processed[0].gasUsed.publicGas).toEqual(minGas);

    // Gas limits leaving setup exactly minGas suffice, both on the state the first run wrote and for other arguments.
    const atMinimum = privateGasUsed.add(minGas);
    for (const args of [call.args, otherArgs]) {
      const { processed, failed } = await processTx(await makeTx({ ...call, args }, atMinimum));
      expect(failed).toEqual([]);
      expect(processed).toHaveLength(1);
      expect(processed[0].revertCode.isOK()).toBe(true);
    }

    // One unit less on either dimension fails setup, and the phases validator rejects the tx before execution.
    const validator = new PhasesTxValidator(env.tester.contractDataSource, [entry], env.globals.timestamp);
    for (const shortfall of [new Gas(1, 0), new Gas(0, 1)]) {
      const shortTx = await makeTx(call, atMinimum.sub(shortfall));
      await expect(validator.validateTx(shortTx)).resolves.toMatchObject({ result: 'invalid' });

      const { processed, failed } = await processTx(shortTx);
      expect(processed).toEqual([]);
      expect(failed).toHaveLength(1);
      expect(failed[0].error.message).toMatch(/SETUP/);
    }
  });
});
