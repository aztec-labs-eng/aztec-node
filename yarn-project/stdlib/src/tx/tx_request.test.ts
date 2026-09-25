import { TX_REQUEST_LENGTH } from '@aztec-labs/constants';
import { randomInt } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { setupCustomSnapshotSerializers } from '@aztec-labs/foundation/testing';
import { updateInlineFndTestData } from '@aztec-labs/foundation/testing/files';

import { FunctionSelector } from '../abi/index.js';
import { AztecAddress } from '../aztec-address/index.js';
import { Gas, GasFees, GasSettings } from '../gas/index.js';
import { makeTxRequest } from '../tests/factories.js';
import { FunctionData } from './function_data.js';
import { TxContext } from './tx_context.js';
import { TxRequest } from './tx_request.js';

describe('TxRequest', () => {
  let request: TxRequest;

  beforeAll(() => {
    setupCustomSnapshotSerializers(expect);
    request = makeTxRequest(randomInt(1000));
  });

  it(`serializes to buffer and deserializes it back`, () => {
    const buffer = request.toBuffer();
    const res = TxRequest.fromBuffer(buffer);
    expect(res).toEqual(request);
    expect(res.isEmpty()).toBe(false);
  });

  it('number of fields matches constant', () => {
    const fields = request.toFields();
    expect(fields.length).toBe(TX_REQUEST_LENGTH);
  });

  it('compute protocol nullifier', async () => {
    const gasSettings = new GasSettings(new Gas(2, 2), new Gas(1, 1), new GasFees(4, 4), new GasFees(3, 3));
    const txRequest = TxRequest.from({
      origin: AztecAddress.fromBigIntUnsafe(1122n),
      argsHash: new Fr(33),
      txContext: new TxContext(new Fr(44), new Fr(55), gasSettings),
      functionData: new FunctionData(FunctionSelector.fromField(new Fr(66n)), /*isPrivate=*/ true),
      salt: new Fr(789),
    });

    const value = await txRequest.computeProtocolNullifierValue();
    const siloed = await txRequest.computeProtocolNullifier();

    expect(value.toString()).toMatchInlineSnapshot(
      `"0x274bc3bf8d36c9c8628a471d930d1d833dd5072df6fe108390f04f7d88418051"`,
    );
    expect(siloed.toString()).toMatchInlineSnapshot(
      `"0x032db509ef1efc8cdefdab5e059061d52e1b04aaccc04404f87d0bef7d0021e1"`,
    );

    // Gas settings and the first call's args are not part of the preimage.
    const bumped = TxRequest.from({
      ...txRequest,
      argsHash: new Fr(34),
      txContext: new TxContext(
        new Fr(44),
        new Fr(55),
        new GasSettings(new Gas(20, 20), new Gas(10, 10), new GasFees(40, 40), new GasFees(30, 30)),
      ),
    });
    expect((await bumped.computeProtocolNullifier()).equals(siloed)).toBe(true);
    // The salt and the origin are.
    const otherSalt = TxRequest.from({ ...txRequest, salt: new Fr(790) });
    expect((await otherSalt.computeProtocolNullifier()).equals(siloed)).toBe(false);
    const otherOrigin = TxRequest.from({ ...txRequest, origin: AztecAddress.fromBigIntUnsafe(1123n) });
    expect((await otherOrigin.computeProtocolNullifier()).equals(siloed)).toBe(false);

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data
    updateInlineFndTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/abis/transaction/tx_request.nr',
      'test_data_value',
      value.toString(),
    );
    updateInlineFndTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/abis/transaction/tx_request.nr',
      'test_data_siloed',
      siloed.toString(),
    );
  });
});
