import { randomInt } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonParseWithSchema, jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { Gas } from '../gas/gas.js';
import { makeAvmCircuitInputs } from '../tests/factories.js';
import { TxExecutionPhase } from '../tx/processed_tx.js';
import { AvmCircuitInputs, CallStackMetadata, PublicTxResult } from './avm.js';
import { deserializeFromMessagePack } from './message_pack.js';

describe('Avm circuit inputs', () => {
  // This tests that serde with the orchestrator works. Used in the JSON-RPC API.
  it(`serializes to JSON and deserializes it back`, async () => {
    const avmCircuitInputs = await makeAvmCircuitInputs(randomInt(2000));
    const json = jsonStringify(avmCircuitInputs);
    const res = jsonParseWithSchema(json, AvmCircuitInputs.schema);
    // Note: using toEqual instead of toStrictEqual to match other serialization tests in the codebase.
    // toEqual checks deep value equality, while toStrictEqual also checks prototypes and property
    // descriptors, which can differ for schema-reconstructed objects even when data is identical.
    expect(res).toEqual(avmCircuitInputs);
  });

  // This is a minimal requirement. It only tests that the MP serialization from TS
  // works, but it doesn't say much about the C++ MP serialization.
  // That is exercised in the simulator tests.
  it('serializes with MessagePack and deserializes it back', async () => {
    const avmCircuitInputs = await makeAvmCircuitInputs(/*seed=*/ 0x1234);
    const buffer = avmCircuitInputs.serializeWithMessagePack();
    const json = deserializeFromMessagePack(buffer);
    const res = AvmCircuitInputs.fromPlainObject(json);
    expect(res).toEqual(avmCircuitInputs);
  });
});

describe('CallStackMetadata', () => {
  const makeCall = (nested: CallStackMetadata[]) =>
    new CallStackMetadata(
      TxExecutionPhase.APP_LOGIC,
      Fr.random(),
      /*callerPc=*/ 3,
      /*calldata=*/ [Fr.random()],
      /*isStaticCall=*/ false,
      Gas.from({ daGas: 10, l2Gas: 20 }),
      /*output=*/ [Fr.random()],
      /*internalCallStackAtExit=*/ [1, 2],
      /*haltingMessage=*/ undefined,
      /*reverted=*/ false,
      nested,
      /*numNestedCalls=*/ nested.length,
    );

  it('parses nested call metadata from JSON', () => {
    const call = makeCall([makeCall([makeCall([])])]);
    expect(jsonParseWithSchema(jsonStringify(call), CallStackMetadata.schema)).toEqual(call);
  });

  it('parses a public tx result carrying nested call metadata', () => {
    const result = PublicTxResult.empty();
    result.callStackMetadata = [makeCall([makeCall([])])];
    expect(jsonParseWithSchema(jsonStringify(result), PublicTxResult.schema).callStackMetadata).toEqual(
      result.callStackMetadata,
    );
  });
});
