/* eslint-disable camelcase */
import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { computeFeeJuiceMessageNullifier } from '@aztec-labs/stdlib/messaging';

import { PROTOCOL_ORACLE_VERSION } from '../../oracle_version.js';
import { Option } from '../noir-structs/option.js';
import type { IMiscOracle, IPrivateExecutionOracle, IUtilityExecutionOracle } from './interfaces.js';
import type { InferDeserializedParams, ParamTypes, RegistryParam } from './oracle_registry.js';
import {
  ARRAY,
  AZTEC_ADDRESS,
  BOOL,
  FIELD,
  MEMBERSHIP_WITNESS,
  type MaybePromise,
  OPTION,
  STR,
  type TypeMapping,
  U32,
} from './oracle_type_mappings.js';

type OracleHandlers = {
  misc: IMiscOracle;
  utl: IUtilityExecutionOracle;
  prv: IPrivateExecutionOracle;
};

/** An oracle served to the protocol contracts. */
export interface ProtocolOracleEntry {
  /** Which oracle handler `serve` takes.*/
  oracleKind: keyof OracleHandlers;
  /** The ordered named parameters of the wire, with their {@link TypeMapping}s. */
  params: readonly RegistryParam[];
  /** The return {@link TypeMapping} of the wire, or `undefined` for oracles that return nothing. */
  returnType?: TypeMapping;
  /** Serves a call from its deserialized args, returning the value `returnType` serializes. */
  serve: (handler: any, args: any) => unknown;
}

function protocolOracle<
  TOracleKind extends keyof OracleHandlers,
  const TParams extends RegistryParam[],
  TReturn = void,
>(
  oracleKind: TOracleKind,
  entry: {
    params: [...TParams];
    returnType?: TypeMapping<TReturn>;
    serve: (
      handler: OracleHandlers[TOracleKind],
      args: ParamTypes<InferDeserializedParams<TParams>>,
    ) => MaybePromise<NoInfer<TReturn>>;
  },
): ProtocolOracleEntry {
  return { oracleKind, ...entry };
}

/**
 * Oracles served to the protocol contracts, keyed by the name their bytecode calls. Protocol contracts are only
 * redeployed on a protocol upgrade, so their oracle interface is versioned by `PROTOCOL_ORACLE_VERSION` rather than by
 * the aztec.nr oracle version: the names and wires declared here must stay as they are no matter how `ORACLE_REGISTRY`
 * changes.
 *
 * Each entry declares its full wire and how to serve it with the oracle handler, so that a change to the handler only
 * requires adapting `serve`.
 */
export const PROTOCOL_ORACLE_REGISTRY: Record<string, ProtocolOracleEntry> = {
  aztec_protocol_misc_assertCompatibleOracleVersion: protocolOracle('misc', {
    params: [{ name: 'version', type: U32 }],
    serve: (_handler, [version]) => {
      // This oracle is handled here directly because no other PXE oracle deals with protocol oracle interface
      // versioning.
      if (version !== PROTOCOL_ORACLE_VERSION) {
        throw new Error(
          `Incompatible protocol oracle version: the protocol contract expects version ${version}, but this PXE serves version ${PROTOCOL_ORACLE_VERSION}.`,
        );
      }
    },
  }),

  aztec_protocol_misc_log: protocolOracle('misc', {
    params: [
      { name: 'level', type: U32 },
      { name: 'message', type: STR },
      { name: 'fieldsSize', type: U32 },
      { name: 'fields', type: ARRAY(FIELD) },
    ],
    serve: (handler, [level, message, fieldsSize, fields]) => handler.log(level, message, fieldsSize, fields),
  }),

  aztec_protocol_utl_getCapsule: protocolOracle('utl', {
    params: [
      { name: 'contractAddress', type: AZTEC_ADDRESS },
      { name: 'slot', type: FIELD },
      { name: 'tSize', type: U32 },
      { name: 'scope', type: AZTEC_ADDRESS },
    ],
    returnType: OPTION(ARRAY(FIELD)),
    serve: (handler, [contractAddress, slot, tSize, scope]) => handler.getCapsule(contractAddress, slot, tSize, scope),
  }),

  aztec_protocol_utl_getL1ToL2MembershipWitness: protocolOracle('utl', {
    params: [
      { name: 'contractAddress', type: AZTEC_ADDRESS },
      { name: 'messageHash', type: FIELD },
      { name: 'secret', type: FIELD },
    ],
    returnType: MEMBERSHIP_WITNESS(L1_TO_L2_MSG_TREE_HEIGHT),
    // The regular PXE handler takes the unsiloed message nullifier instead of the secret it is derived from. The only
    // protocol contract that uses this oracle is the FeeJuice contract, so we apply its derivation.
    serve: async (handler, [contractAddress, messageHash, secret]) =>
      handler.getL1ToL2MembershipWitnessV2(
        messageHash,
        Option.some({ contractAddress, nullifier: await computeFeeJuiceMessageNullifier(messageHash, secret) }),
      ),
  }),

  aztec_protocol_prv_setHashPreimage: protocolOracle('prv', {
    params: [
      { name: 'values', type: ARRAY(FIELD) },
      { name: 'hash', type: FIELD },
    ],
    serve: (handler, [values, hash]) => handler.setHashPreimage(values, hash),
  }),

  aztec_protocol_prv_notifyCreatedNullifier: protocolOracle('prv', {
    params: [{ name: 'innerNullifier', type: FIELD }],
    serve: (handler, [innerNullifier]) => handler.notifyCreatedNullifier(innerNullifier),
  }),

  aztec_protocol_prv_isNullifierPending: protocolOracle('prv', {
    params: [
      { name: 'innerNullifier', type: FIELD },
      { name: 'contractAddress', type: AZTEC_ADDRESS },
    ],
    returnType: BOOL,
    serve: (handler, [innerNullifier, contractAddress]) => handler.isNullifierPending(innerNullifier, contractAddress),
  }),

  aztec_protocol_prv_notifyCreatedContractClassLog: protocolOracle('prv', {
    params: [
      { name: 'contractAddress', type: AZTEC_ADDRESS },
      { name: 'message', type: ARRAY(FIELD) },
      { name: 'length', type: U32 },
      { name: 'counter', type: U32 },
    ],
    serve: (handler, [contractAddress, message, length, counter]) =>
      handler.notifyCreatedContractClassLog(contractAddress, message, length, counter),
  }),

  aztec_protocol_prv_assertValidPublicCalldata: protocolOracle('prv', {
    params: [{ name: 'calldataHash', type: FIELD }],
    serve: (handler, [calldataHash]) => handler.assertValidPublicCalldata(calldataHash),
  }),

  aztec_protocol_prv_notifyRevertiblePhaseStart: protocolOracle('prv', {
    params: [{ name: 'minRevertibleSideEffectCounter', type: U32 }],
    serve: (handler, [minRevertibleSideEffectCounter]) =>
      handler.notifyRevertiblePhaseStart(minRevertibleSideEffectCounter),
  }),
};
