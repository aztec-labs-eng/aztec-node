import { InMemoryFileStore } from '@aztec-labs/stdlib/file-store';
import type { ProvingJobId } from '@aztec-labs/stdlib/interfaces/server';
import { ProvingRequestType } from '@aztec-labs/stdlib/proofs';
import type { TxMergeRollupPrivateInputs } from '@aztec-labs/stdlib/rollup';
import { makeTxMergeRollupPrivateInputs } from '@aztec-labs/stdlib/testing';

import { FileStoreProofStore } from './file_store_proof_store.js';
import { InlineProofStore } from './inline_proof_store.js';
import type { ProofStore } from './proof_store.js';

describe('proof stores', () => {
  const jobId = 'high-leaf-index-job' as ProvingJobId;

  const makeInputsWithLeafIndex = (index: number): TxMergeRollupPrivateInputs => {
    const inputs = makeTxMergeRollupPrivateInputs();
    for (const rollup of inputs.previousRollups) {
      rollup.publicInputs.startTreeSnapshots.noteHashTree.nextAvailableLeafIndex = index;
      rollup.publicInputs.endTreeSnapshots.noteHashTree.nextAvailableLeafIndex = index;
    }
    return inputs;
  };

  const stores: [string, () => ProofStore][] = [
    ['InlineProofStore', () => new InlineProofStore()],
    ['FileStoreProofStore', () => new FileStoreProofStore(new InMemoryFileStore('proof-store-test'))],
  ];

  describe.each(stores)('%s', (_name, makeStore) => {
    it.each([2 ** 32, 2 ** 42])('preserves a tree leaf index of %p', async index => {
      const store = makeStore();
      const inputs = makeInputsWithLeafIndex(index);

      const uri = await store.saveProofInput(jobId, ProvingRequestType.TX_MERGE_ROLLUP, inputs);
      const recovered = await store.getProofInput(uri);

      expect(recovered.type).toBe(ProvingRequestType.TX_MERGE_ROLLUP);
      expect(recovered.inputs).toEqual(inputs);
    });
  });
});
