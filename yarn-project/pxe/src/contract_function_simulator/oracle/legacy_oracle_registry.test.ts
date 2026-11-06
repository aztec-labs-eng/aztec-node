/* eslint-disable camelcase */
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { toACVMField } from '@aztec-labs/simulator/client';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeFeeJuiceMessageNullifier } from '@aztec-labs/stdlib/messaging';
import { TxHash } from '@aztec-labs/stdlib/tx';

import { EphemeralArrayService } from '../ephemeral_array_service.js';
import { EphemeralArray } from '../noir-structs/ephemeral_array.js';
import { Option } from '../noir-structs/option.js';
import type { PendingTaggedLog } from '../noir-structs/pending_tagged_log.js';
import { buildACIRCallback } from './acir_callback.js';
import { LEGACY_ORACLE_REGISTRY, type LegacyOracleEntry } from './legacy_oracle_registry.js';
import { FIELD, U32 } from './oracle_registry.js';
import type { OutputSlot } from './oracle_type_mappings.js';

// How aztec-nr serializes `OnchainDeliveryMode::onchain_unconstrained()`. stdlib does not export its own constant for
// this value, to keep its public API small.
const ONCHAIN_UNCONSTRAINED_DELIVERY_MODE = 2;

type Handler = Parameters<typeof buildACIRCallback>[0];

describe('legacy oracle dispatch', () => {
  it('adapts the return wire: handler runs, result is mapped, then serialized through the legacy type', async () => {
    // Fixture scenario: the return override maps the handler's current result to the legacy value the old bytecode
    // expects, then serializes it through the legacy type.
    const handler = { isMisc: true, getRandomField: () => Promise.resolve(new Fr(41)) } as Handler;

    const legacyRegistry: Record<string, LegacyOracleEntry> = {
      aztec_misc_legacyReturn: {
        modernOracle: 'aztec_misc_getRandomField',
        returnType: { legacyType: FIELD, mapping: (result: Fr) => new Fr(result.toBigInt() + 1n) },
      },
    };

    const callback = buildACIRCallback(handler, { legacyRegistry });

    // Handler produces 41; the override maps it to the legacy value (41 + 1) the old bytecode expects.
    const wire = await callback['aztec_misc_legacyReturn']();

    expect(wire).toEqual([toACVMField(new Fr(42))]);
  });

  it('adapts the param wire: legacy args are deserialized, mapped, then passed to the modern handler', async () => {
    // Fixture scenario: the retired wire carried a single `major` field, but the current handler signature is
    // (major, minor). The param override deserializes that one-field wire and reshapes it into the modern arg tuple,
    // defaulting the `minor` the old bytecode never sent.
    const DEFAULTED_MINOR = 0;

    let handlerArgs: unknown[] | undefined;
    const handler = {
      isMisc: true,
      assertCompatibleOracleVersion: (...args: unknown[]) => {
        handlerArgs = args;
      },
    } as Handler;

    const legacyRegistry: Record<string, LegacyOracleEntry> = {
      aztec_misc_legacyParams: {
        modernOracle: 'aztec_misc_assertCompatibleOracleVersion',
        params: {
          legacyType: [{ name: 'major', type: U32 }],
          mapping: ([major]: number[]) => [major, DEFAULTED_MINOR],
        },
      },
    };

    const callback = buildACIRCallback(handler, { legacyRegistry });

    // Old bytecode sends one field (major = 5); the handler must still receive the full (major, minor) tuple.
    await callback['aztec_misc_legacyParams']([toACVMField(new Fr(5))]);

    expect(handlerArgs).toEqual([5, DEFAULTED_MINOR]);
  });

  it('awaits an async param mapping before invoking the modern handler', async () => {
    let handlerArgs: unknown[] | undefined;
    const handler = {
      isMisc: true,
      assertCompatibleOracleVersion: (...args: unknown[]) => {
        handlerArgs = args;
      },
    } as Handler;

    const legacyRegistry: Record<string, LegacyOracleEntry> = {
      aztec_misc_legacyAsyncParams: {
        modernOracle: 'aztec_misc_assertCompatibleOracleVersion',
        params: {
          legacyType: [{ name: 'major', type: U32 }],
          mapping: ([major]: number[]) => Promise.resolve([major + 1, 0]),
        },
      },
    };

    const callback = buildACIRCallback(handler, { legacyRegistry });

    await callback['aztec_misc_legacyAsyncParams']([toACVMField(new Fr(5))]);

    expect(handlerArgs).toEqual([6, 0]);
  });

  it('adapts the retired getL1ToL2MembershipWitness wire into the modern (messageHash, nullifier) args', async () => {
    // The retired oracle passed (contractAddress, messageHash, secret), the modern one takes the unsiloed nullifier
    // plus the address to silo it with. The adapter must derive exactly the fee juice nullifier so already-deployed
    // contracts keep working.
    const contractAddress = await AztecAddress.random();
    const messageHash = Fr.random();
    const secret = Fr.random();
    const privateContent = [secret];

    const entry = LEGACY_ORACLE_REGISTRY['aztec_utl_getL1ToL2MembershipWitness'];
    const [mappedMessageHash, mappedNullifier] = await entry.params!.mapping([contractAddress, messageHash, secret]);

    expect(mappedMessageHash).toEqual(messageHash);
    expect(mappedNullifier).toEqual(
      Option.some({ contractAddress, nullifier: await computeFeeJuiceMessageNullifier(messageHash, privateContent) }),
    );
  });

  it.each(['aztec_prv_getAppTaggingSecret', 'aztec_prv_getAppAddressDerivedTaggingSecret'])(
    'serves the retired %s name from the address-derived handler over the same wire',
    async retiredName => {
      const secret = Fr.random();
      const handler = {
        isPrivate: true,
        getAddressDerivedMessagingSecret: () => Promise.resolve(Option.some(secret)),
      } as unknown as Handler;
      const inputs = [[toACVMField(await AztecAddress.random())], [toACVMField(await AztecAddress.random())]];

      const callback = buildACIRCallback(handler);

      const legacyWire = await callback[retiredName](...inputs);
      expect(legacyWire).toEqual(await callback['aztec_prv_getAddressDerivedMessagingSecret'](...inputs));
    },
  );

  it('serves the retired resolveTaggingStrategy name from the messaging secret strategy handler over the same wire', async () => {
    const secret = Fr.random();
    const handler = {
      isPrivate: true,
      resolveMessagingSecretStrategy: () => Promise.resolve({ type: 'unconstrained-secret', secret }),
    } as unknown as Handler;
    const inputs = [
      [toACVMField(await AztecAddress.random())],
      [toACVMField(await AztecAddress.random())],
      [toACVMField(new Fr(ONCHAIN_UNCONSTRAINED_DELIVERY_MODE))],
    ];

    const callback = buildACIRCallback(handler);

    const legacyWire = await callback['aztec_prv_resolveTaggingStrategy'](...inputs);
    expect(legacyWire).toEqual(await callback['aztec_prv_resolveMessagingSecretStrategy'](...inputs));
  });

  it('serves the retired getPendingTaggedLogsV2 name with the V3 wire minus the messaging secret', async () => {
    const service = new EphemeralArrayService();
    const pendingTaggedLog: PendingTaggedLog = {
      log: [Fr.random(), Fr.random()],
      context: {
        txHash: TxHash.random(),
        uniqueNoteHashesInTx: [Fr.random()],
        firstNullifierInTx: Fr.random(),
        blockNumber: 7,
        blockHash: Fr.random(),
      },
      messagingSecret: Fr.random(),
    };
    const handler = {
      isUtility: true,
      getPendingTaggedLogsV3: () => Promise.resolve(EphemeralArray.fromValues(service, [pendingTaggedLog])),
    } as unknown as Handler;
    const inputs = [[toACVMField(await AztecAddress.random())], [toACVMField(service.newArray([]))]];

    const callback = buildACIRCallback(handler);

    const readOnlyElement = ([slot]: OutputSlot[]) => {
      if (Array.isArray(slot)) {
        throw new Error(`Expected an ephemeral array slot, got ${slot}`);
      }
      const [element] = service.readArrayAt(Fr.fromString(slot));
      return element;
    };
    const modernElement = readOnlyElement(await callback['aztec_utl_getPendingTaggedLogsV3'](...inputs));
    const legacyElement = readOnlyElement(await callback['aztec_utl_getPendingTaggedLogsV2'](...inputs));

    expect(modernElement.at(-1)).toEqual(pendingTaggedLog.messagingSecret);
    expect(legacyElement).toEqual(modernElement.slice(0, -1));
  });

  it('rejects a legacy name that collides with a live oracle', () => {
    const handler = { isMisc: true, getRandomField: () => Promise.resolve(new Fr(0)) } as Handler;
    const legacyRegistry: Record<string, LegacyOracleEntry> = {
      aztec_misc_getRandomField: {
        modernOracle: 'aztec_misc_getRandomField',
        returnType: { legacyType: FIELD, mapping: (result: Fr) => result },
      },
    };

    expect(() => buildACIRCallback(handler, { legacyRegistry })).toThrow('collides with a live oracle');
  });
});
