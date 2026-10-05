import { TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { AppendOnlyTreeSnapshot } from '../trees/append_only_tree_snapshot.js';
import { TreeSnapshots } from '../tx/tree_snapshots.js';
import { AvmCircuitInputs, AvmExecutionHints } from './avm.js';
import { AvmCircuitPublicInputs } from './avm_circuit_public_inputs.js';
import { deserializeFromMessagePack, serializeWithMessagePack } from './message_pack.js';

const FLOAT64_MARKER = 0xcb;
const LEAF_INDEX_KEY = 'nextAvailableLeafIndex';

/**
 * Collects the MessagePack type marker written after every occurrence of a map key, so that a test can assert on the
 * wire type of a field rather than on the value a decoder happens to reconstruct from it.
 */
function markersAfterKey(buffer: Buffer, key: string): number[] {
  const keyBytes = Buffer.from(key, 'utf8');
  const markers: number[] = [];
  for (let at = buffer.indexOf(keyBytes); at !== -1; at = buffer.indexOf(keyBytes, at + 1)) {
    markers.push(buffer[at + keyBytes.length]);
  }
  return markers;
}

function treeSnapshotsAt(index: number): TreeSnapshots {
  const snapshot = () => new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index));
  return new TreeSnapshots(snapshot(), snapshot(), snapshot(), snapshot());
}

describe('AVM MessagePack serialization', () => {
  // bb-avm reads nextAvailableLeafIndex into a uint64_t, and msgpack-c rejects a float for an unsigned target. The
  // trees are 42 levels deep, so the index outgrows the uint32 range msgpackr uses for plain JS numbers.
  describe('AppendOnlyTreeSnapshot.nextAvailableLeafIndex', () => {
    it.each([0, 1, 0xffffffff, 2 ** 32, 2 ** 42, Number.MAX_SAFE_INTEGER])(
      'encodes index %s as an integer, not a float',
      index => {
        const buffer = serializeWithMessagePack(new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)));

        expect(markersAfterKey(buffer, LEAF_INDEX_KEY)).not.toContain(FLOAT64_MARKER);
        expect(deserializeFromMessagePack(buffer).nextAvailableLeafIndex).toEqual(BigInt(index));
      },
    );

    it('encodes every snapshot in the proving and verifying payloads as an integer', () => {
      const hints = AvmExecutionHints.empty();
      hints.startingTreeRoots = treeSnapshotsAt(2 ** 32);
      const publicInputs = AvmCircuitPublicInputs.empty();
      publicInputs.startTreeSnapshots = treeSnapshotsAt(2 ** 32);
      publicInputs.endTreeSnapshots = treeSnapshotsAt(2 ** 32 + 64);

      const provingMarkers = markersAfterKey(
        new AvmCircuitInputs(hints, publicInputs).serializeWithMessagePack(),
        LEAF_INDEX_KEY,
      );
      const verifyingMarkers = markersAfterKey(publicInputs.serializeWithMessagePack(), LEAF_INDEX_KEY);

      expect(provingMarkers).toHaveLength(12);
      expect(provingMarkers).not.toContain(FLOAT64_MARKER);
      expect(verifyingMarkers).toHaveLength(8);
      expect(verifyingMarkers).not.toContain(FLOAT64_MARKER);
    });
  });
});
