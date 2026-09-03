import { BlobDeserializationError } from '@aztec-labs/blob-lib';
import { encodeTxStartMarker } from '@aztec-labs/blob-lib/encoding';
import {
  CONTRACT_CLASS_LOG_SIZE_IN_FIELDS,
  DomainSeparator,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_PRIVATE_LOGS_PER_TX,
  MAX_PUBLIC_LOG_SIZE_IN_FIELDS,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  PRIVATE_LOG_SIZE_IN_FIELDS,
} from '@aztec-labs/constants';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { updateInlineTestData } from '@aztec-labs/foundation/testing/files';

import { PublicDataWrite } from '../avm/public_data_write.js';
import { RevertCode } from '../avm/revert_code.js';
import { AztecAddress } from '../aztec-address/index.js';
import { Body } from '../block/body.js';
import { ContractClassLog } from '../logs/contract_class_log.js';
import { PrivateLog } from '../logs/private_log.js';
import { PublicLog } from '../logs/public_log.js';
import { TxEffect } from './tx_effect.js';
import { TxHash } from './tx_hash.js';

const CONTRACT_CLASS_LOG_ADDRESS = 77n;
const PUBLIC_LOG_ADDRESS = 200n;

/**
 * A tx effect with a couple of items in every field, mirrored field for field by `small_fixture` in
 * `noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/tx_effect.nr`.
 */
function smallFixture(): TxEffect {
  return new TxEffect(
    RevertCode.REVERTED,
    TxHash.fromBigInt(0x1234n),
    new Fr(42),
    [new Fr(11), new Fr(12)],
    [new Fr(21)],
    [new Fr(31)],
    [new PublicDataWrite(new Fr(41), new Fr(42))],
    [PrivateLog.fromBlobFields(3, [new Fr(101), new Fr(102), new Fr(103)])],
    [new PublicLog(AztecAddress.fromBigIntUnsafe(PUBLIC_LOG_ADDRESS), [new Fr(201), new Fr(202)])],
    [ContractClassLog.fromBlobFields(2, [new Fr(CONTRACT_CLASS_LOG_ADDRESS), new Fr(301), new Fr(302)])],
  );
}

function maximumFixture(): TxEffect {
  return new TxEffect(
    RevertCode.OK,
    TxHash.fromBigInt(0x1234n),
    new Fr(42),
    Array.from({ length: MAX_NOTE_HASHES_PER_TX }, (_, i) => new Fr(i + 1)),
    Array.from({ length: MAX_NULLIFIERS_PER_TX }, (_, i) => new Fr(i + 101)),
    Array.from({ length: MAX_L2_TO_L1_MSGS_PER_TX }, (_, i) => new Fr(i + 201)),
    Array.from(
      { length: MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX },
      (_, i) => new PublicDataWrite(new Fr(i + 301), new Fr(i + 401)),
    ),
    Array.from({ length: MAX_PRIVATE_LOGS_PER_TX }, (_, i) =>
      PrivateLog.fromBlobFields(PRIVATE_LOG_SIZE_IN_FIELDS, Array(PRIVATE_LOG_SIZE_IN_FIELDS).fill(new Fr(i + 501))),
    ),
    [
      new PublicLog(
        AztecAddress.fromBigIntUnsafe(601n),
        Array(MAX_PUBLIC_LOG_SIZE_IN_FIELDS).fill(new Fr(601)),
      ),
    ],
    [
      ContractClassLog.fromBlobFields(CONTRACT_CLASS_LOG_SIZE_IN_FIELDS, [
        new Fr(801),
        ...Array(CONTRACT_CLASS_LOG_SIZE_IN_FIELDS).fill(new Fr(701)),
      ]),
    ],
  );
}

const fieldHash = (blobFields: Fr[]) => poseidon2HashWithSeparator(blobFields, DomainSeparator.TX_EFFECT_CATEGORY_HASH);

describe('TxEffect', () => {
  it('converts to and from buffer', async () => {
    const txEffect = await TxEffect.random();
    const buf = txEffect.toBuffer();
    expect(TxEffect.fromBuffer(buf)).toEqual(txEffect);
  });

  it('convert to and from json', async () => {
    const txEffect = await TxEffect.random();
    const parsed = TxEffect.schema.parse(JSON.parse(jsonStringify(txEffect)));
    expect(parsed).toEqual(txEffect);
  });

  it('converts to and from blob data', async () => {
    const txEffect = await TxEffect.random();
    const data = txEffect.toTxBlobData();
    expect(TxEffect.fromTxBlobData(data)).toEqual(txEffect);
  });

  it('converts to and from blob fields', async () => {
    const txEffect = await TxEffect.random();
    const fields = txEffect.toBlobFields();
    expect(TxEffect.fromBlobFields(fields)).toEqual(txEffect);
  });

  it('converts empty to and from blob fields', () => {
    const txEffect = TxEffect.empty();
    const fields = txEffect.toBlobFields();
    expect(TxEffect.fromBlobFields(fields)).toEqual(txEffect);
  });

  it('fails with invalid blob fields', async () => {
    const txEffect = await TxEffect.random();
    const fields = txEffect.toBlobFields();
    // Replace the initial field with an invalid encoding
    fields[0] = new Fr(12);
    expect(() => TxEffect.fromBlobFields(fields)).toThrow(BlobDeserializationError);
  });

  it('fails with too few remaining blob fields', async () => {
    const txEffect = await TxEffect.random();
    const fields = txEffect.toBlobFields();
    fields.pop();
    expect(() => TxEffect.fromBlobFields(fields)).toThrow(BlobDeserializationError);
  });

  it('ignores extra blob fields', async () => {
    const txEffect = await TxEffect.random();
    const fields = txEffect.toBlobFields();
    fields.push(new Fr(7));
    expect(TxEffect.fromBlobFields(fields)).toEqual(txEffect);
  });

  it('rejects more contract class logs than the protocol maximum', () => {
    const txEffect = smallFixture();
    const extraLog = ContractClassLog.fromBlobFields(2, [new Fr(CONTRACT_CLASS_LOG_ADDRESS), new Fr(303), new Fr(304)]);
    expect(
      () =>
        new TxEffect(
          txEffect.revertCode,
          txEffect.txHash,
          txEffect.transactionFee,
          txEffect.noteHashes,
          txEffect.nullifiers,
          txEffect.l2ToL1Msgs,
          txEffect.publicDataWrites,
          txEffect.privateLogs,
          txEffect.publicLogs,
          [...txEffect.contractClassLogs, extraLog],
        ),
    ).toThrow(/Too many contract class logs/);
  });

  describe('effect hash', () => {
    it('hashes each field over its slice of the blob encoding', async () => {
      const txEffect = smallFixture();

      const expectedTxEffectHash = await poseidon2HashWithSeparator(
        [
          encodeTxStartMarker(txEffect.getTxStartMarker()),
          new Fr(42), // transactionFee
          await fieldHash([new Fr(11), new Fr(12)]),
          await fieldHash([new Fr(21)]),
          await fieldHash([new Fr(31)]),
          await fieldHash([new Fr(41), new Fr(42)]),
          await fieldHash([new Fr(3), new Fr(101), new Fr(102), new Fr(103)]),
          await fieldHash([new Fr(2), new Fr(PUBLIC_LOG_ADDRESS), new Fr(201), new Fr(202)]),
          await fieldHash([
            new Fr(CONTRACT_CLASS_LOG_ADDRESS),
            await txEffect.contractClassLogs[0].hash(),
          ]),
        ],
        DomainSeparator.TX_EFFECT_CATEGORIES_HASH,
      );

      expect(await txEffect.computeTxEffectCategoriesHash()).toEqual(expectedTxEffectHash);
    });

    it('hashes empty fields to zero', async () => {
      const txEffect = TxEffect.empty();

      const expectedTxEffectHash = await poseidon2HashWithSeparator(
        [encodeTxStartMarker(txEffect.getTxStartMarker()), Fr.ZERO, ...Array(7).fill(Fr.ZERO)],
        DomainSeparator.TX_EFFECT_CATEGORIES_HASH,
      );

      expect(await txEffect.computeTxEffectCategoriesHash()).toEqual(expectedTxEffectHash);
    });

    it('binds the tx hash into the leaf', async () => {
      const txEffect = smallFixture();

      const expectedLeaf = await poseidon2HashWithSeparator(
        [txEffect.txHash.hash, await txEffect.computeTxEffectCategoriesHash()],
        DomainSeparator.TX_EFFECTS_TREE_LEAF,
      );

      expect(await txEffect.computeTxEffectsTreeLeaf()).toEqual(expectedLeaf);
    });

    it('computes the leaf of the fixture', async () => {
      const leaf = await smallFixture().computeTxEffectsTreeLeaf();
      expect(leaf.toString()).toMatchInlineSnapshot(
        `"0x2d0cc62a893d49f71987d6bddb8d5d3f1efe4c7f015cbc8f4b7b2b04331a8978"`,
      );

      // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data
      updateInlineTestData(
        'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/tx_effect.nr',
        'test_data_tx_effect_leaf',
        leaf.toString(),
      );
    });

    it('matches the empty, maximum and three-tx Noir fixtures', async () => {
      const emptyEffect = TxEffect.empty();
      const maximumEffect = maximumFixture();
      const emptyLeaf = await emptyEffect.computeTxEffectsTreeLeaf();
      const maximumLeaf = await maximumEffect.computeTxEffectsTreeLeaf();
      const threeTxRoot = await new Body([emptyEffect, smallFixture(), maximumEffect]).computeTxEffectsTreeRoot();

      expect(emptyLeaf.toString()).toMatchInlineSnapshot(
        `"0x036639112ad40a8f951bfcc348b9906cee3f554dd05d0903c6e32a42d3f15d5a"`,
      );
      expect(maximumLeaf.toString()).toMatchInlineSnapshot(
        `"0x228fa718cc3dd39f719454454739a177add7a7ee2a127c3923f47a6b23d68118"`,
      );
      expect(threeTxRoot.toString()).toMatchInlineSnapshot(
        `"0x10aefe4df8cb37d89dc3278432c6c732c7b3740fb53d5ef128f86f9a9b4bbafb"`,
      );

      updateInlineTestData(
        'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/tx_effect.nr',
        'test_data_empty_tx_effect_leaf',
        emptyLeaf.toString(),
      );
      updateInlineTestData(
        'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/tx_effect.nr',
        'test_data_maximum_tx_effect_leaf',
        maximumLeaf.toString(),
      );
      updateInlineTestData(
        'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/tx_effect.nr',
        'test_data_three_tx_effects_tree_root',
        threeTxRoot.toString(),
      );
    });
  });
});
