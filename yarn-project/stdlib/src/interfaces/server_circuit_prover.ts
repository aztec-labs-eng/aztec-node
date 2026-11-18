import type {
  AVM_V2_PROOF_LENGTH_IN_FIELDS,
  NESTED_RECURSIVE_PROOF_LENGTH,
  NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
  RECURSIVE_PROOF_LENGTH,
} from '@aztec-labs/constants';
import type { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';

import type { AvmCircuitInputs } from '../avm/avm.js';
import type { InboxParityPrivateInputs } from '../parity/inbox_parity_private_inputs.js';
import type { ParityPublicInputs } from '../parity/parity_public_inputs.js';
import type { RecursiveProof } from '../proofs/recursive_proof.js';
import type { BlockMergeRollupPrivateInputs } from '../rollup/block_merge_rollup_private_inputs.js';
import type { BlockRollupPublicInputs } from '../rollup/block_rollup_public_inputs.js';
import type {
  BlockRootNoTxsRollupPrivateInputs,
  BlockRootRollupPrivateInputs,
  BlockRootSingleTxRollupPrivateInputs,
} from '../rollup/block_root_rollup_private_inputs.js';
import type { CheckpointMergeRollupPrivateInputs } from '../rollup/checkpoint_merge_rollup_private_inputs.js';
import type { CheckpointRollupPublicInputs } from '../rollup/checkpoint_rollup_public_inputs.js';
import type {
  CheckpointPaddingRollupPrivateInputs,
  CheckpointRootRollupPrivateInputs,
  CheckpointRootSingleBlockRollupPrivateInputs,
} from '../rollup/checkpoint_root_rollup_private_inputs.js';
import type { PrivateTxBaseRollupPrivateInputs } from '../rollup/private_tx_base_rollup_private_inputs.js';
import type { PublicChonkVerifierPrivateInputs } from '../rollup/public_chonk_verifier_private_inputs.js';
import type { PublicChonkVerifierPublicInputs } from '../rollup/public_chonk_verifier_public_inputs.js';
import type { PublicTxBaseRollupPrivateInputs } from '../rollup/public_tx_base_rollup_private_inputs.js';
import type { RootRollupPrivateInputs } from '../rollup/root_rollup_private_inputs.js';
import type { RootRollupPublicInputs } from '../rollup/root_rollup_public_inputs.js';
import type { TxMergeRollupPrivateInputs } from '../rollup/tx_merge_rollup_private_inputs.js';
import type { TxRollupPublicInputs } from '../rollup/tx_rollup_public_inputs.js';
import type { Tx } from '../tx/tx.js';
import type { PublicInputsAndRecursiveProof } from './proving-job.js';

/**
 * Generates proofs for parity and rollup circuits.
 *
 * Every method takes the same optional arguments after its inputs: `signal` aborts the request, `epochNumber` is
 * the epoch the proof belongs to, and `prioritySlot` is the slot the proving broker orders the job by, see
 * `ProvingJob.prioritySlot`.
 */
export interface ServerCircuitProver {
  /**
   * Creates the checkpoint's single InboxParity proof. The circuit variant (ladder size) is selected from
   * `inputs.size`.
   * @param inputs - Input to the circuit.
   */
  getInboxParityProof(
    inputs: InboxParityPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>>;

  /** Verifies the chonk proof of a public transaction, so that its base rollup can take a recursive proof. */
  getPublicChonkVerifierProof(
    inputs: PublicChonkVerifierPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<
    PublicInputsAndRecursiveProof<PublicChonkVerifierPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  >;

  /**
   * Creates a proof for the given input.
   * @param input - Input to the circuit.
   */
  getPrivateTxBaseRollupProof(
    baseRollupInput: PrivateTxBaseRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /** Creates the base rollup proof of a transaction with public calls. */
  getPublicTxBaseRollupProof(
    inputs: PublicTxBaseRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /**
   * Creates a proof for the given input.
   * @param input - Input to the circuit.
   */
  getTxMergeRollupProof(
    input: TxMergeRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /**
   * Creates a proof for the given input.
   * @param input - Input to the circuit.
   */
  getBlockRootRollupProof(
    input: BlockRootRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /** Creates the root rollup proof of a block with one transaction. */
  getBlockRootSingleTxRollupProof(
    input: BlockRootSingleTxRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /** Creates the root rollup proof of a block with no transactions. */
  getBlockRootNoTxsRollupProof(
    input: BlockRootNoTxsRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /**
   * Creates a proof for the given input.
   * @param input - Input to the circuit.
   */
  getBlockMergeRollupProof(
    input: BlockMergeRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>>;

  /** Creates the root rollup proof of a checkpoint with several blocks. */
  getCheckpointRootRollupProof(
    input: CheckpointRootRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  >;

  /** Creates the root rollup proof of a checkpoint with one block. */
  getCheckpointRootSingleBlockRollupProof(
    input: CheckpointRootSingleBlockRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  >;

  /** Creates the padding proof that fills the second input of the root rollup when an epoch has one checkpoint. */
  getCheckpointPaddingRollupProof(
    input: CheckpointPaddingRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  >;

  /** Merges two checkpoint rollup proofs into one. */
  getCheckpointMergeRollupProof(
    input: CheckpointMergeRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  >;

  /**
   * Creates a proof for the given input.
   * @param input - Input to the circuit.
   */
  getRootRollupProof(
    input: RootRollupPrivateInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<PublicInputsAndRecursiveProof<RootRollupPublicInputs, typeof NESTED_RECURSIVE_PROOF_LENGTH>>;

  /**
   * Create a proof for the AVM circuit.
   * @param inputs - Inputs to the AVM circuit.
   */
  getAvmProof(
    inputs: AvmCircuitInputs,
    signal?: AbortSignal,
    epochNumber?: EpochNumber,
    prioritySlot?: SlotNumber,
  ): Promise<RecursiveProof<typeof AVM_V2_PROOF_LENGTH_IN_FIELDS>>;
}

export type IVCProofVerificationResult = {
  // The result of verification
  valid: boolean;
  // The duration of the verification in milliseconds
  durationMs: number;
  // The total duration, including proof serialisation and file-system cleanup
  totalDurationMs: number;
};

/**
 * A verifier used by nodes to check tx proofs are valid.
 */
export interface ClientProtocolCircuitVerifier {
  /**
   * Verifies the private protocol circuit's proof. Rejects, instead of reporting the proof invalid, when the proof
   * could not be checked (for example, when the proving backend is unavailable).
   * @param tx - The tx to verify the proof of
   * @returns Whether the proof is valid, with verification timings
   */
  verifyProof(tx: Tx): Promise<IVCProofVerificationResult>;

  /**
   * Stop the verifier.
   */
  stop(): Promise<void>;
}
