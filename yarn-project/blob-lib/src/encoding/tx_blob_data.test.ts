import {
  CONTRACT_CLASS_LOG_SIZE_IN_FIELDS,
  FLAT_PUBLIC_LOGS_PAYLOAD_LENGTH,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_PRIVATE_LOGS_PER_TX,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  PRIVATE_LOG_SIZE_IN_FIELDS,
} from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { BlobDeserializationError } from '../errors.js';
import { makeTxBlobData, makeTxStartMarker } from './fixtures.js';
import { decodeTxBlobData, encodeTxBlobData, getNumTxBlobFields } from './tx_blob_data.js';
import type { TxStartMarker } from './tx_start_marker.js';

describe('tx blob data', () => {
  it('encode and decode correctly', () => {
    const txBlobData = makeTxBlobData();
    const encoded = encodeTxBlobData(txBlobData);
    const decoded = decodeTxBlobData(encoded);
    expect(decoded).toEqual(txBlobData);
  });

  it('encodes and decodes a tx at every protocol maximum', () => {
    const txBlobData = makeTxBlobData({
      isFullTx: true,
      txStartMarker: { contractClassLogLength: CONTRACT_CLASS_LOG_SIZE_IN_FIELDS },
    });
    expect(txBlobData.privateLogs.every(log => log.length === PRIVATE_LOG_SIZE_IN_FIELDS)).toBe(true);
    expect(txBlobData.publicLogs).toHaveLength(FLAT_PUBLIC_LOGS_PAYLOAD_LENGTH);

    const decoded = decodeTxBlobData(encodeTxBlobData(txBlobData));
    expect(decoded).toEqual(txBlobData);
  });

  it.each<[keyof TxStartMarker, number]>([
    ['numNoteHashes', MAX_NOTE_HASHES_PER_TX],
    ['numNullifiers', MAX_NULLIFIERS_PER_TX],
    ['numL2ToL1Msgs', MAX_L2_TO_L1_MSGS_PER_TX],
    ['numPublicDataWrites', MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
    ['publicLogsLength', FLAT_PUBLIC_LOGS_PAYLOAD_LENGTH],
    ['contractClassLogLength', CONTRACT_CLASS_LOG_SIZE_IN_FIELDS],
  ])('rejects %s above its protocol maximum of %i', (key, max) => {
    const encoded = encodeTxBlobData(makeTxBlobData({ txStartMarker: { [key]: max + 1 } }));
    expect(() => decodeTxBlobData(encoded)).toThrow(BlobDeserializationError);
  });

  it('rejects more private logs than the protocol maximum', () => {
    const numPrivateLogs = MAX_PRIVATE_LOGS_PER_TX + 1;
    const encoded = encodeTxBlobData(
      makeTxBlobData({ txStartMarker: { numPrivateLogs, privateLogsLength: numPrivateLogs } }),
    );
    expect(() => decodeTxBlobData(encoded)).toThrow(BlobDeserializationError);
  });

  it('rejects a private log longer than the protocol maximum', () => {
    const length = PRIVATE_LOG_SIZE_IN_FIELDS + 1;
    const txBlobData = {
      ...makeTxBlobData(),
      txStartMarker: makeTxStartMarker({ numPrivateLogs: 1, privateLogsLength: length }),
      privateLogs: [Array.from({ length }, (_, i) => new Fr(i + 1))],
    };
    expect(() => decodeTxBlobData(encodeTxBlobData(txBlobData))).toThrow(BlobDeserializationError);
  });

  it('get num tx blob fields correctly', () => {
    const partialTxStartMarker = {
      numNoteHashes: 2,
      numNullifiers: 3,
      numL2ToL1Msgs: 4,
      numPublicDataWrites: 5,
      numPrivateLogs: 6,
      privateLogsLength: 78,
      publicLogsLength: 90,
      contractClassLogLength: 111,
    };
    const numTxBlobFields = getNumTxBlobFields(partialTxStartMarker);
    expect(numTxBlobFields).toEqual(
      3 + // tx start marker + tx hash + transaction fee
        2 +
        3 +
        4 +
        5 * 2 + // *2 for leaf slot and value per public data write
        6 +
        78 +
        90 +
        111 +
        1, // +1 for contract address of the contract class log
    );
  });

  it('get num tx blob fields correctly for tx without contract class log', () => {
    const partialTxStartMarker = {
      numNoteHashes: 2,
      numNullifiers: 3,
      numL2ToL1Msgs: 4,
      numPublicDataWrites: 5,
      numPrivateLogs: 6,
      privateLogsLength: 78,
      publicLogsLength: 90,
      contractClassLogLength: 0,
    };
    const numTxBlobFields = getNumTxBlobFields(partialTxStartMarker);
    expect(numTxBlobFields).toEqual(
      3 + // tx start marker + tx hash + transaction fee
        2 +
        3 +
        4 +
        5 * 2 +
        6 +
        78 +
        90,
    );
  });
});
