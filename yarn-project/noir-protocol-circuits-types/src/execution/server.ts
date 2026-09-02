import type { InputValue } from '@aztec-foundation/noir-noirc_abi';
import type { InputMap } from '@aztec-foundation/noir-types';

import { INBOX_PARITY_SIZE_LARGE, INBOX_PARITY_SIZE_MEDIUM, INBOX_PARITY_SIZE_SMALL } from '@aztec-labs/constants';
import { pushTestData } from '@aztec-labs/foundation/testing';
import type { InboxParityPrivateInputs, ParityPublicInputs } from '@aztec-labs/stdlib/parity';
import type {
  BlockMergeRollupPrivateInputs,
  BlockRollupPublicInputs,
  BlockRootNoTxsRollupPrivateInputs,
  BlockRootRollupPrivateInputs,
  BlockRootSingleTxRollupPrivateInputs,
  CheckpointMergeRollupPrivateInputs,
  CheckpointPaddingRollupPrivateInputs,
  CheckpointRollupPublicInputs,
  CheckpointRootRollupPrivateInputs,
  CheckpointRootSingleBlockRollupPrivateInputs,
  PrivateTxBaseRollupPrivateInputs,
  PublicChonkVerifierPrivateInputs,
  PublicChonkVerifierPublicInputs,
  PublicTxBaseRollupPrivateInputs,
  RootRollupPrivateInputs,
  RootRollupPublicInputs,
  TxMergeRollupPrivateInputs,
  TxRollupPublicInputs,
} from '@aztec-labs/stdlib/rollup';

import { type ServerProtocolArtifact, mapProtocolArtifactNameToCircuitName } from '../artifacts/types.js';
import {
  mapBlockMergeRollupPrivateInputsToNoir,
  mapBlockRollupPublicInputsFromNoir,
  mapBlockRootNoTxsRollupPrivateInputsToNoir,
  mapBlockRootRollupPrivateInputsToNoir,
  mapBlockRootSingleTxRollupPrivateInputsToNoir,
  mapCheckpointMergeRollupPrivateInputsToNoir,
  mapCheckpointRollupPublicInputsFromNoir,
  mapCheckpointRootRollupPrivateInputsToNoir,
  mapCheckpointRootSingleBlockRollupPrivateInputsToNoir,
  mapInboxParityPrivateInputsToNoir,
  mapParityPublicInputsFromNoir,
  mapPrivateTxBaseRollupPrivateInputsToNoir,
  mapPublicChonkVerifierPrivateInputsToNoir,
  mapPublicChonkVerifierPublicInputsFromNoir,
  mapPublicTxBaseRollupPrivateInputsToNoir,
  mapRootRollupPrivateInputsToNoir,
  mapRootRollupPublicInputsFromNoir,
  mapTxMergeRollupPrivateInputsToNoir,
  mapTxRollupPublicInputsFromNoir,
} from '../conversion/server.js';
import type {
  ChonkVerifierPublicReturnType,
  InboxParity64ReturnType,
  RollupBlockMergeReturnType,
  RollupBlockRootNoTxsReturnType,
  RollupBlockRootReturnType,
  RollupBlockRootSingleTxReturnType,
  RollupCheckpointMergeReturnType,
  RollupCheckpointRootReturnType,
  RollupCheckpointRootSingleBlockReturnType,
  RollupRootReturnType,
  RollupTxBasePrivateReturnType,
  RollupTxBasePublicReturnType,
  RollupTxMergeReturnType,
} from '../types/index.js';

export { mapAvmCircuitPublicInputsToNoir } from '../conversion/server.js';

/**
 * Converts the inputs of the inbox parity circuit into an ABI input map.
 * @param inputs - The inbox parity inputs.
 * @returns The ABI input map
 */
export function convertInboxParityPrivateInputsToNoir(inputs: InboxParityPrivateInputs): InputMap {
  return convertPrivateInputsToNoir(inboxParityArtifactForSize(inputs.size), mapInboxParityPrivateInputsToNoir(inputs));
}

/** Maps an InboxParity ladder size to its server artifact. */
export function inboxParityArtifactForSize(size: number): ServerProtocolArtifact {
  switch (size) {
    case INBOX_PARITY_SIZE_SMALL:
      return 'InboxParity64Artifact';
    case INBOX_PARITY_SIZE_MEDIUM:
      return 'InboxParity256Artifact';
    case INBOX_PARITY_SIZE_LARGE:
      return 'InboxParity1024Artifact';
    default:
      throw new Error(`No InboxParity artifact for size ${size}`);
  }
}

export function convertPublicChonkVerifierPrivateInputsToNoir(inputs: PublicChonkVerifierPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('PublicChonkVerifier', mapPublicChonkVerifierPrivateInputsToNoir(inputs));
}

export function convertPrivateTxBaseRollupPrivateInputsToNoir(inputs: PrivateTxBaseRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('PrivateTxBaseRollupArtifact', mapPrivateTxBaseRollupPrivateInputsToNoir(inputs));
}

export function convertPublicTxBaseRollupPrivateInputsToNoir(inputs: PublicTxBaseRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('PublicTxBaseRollupArtifact', mapPublicTxBaseRollupPrivateInputsToNoir(inputs));
}

/**
 * Converts the inputs of the merge rollup circuit into an ABI input map.
 * @param inputs - The merge rollup inputs.
 * @returns The ABI input map
 */
export function convertTxMergeRollupPrivateInputsToNoir(inputs: TxMergeRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('TxMergeRollupArtifact', mapTxMergeRollupPrivateInputsToNoir(inputs));
}

export function convertBlockRootRollupPrivateInputsToNoir(inputs: BlockRootRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('BlockRootRollupArtifact', mapBlockRootRollupPrivateInputsToNoir(inputs));
}

export function convertBlockRootSingleTxRollupPrivateInputsToNoir(
  inputs: BlockRootSingleTxRollupPrivateInputs,
): InputMap {
  return convertPrivateInputsToNoir(
    'BlockRootSingleTxRollupArtifact',
    mapBlockRootSingleTxRollupPrivateInputsToNoir(inputs),
  );
}

export function convertBlockRootNoTxsRollupPrivateInputsToNoir(inputs: BlockRootNoTxsRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('BlockRootNoTxsRollupArtifact', mapBlockRootNoTxsRollupPrivateInputsToNoir(inputs));
}

export function convertBlockMergeRollupPrivateInputsToNoir(inputs: BlockMergeRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('BlockMergeRollupArtifact', mapBlockMergeRollupPrivateInputsToNoir(inputs));
}

export function convertCheckpointRootRollupPrivateInputsToNoir(inputs: CheckpointRootRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('CheckpointRootRollupArtifact', mapCheckpointRootRollupPrivateInputsToNoir(inputs));
}

export function convertCheckpointRootSingleBlockRollupPrivateInputsToNoir(
  inputs: CheckpointRootSingleBlockRollupPrivateInputs,
): InputMap {
  return convertPrivateInputsToNoir(
    'CheckpointRootSingleBlockRollupArtifact',
    mapCheckpointRootSingleBlockRollupPrivateInputsToNoir(inputs),
  );
}

export function convertCheckpointPaddingRollupPrivateInputsToNoir(
  _inputs: CheckpointPaddingRollupPrivateInputs,
): InputMap {
  // Checkpoint padding takes no private inputs, but its ABI still declares the `inputs` parameter
  // every protocol circuit has — as an empty struct. Omitting the key fails ABI decoding outright.
  return { inputs: {} };
}

export function convertCheckpointMergeRollupPrivateInputsToNoir(inputs: CheckpointMergeRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir(
    'CheckpointMergeRollupArtifact',
    mapCheckpointMergeRollupPrivateInputsToNoir(inputs),
  );
}

/**
 * Converts the inputs of the root rollup circuit into an ABI input map.
 * @param inputs - The root rollup inputs.
 * @returns The ABI input map
 */
export function convertRootRollupPrivateInputsToNoir(inputs: RootRollupPrivateInputs): InputMap {
  return convertPrivateInputsToNoir('RootRollupArtifact', mapRootRollupPrivateInputsToNoir(inputs));
}

export function convertPublicChonkVerifierOutputsFromNoir(
  publicInputs: ChonkVerifierPublicReturnType,
): PublicChonkVerifierPublicInputs {
  return mapPublicChonkVerifierPublicInputsFromNoir(publicInputs);
}

export function convertPrivateTxBaseRollupOutputsFromNoir(
  publicInputs: RollupTxBasePrivateReturnType,
): TxRollupPublicInputs {
  return mapTxRollupPublicInputsFromNoir(publicInputs);
}

export function convertPublicTxBaseRollupOutputsFromNoir(
  publicInputs: RollupTxBasePublicReturnType,
): TxRollupPublicInputs {
  return mapTxRollupPublicInputsFromNoir(publicInputs);
}

export function convertTxMergeRollupOutputsFromNoir(publicInputs: RollupTxMergeReturnType): TxRollupPublicInputs {
  return mapTxRollupPublicInputsFromNoir(publicInputs);
}

export function convertBlockRootRollupOutputsFromNoir(
  publicInputs: RollupBlockRootReturnType,
): BlockRollupPublicInputs {
  return mapBlockRollupPublicInputsFromNoir(publicInputs);
}

export function convertBlockRootSingleTxRollupOutputsFromNoir(
  publicInputs: RollupBlockRootSingleTxReturnType,
): BlockRollupPublicInputs {
  return mapBlockRollupPublicInputsFromNoir(publicInputs);
}

export function convertBlockRootNoTxsRollupOutputsFromNoir(
  publicInputs: RollupBlockRootNoTxsReturnType,
): BlockRollupPublicInputs {
  return mapBlockRollupPublicInputsFromNoir(publicInputs);
}

export function convertBlockMergeRollupOutputsFromNoir(
  publicInputs: RollupBlockMergeReturnType,
): BlockRollupPublicInputs {
  return mapBlockRollupPublicInputsFromNoir(publicInputs);
}

export function convertCheckpointRootRollupOutputsFromNoir(
  publicInputs: RollupCheckpointRootReturnType,
): CheckpointRollupPublicInputs {
  return mapCheckpointRollupPublicInputsFromNoir(publicInputs);
}

export function convertCheckpointRootSingleBlockRollupOutputsFromNoir(
  publicInputs: RollupCheckpointRootSingleBlockReturnType,
): CheckpointRollupPublicInputs {
  return mapCheckpointRollupPublicInputsFromNoir(publicInputs);
}

export function convertCheckpointPaddingRollupOutputsFromNoir(
  publicInputs: RollupCheckpointRootReturnType,
): CheckpointRollupPublicInputs {
  return mapCheckpointRollupPublicInputsFromNoir(publicInputs);
}

export function convertCheckpointMergeRollupOutputsFromNoir(
  publicInputs: RollupCheckpointMergeReturnType,
): CheckpointRollupPublicInputs {
  return mapCheckpointRollupPublicInputsFromNoir(publicInputs);
}

/**
 * Converts the return value of the root rollup circuit into public inputs.
 * @param publicInputs - The circuit's decoded return value.
 * @returns The public inputs.
 */
export function convertRootRollupOutputsFromNoir(publicInputs: RollupRootReturnType): RootRollupPublicInputs {
  return mapRootRollupPublicInputsFromNoir(publicInputs);
}

/**
 * Converts the return value of the inbox parity circuit into public inputs.
 * @param publicInputs - The circuit's decoded return value. Every ladder size shares the same
 * `ParityPublicInputs` return ABI, so this is identical across sizes.
 * @returns The public inputs.
 */
export function convertInboxParityOutputsFromNoir(publicInputs: InboxParity64ReturnType): ParityPublicInputs {
  return mapParityPublicInputsFromNoir(publicInputs);
}

/**
 * Wraps a circuit's mapped inputs as an ABI input map, keyed by the single `inputs` parameter every
 * protocol circuit takes. The simulator encodes this against the ABI if its backend needs a witness
 * map; the native one writes it out as a prover file instead.
 */
function convertPrivateInputsToNoir<InputsType extends InputValue>(
  artifactName: ServerProtocolArtifact,
  inputs: InputsType,
): InputMap {
  pushTestData(mapProtocolArtifactNameToCircuitName(artifactName), { inputs });
  return { inputs };
}
