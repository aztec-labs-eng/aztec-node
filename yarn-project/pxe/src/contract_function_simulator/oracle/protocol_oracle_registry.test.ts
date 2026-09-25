/* eslint-disable camelcase */
import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { makeTuple } from '@aztec-labs/foundation/array';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { toACVMField } from '@aztec-labs/simulator/client';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeFeeJuiceMessageNullifier } from '@aztec-labs/stdlib/messaging';

import { PROTOCOL_ORACLE_VERSION } from '../../oracle_version.js';
import { Option } from '../noir-structs/option.js';
import { UnavailableOracleError, buildACIRCallback } from './acir_callback.js';
import type { LegacyOracleEntry } from './legacy_oracle_registry.js';
import { FIELD, U32 } from './oracle_registry.js';
import type { ProtocolOracleEntry } from './protocol_oracle_registry.js';

type Handler = Parameters<typeof buildACIRCallback>[0];

describe('protocol oracle dispatch', () => {
  const protocolContract = ProtocolContractAddress.FeeJuice;

  it('serves a protocol contract with the oracle handler', async () => {
    const innerNullifier = Fr.random();
    const nullifierOwner = await AztecAddress.random();

    let handlerArgs: unknown[] | undefined;
    const handler = {
      isPrivate: true,
      isNullifierPending: (...args: unknown[]) => {
        handlerArgs = args;
        return Promise.resolve(true);
      },
    } as unknown as Handler;

    const callback = buildACIRCallback(handler, { contractAddress: protocolContract });
    const wire = await callback['aztec_protocol_prv_isNullifierPending'](
      [toACVMField(innerNullifier)],
      [toACVMField(nullifierOwner)],
    );

    expect(handlerArgs).toEqual([innerNullifier, nullifierOwner]);
    expect(wire).toEqual([toACVMField(new Fr(1))]);
  });

  it('is not served to callers that are not protocol contracts', async () => {
    const handler = { isPrivate: true, notifyCreatedNullifier: () => Promise.resolve() } as unknown as Handler;
    const inputs = [[toACVMField(Fr.random())]];

    const calledByAppContract = buildACIRCallback(handler, { contractAddress: await AztecAddress.random() });
    expect(() => calledByAppContract['aztec_protocol_prv_notifyCreatedNullifier'](...inputs)).toThrow(
      `Oracle 'aztec_protocol_prv_notifyCreatedNullifier' not found`,
    );

    const calledByNoContract = buildACIRCallback(handler);
    expect(() => calledByNoContract['aztec_protocol_prv_notifyCreatedNullifier'](...inputs)).toThrow(
      `Oracle 'aztec_protocol_prv_notifyCreatedNullifier' not found`,
    );
  });

  it('serves protocol contracts no oracles other than the protocol oracles', () => {
    const handler = { isMisc: true, getRandomField: () => Promise.resolve(Fr.random()) } as Handler;
    const legacyRegistry: Record<string, LegacyOracleEntry> = {
      aztec_misc_legacyGetRandomField: { modernOracle: 'aztec_misc_getRandomField' },
    };

    const callback = buildACIRCallback(handler, { contractAddress: protocolContract, legacyRegistry });

    expect(() => callback['aztec_misc_getRandomField']()).toThrow(
      `Oracle 'aztec_misc_getRandomField' not found. It was called by a protocol contract`,
    );
    expect(() => callback['aztec_misc_legacyGetRandomField']()).toThrow(
      `Oracle 'aztec_misc_legacyGetRandomField' not found. It was called by a protocol contract`,
    );
  });

  it('is unavailable to executions without the oracle handler of its kind', async () => {
    const utilityHandler = { isMisc: true, isUtility: true } as unknown as Handler;

    const callback = buildACIRCallback(utilityHandler, { contractAddress: protocolContract });

    await expect(callback['aztec_protocol_prv_notifyCreatedNullifier']([toACVMField(Fr.random())])).rejects.toThrow(
      UnavailableOracleError,
    );
  });

  it('deserializes the wire args for serve and serializes what it returns', async () => {
    // Fixture scenario: a wire that no single handler method matches. It carries one `major` field and returns a
    // field, while the handler method it is served with takes (major, minor) and returns nothing.
    let handlerArgs: unknown[] | undefined;
    const handler = {
      isMisc: true,
      assertCompatibleOracleVersion: (...args: unknown[]) => {
        handlerArgs = args;
      },
    } as Handler;

    const protocolRegistry: Record<string, ProtocolOracleEntry> = {
      aztec_protocol_misc_fixture: {
        oracleKind: 'misc',
        params: [{ name: 'major', type: U32 }],
        returnType: FIELD,
        serve: async (miscHandler: Handler, [major]: [number]) => {
          await miscHandler.assertCompatibleOracleVersion(major, 7);
          return new Fr(42);
        },
      },
    };

    const callback = buildACIRCallback(handler, { contractAddress: protocolContract, protocolRegistry });
    const wire = await callback['aztec_protocol_misc_fixture']([toACVMField(new Fr(5))]);

    expect(handlerArgs).toEqual([5, 7]);
    expect(wire).toEqual([toACVMField(new Fr(42))]);
  });

  it('derives the fee juice message nullifier for getL1ToL2MembershipWitness', async () => {
    const contractAddress = await AztecAddress.random();
    const messageHash = Fr.random();
    const secret = Fr.random();

    const witness = new MembershipWitness(
      L1_TO_L2_MSG_TREE_HEIGHT,
      7n,
      makeTuple(L1_TO_L2_MSG_TREE_HEIGHT, () => Fr.random()),
    );

    let handlerArgs: unknown[] | undefined;
    const handler = {
      isUtility: true,
      getL1ToL2MembershipWitnessV2: (...args: unknown[]) => {
        handlerArgs = args;
        return Promise.resolve(witness);
      },
    } as unknown as Handler;

    const callback = buildACIRCallback(handler, { contractAddress: protocolContract });
    const wire = await callback['aztec_protocol_utl_getL1ToL2MembershipWitness'](
      [toACVMField(contractAddress)],
      [toACVMField(messageHash)],
      [toACVMField(secret)],
    );

    expect(handlerArgs).toEqual([
      messageHash,
      Option.some({ contractAddress, nullifier: await computeFeeJuiceMessageNullifier(messageHash, secret) }),
    ]);
    expect(wire).toEqual([toACVMField(witness.leafIndex), witness.siblingPath.map(toACVMField)]);
  });

  describe('version check', () => {
    const handler = { isMisc: true } as Handler;
    const versionCheck = 'aztec_protocol_misc_assertCompatibleOracleVersion';

    it('accepts the protocol oracle version', async () => {
      const callback = buildACIRCallback(handler, { contractAddress: protocolContract });

      await expect(callback[versionCheck]([toACVMField(new Fr(PROTOCOL_ORACLE_VERSION))])).resolves.toEqual([]);
    });

    it('rejects any other version', async () => {
      const callback = buildACIRCallback(handler, { contractAddress: protocolContract });

      await expect(callback[versionCheck]([toACVMField(new Fr(PROTOCOL_ORACLE_VERSION + 1))])).rejects.toThrow(
        `Incompatible protocol oracle version: the protocol contract expects version ${PROTOCOL_ORACLE_VERSION + 1}`,
      );
    });

    it('is not served to callers that are not protocol contracts', async () => {
      const callback = buildACIRCallback(handler, { contractAddress: await AztecAddress.random() });

      expect(() => callback[versionCheck]([toACVMField(new Fr(PROTOCOL_ORACLE_VERSION))])).toThrow(
        `Oracle '${versionCheck}' not found`,
      );
    });
  });

  it('reports an unknown oracle called by a protocol contract against the protocol oracle version', () => {
    const callback = buildACIRCallback({ isMisc: true } as Handler, { contractAddress: protocolContract });

    expect(() => callback['aztec_protocol_utl_someNewOracle']()).toThrow(
      `Oracle 'aztec_protocol_utl_someNewOracle' not found. It was called by a protocol contract, whose oracles are` +
        ` those of protocol oracle version ${PROTOCOL_ORACLE_VERSION}`,
    );
  });
});
