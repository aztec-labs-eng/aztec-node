import { poseidon2HashBytes } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { AuthWitness } from '@aztec/stdlib/auth-witness';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { GasSettings } from '@aztec/stdlib/gas';
import { ExecutionPayload } from '@aztec/stdlib/tx';

import {
  AccountFeePaymentMethodOptions,
  DefaultAccountEntrypoint,
  type DefaultAccountEntrypointOptions,
  ENTRYPOINT_PAYLOAD_DOMAIN_SEPARATOR,
} from './account_entrypoint.js';
import type { AuthWitnessProvider, ChainInfo } from './interfaces.js';

describe('DefaultAccountEntrypoint', () => {
  // Returns the message hash as the witness request hash, so tests can observe exactly what the account is asked
  // to authorize without involving keys.
  const authWitnessProvider: AuthWitnessProvider = {
    createAuthWit: (messageHash: Fr | Buffer) =>
      Promise.resolve(
        new AuthWitness(Fr.fromBuffer(Buffer.isBuffer(messageHash) ? messageHash : messageHash.toBuffer()), []),
      ),
  };

  const address = AztecAddress.fromNumberUnsafe(42);
  const chainInfo: ChainInfo = { chainId: new Fr(1), version: new Fr(2) };

  const gasSettings = GasSettings.from({
    gasLimits: { daGas: 100, l2Gas: 200 },
    teardownGasLimits: { daGas: 10, l2Gas: 20 },
    maxFeesPerGas: { feePerDaGas: 3n, feePerL2Gas: 4n },
    maxPriorityFeesPerGas: { feePerDaGas: 1n, feePerL2Gas: 2n },
  });

  const baseOptions: DefaultAccountEntrypointOptions = {
    txNonce: new Fr(7),
    cancellable: false,
    feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
  };

  const getPayloadAuthWitnessHash = async (
    options: DefaultAccountEntrypointOptions,
    requestGasSettings: GasSettings = gasSettings,
  ): Promise<Fr> => {
    const entrypoint = new DefaultAccountEntrypoint(address, authWitnessProvider);
    const request = await entrypoint.createTxExecutionRequest(
      ExecutionPayload.empty(),
      requestGasSettings,
      chainInfo,
      options,
    );
    return request.authWitnesses.at(-1)!.requestHash;
  };

  it('computes the same payload auth witness for identical requests', async () => {
    const first = await getPayloadAuthWitnessHash(baseOptions);
    const second = await getPayloadAuthWitnessHash(baseOptions);
    expect(first.equals(second)).toBe(true);
  });

  it.each([
    [AccountFeePaymentMethodOptions.EXTERNAL, AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE],
    [AccountFeePaymentMethodOptions.EXTERNAL, AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM],
    [AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE, AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM],
  ])('binds the fee payment method into the payload auth witness (%i vs %i)', async (from, to) => {
    const first = await getPayloadAuthWitnessHash({ ...baseOptions, feePaymentMethodOptions: from });
    const second = await getPayloadAuthWitnessHash({ ...baseOptions, feePaymentMethodOptions: to });
    expect(first.equals(second)).toBe(false);
  });

  it('binds the cancellable flag into the payload auth witness', async () => {
    const first = await getPayloadAuthWitnessHash({ ...baseOptions, cancellable: false });
    const second = await getPayloadAuthWitnessHash({ ...baseOptions, cancellable: true });
    expect(first.equals(second)).toBe(false);
  });

  it.each([
    ['gasLimits', { gasLimits: { daGas: 101, l2Gas: 200 } }],
    ['teardownGasLimits', { teardownGasLimits: { daGas: 11, l2Gas: 20 } }],
    ['maxFeesPerGas', { maxFeesPerGas: { feePerDaGas: 5n, feePerL2Gas: 4n } }],
    ['maxPriorityFeesPerGas', { maxPriorityFeesPerGas: { feePerDaGas: 1n, feePerL2Gas: 3n } }],
  ] as const)('binds the gas settings into the payload auth witness (%s)', async (_dimension, override) => {
    const first = await getPayloadAuthWitnessHash(baseOptions);
    const changed = GasSettings.from({ ...gasSettings, ...override });
    const second = await getPayloadAuthWitnessHash(baseOptions, changed);
    expect(first.equals(second)).toBe(false);
  });

  it('records the bound gas settings on wrapped execution payloads', async () => {
    const entrypoint = new DefaultAccountEntrypoint(address, authWitnessProvider);
    const wrapped = await entrypoint.wrapExecutionPayload(ExecutionPayload.empty(), gasSettings, chainInfo, {
      ...baseOptions,
      feePaymentMethodOptions: AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE,
    });
    expect(wrapped.gasSettings?.equals(gasSettings)).toBe(true);
  });

  it('rejects assembling a transaction with gas settings that differ from the bound ones', async () => {
    const entrypoint = new DefaultAccountEntrypoint(address, authWitnessProvider);
    const wrapped = await entrypoint.wrapExecutionPayload(ExecutionPayload.empty(), gasSettings, chainInfo, {
      ...baseOptions,
      feePaymentMethodOptions: AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE,
    });
    const otherGasSettings = GasSettings.from({ ...gasSettings, gasLimits: { daGas: 999, l2Gas: 999 } });
    await expect(
      entrypoint.createTxExecutionRequest(wrapped, otherGasSettings, chainInfo, baseOptions),
    ).rejects.toThrow(/binds gas settings/);
  });

  // Pins the gas settings field order against the Noir side (gas_settings_serialization_order in
  // aztec/src/authwit/account.nr, same literal vector): the payload hash preimage appends these fields, so a
  // serialization reorder on either side fails one of the two tests.
  it('serializes gas settings in the same field order as Noir', () => {
    const settings = GasSettings.from({
      gasLimits: { daGas: 1, l2Gas: 2 },
      teardownGasLimits: { daGas: 3, l2Gas: 4 },
      maxFeesPerGas: { feePerDaGas: 5n, feePerL2Gas: 6n },
      maxPriorityFeesPerGas: { feePerDaGas: 7n, feePerL2Gas: 8n },
    });
    expect(settings.toFields().map(field => field.toBigInt())).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
  });

  // Guards against drift from the Noir DOM_SEP__ENTRYPOINT_PAYLOAD, which is hand-mirrored here. Re-derives the
  // value from the separator name the same way the Noir domain separators are derived (poseidon over the
  // "az_dom_sep__<name>" byte string, truncated to a u32) rather than pinning a magic number.
  it('mirrors the Noir entrypoint payload domain separator', async () => {
    const derived = Number(
      (await poseidon2HashBytes(Buffer.from('az_dom_sep__entrypoint_payload'))).toBigInt() & 0xffffffffn,
    );
    expect(ENTRYPOINT_PAYLOAD_DOMAIN_SEPARATOR).toEqual(derived);
  });
});
