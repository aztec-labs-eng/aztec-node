import type { InputMap } from '@aztec-foundation/noir-types';

import {
  AVM_V2_PROOF_LENGTH_IN_FIELDS,
  NESTED_RECURSIVE_PROOF_LENGTH,
  NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
  RECURSIVE_PROOF_LENGTH,
} from '@aztec-labs/constants';
import { createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import { Timer } from '@aztec-labs/foundation/timer';
import {
  type ServerProtocolArtifact,
  convertBlockMergeRollupOutputsFromNoir,
  convertBlockMergeRollupPrivateInputsToNoir,
  convertBlockRootNoTxsRollupOutputsFromNoir,
  convertBlockRootNoTxsRollupPrivateInputsToNoir,
  convertBlockRootRollupOutputsFromNoir,
  convertBlockRootRollupPrivateInputsToNoir,
  convertBlockRootSingleTxRollupOutputsFromNoir,
  convertBlockRootSingleTxRollupPrivateInputsToNoir,
  convertCheckpointMergeRollupOutputsFromNoir,
  convertCheckpointMergeRollupPrivateInputsToNoir,
  convertCheckpointPaddingRollupOutputsFromNoir,
  convertCheckpointPaddingRollupPrivateInputsToNoir,
  convertCheckpointRootRollupOutputsFromNoir,
  convertCheckpointRootRollupPrivateInputsToNoir,
  convertCheckpointRootSingleBlockRollupOutputsFromNoir,
  convertCheckpointRootSingleBlockRollupPrivateInputsToNoir,
  convertInboxParityOutputsFromNoir,
  convertInboxParityPrivateInputsToNoir,
  convertPrivateTxBaseRollupOutputsFromNoir,
  convertPrivateTxBaseRollupPrivateInputsToNoir,
  convertPublicTxBaseRollupOutputsFromNoir,
  convertPublicTxBaseRollupPrivateInputsToNoir,
  convertRootRollupOutputsFromNoir,
  convertRootRollupPrivateInputsToNoir,
  convertTxMergeRollupOutputsFromNoir,
  convertTxMergeRollupPrivateInputsToNoir,
  foreignCallHandler,
  getSimulatedServerCircuitArtifact,
  inboxParityArtifactForSize,
} from '@aztec-labs/noir-protocol-circuits-types/server';
import { ProtocolCircuitVks } from '@aztec-labs/noir-protocol-circuits-types/server/vks';
import { mapProtocolArtifactNameToCircuitName } from '@aztec-labs/noir-protocol-circuits-types/types';
import {
  type CircuitSimulator,
  WASMSimulatorWithBlobs,
  emitCircuitSimulationStats,
} from '@aztec-labs/simulator/server';
import type { AvmCircuitInputs } from '@aztec-labs/stdlib/avm';
import {
  type PublicInputsAndRecursiveProof,
  type ServerCircuitProver,
  makePublicInputsAndRecursiveProof,
} from '@aztec-labs/stdlib/interfaces/server';
import type { InboxParityPrivateInputs, ParityPublicInputs } from '@aztec-labs/stdlib/parity';
import {
  type Proof,
  ProvingRequestType,
  RecursiveProof,
  makeEmptyRecursiveProof,
  makeRecursiveProof,
} from '@aztec-labs/stdlib/proofs';
import {
  type BlockMergeRollupPrivateInputs,
  type BlockRollupPublicInputs,
  type BlockRootNoTxsRollupPrivateInputs,
  type BlockRootRollupPrivateInputs,
  type BlockRootSingleTxRollupPrivateInputs,
  type CheckpointMergeRollupPrivateInputs,
  type CheckpointPaddingRollupPrivateInputs,
  type CheckpointRollupPublicInputs,
  type CheckpointRootRollupPrivateInputs,
  type CheckpointRootSingleBlockRollupPrivateInputs,
  type PrivateTxBaseRollupPrivateInputs,
  type PublicChonkVerifierPrivateInputs,
  PublicChonkVerifierPublicInputs,
  type PublicTxBaseRollupPrivateInputs,
  type RootRollupPrivateInputs,
  type RootRollupPublicInputs,
  type TxMergeRollupPrivateInputs,
  type TxRollupPublicInputs,
} from '@aztec-labs/stdlib/rollup';
import { type TelemetryClient, getTelemetryClient, trackSpan } from '@aztec-labs/telemetry-client';

import { ProverInstrumentation } from '../instrumentation.js';
import { PROOF_DELAY_MS, WITGEN_DELAY_MS } from './delay_values.js';

type TestDelay =
  | {
      proverTestDelayType: 'fixed';
      proverTestDelayMs?: number;
    }
  | {
      proverTestDelayType: 'realistic';
      proverTestDelayFactor?: number;
    };

/**
 * A class for use in testing situations (e2e, unit test, etc) and temporarily for assembling a block in the sequencer.
 * Simulates circuits using the most efficient method and performs no proving.
 */
export class TestCircuitProver implements ServerCircuitProver {
  private wasmSimulator = new WASMSimulatorWithBlobs();
  private instrumentation: ProverInstrumentation;
  private logger = createLogger('bb-prover:test-prover');

  constructor(
    private simulator?: CircuitSimulator,
    private opts: TestDelay = { proverTestDelayType: 'fixed', proverTestDelayMs: 0 },
    telemetry: TelemetryClient = getTelemetryClient(),
  ) {
    this.instrumentation = new ProverInstrumentation(telemetry, 'TestCircuitProver');
  }

  get tracer() {
    return this.instrumentation.tracer;
  }

  /**
   * Simulates the base parity circuit from its inputs.
   * @param inputs - Inputs to the circuit.
   * @returns The public inputs of the parity circuit.
   */
  @trackSpan('TestCircuitProver.getInboxParityProof')
  public getInboxParityProof(
    inputs: InboxParityPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<ParityPublicInputs, typeof RECURSIVE_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.INBOX_PARITY, () =>
      this.simulate(
        inputs,
        inboxParityArtifactForSize(inputs.size),
        RECURSIVE_PROOF_LENGTH,
        convertInboxParityPrivateInputsToNoir,
        convertInboxParityOutputsFromNoir,
      ),
    );
  }

  public getPublicChonkVerifierProof(
    inputs: PublicChonkVerifierPrivateInputs,
  ): Promise<
    PublicInputsAndRecursiveProof<PublicChonkVerifierPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  > {
    return this.applyDelay(ProvingRequestType.PUBLIC_CHONK_VERIFIER, () =>
      makePublicInputsAndRecursiveProof(
        new PublicChonkVerifierPublicInputs(inputs.hidingKernelProofData.publicInputs, inputs.proverId),
        makeEmptyRecursiveProof(NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH),
        ProtocolCircuitVks.PublicChonkVerifier,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getPrivateTxBaseRollupProof')
  public getPrivateTxBaseRollupProof(
    inputs: PrivateTxBaseRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.PRIVATE_TX_BASE_ROLLUP, () =>
      this.simulate(
        inputs,
        'PrivateTxBaseRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertPrivateTxBaseRollupPrivateInputsToNoir,
        convertPrivateTxBaseRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getPublicTxBaseRollupProof')
  public getPublicTxBaseRollupProof(
    inputs: PublicTxBaseRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.PUBLIC_TX_BASE_ROLLUP, () =>
      this.simulate(
        inputs,
        'PublicTxBaseRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertPublicTxBaseRollupPrivateInputsToNoir,
        convertPublicTxBaseRollupOutputsFromNoir,
      ),
    );
  }

  /**
   * Simulates the merge rollup circuit from its inputs.
   * @param input - Inputs to the circuit.
   * @returns The public inputs as outputs of the simulation.
   */
  @trackSpan('TestCircuitProver.getTxMergeRollupProof')
  public getTxMergeRollupProof(
    input: TxMergeRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<TxRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.TX_MERGE_ROLLUP, () =>
      this.simulate(
        input,
        'TxMergeRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertTxMergeRollupPrivateInputsToNoir,
        convertTxMergeRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getBlockRootNoTxsRollupProof')
  public getBlockRootNoTxsRollupProof(
    input: BlockRootNoTxsRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.BLOCK_ROOT_NO_TXS_ROLLUP, () =>
      this.simulate(
        input,
        'BlockRootNoTxsRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertBlockRootNoTxsRollupPrivateInputsToNoir,
        convertBlockRootNoTxsRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getBlockRootRollupProof')
  public getBlockRootRollupProof(
    input: BlockRootRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.BLOCK_ROOT_ROLLUP, () =>
      this.simulate(
        input,
        'BlockRootRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertBlockRootRollupPrivateInputsToNoir,
        convertBlockRootRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getBlockRootSingleTxRollupProof')
  public async getBlockRootSingleTxRollupProof(
    input: BlockRootSingleTxRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return await this.applyDelay(ProvingRequestType.BLOCK_ROOT_SINGLE_TX_ROLLUP, () =>
      this.simulate(
        input,
        'BlockRootSingleTxRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertBlockRootSingleTxRollupPrivateInputsToNoir,
        convertBlockRootSingleTxRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getBlockMergeRollupProof')
  public getBlockMergeRollupProof(
    input: BlockMergeRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<BlockRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>> {
    return this.applyDelay(ProvingRequestType.BLOCK_MERGE_ROLLUP, () =>
      this.simulate(
        input,
        'BlockMergeRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertBlockMergeRollupPrivateInputsToNoir,
        convertBlockMergeRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getCheckpointRootRollupProof')
  public getCheckpointRootRollupProof(
    input: CheckpointRootRollupPrivateInputs,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  > {
    return this.applyDelay(ProvingRequestType.CHECKPOINT_ROOT_ROLLUP, () =>
      this.simulate(
        input,
        'CheckpointRootRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertCheckpointRootRollupPrivateInputsToNoir,
        convertCheckpointRootRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getCheckpointRootSingleBlockRollupProof')
  public getCheckpointRootSingleBlockRollupProof(
    input: CheckpointRootSingleBlockRollupPrivateInputs,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  > {
    return this.applyDelay(ProvingRequestType.CHECKPOINT_ROOT_SINGLE_BLOCK_ROLLUP, () =>
      this.simulate(
        input,
        'CheckpointRootSingleBlockRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertCheckpointRootSingleBlockRollupPrivateInputsToNoir,
        convertCheckpointRootSingleBlockRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getCheckpointPaddingRollupProof')
  public getCheckpointPaddingRollupProof(
    input: CheckpointPaddingRollupPrivateInputs,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  > {
    return this.applyDelay(ProvingRequestType.CHECKPOINT_PADDING_ROLLUP, () =>
      this.simulate(
        input,
        'CheckpointPaddingRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertCheckpointPaddingRollupPrivateInputsToNoir,
        convertCheckpointPaddingRollupOutputsFromNoir,
      ),
    );
  }

  @trackSpan('TestCircuitProver.getCheckpointMergeRollupProof')
  public getCheckpointMergeRollupProof(
    input: CheckpointMergeRollupPrivateInputs,
  ): Promise<
    PublicInputsAndRecursiveProof<CheckpointRollupPublicInputs, typeof NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH>
  > {
    return this.applyDelay(ProvingRequestType.CHECKPOINT_MERGE_ROLLUP, () =>
      this.simulate(
        input,
        'CheckpointMergeRollupArtifact',
        NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
        convertCheckpointMergeRollupPrivateInputsToNoir,
        convertCheckpointMergeRollupOutputsFromNoir,
      ),
    );
  }

  /**
   * Simulates the root rollup circuit from its inputs.
   * @param input - Inputs to the circuit.
   * @returns The public inputs as outputs of the simulation.
   */
  @trackSpan('TestCircuitProver.getRootRollupProof')
  public getRootRollupProof(
    input: RootRollupPrivateInputs,
  ): Promise<PublicInputsAndRecursiveProof<RootRollupPublicInputs>> {
    return this.applyDelay(ProvingRequestType.ROOT_ROLLUP, () =>
      this.simulate(
        input,
        'RootRollupArtifact',
        NESTED_RECURSIVE_PROOF_LENGTH,
        convertRootRollupPrivateInputsToNoir,
        convertRootRollupOutputsFromNoir,
      ),
    );
  }

  public getAvmProof(_inputs: AvmCircuitInputs): Promise<RecursiveProof<typeof AVM_V2_PROOF_LENGTH_IN_FIELDS>> {
    // We can't simulate the AVM because we don't have enough context to do so (e.g., DBs).
    // We just return an empty proof.
    this.logger.debug('Skipping AVM simulation in TestCircuitProver.');
    return this.applyDelay(ProvingRequestType.PUBLIC_VM, () => makeEmptyRecursiveProof(AVM_V2_PROOF_LENGTH_IN_FIELDS));
  }

  private async applyDelay<F extends () => any>(type: ProvingRequestType, fn: F): Promise<Awaited<ReturnType<F>>> {
    const timer = new Timer();
    const res = await fn();
    const duration = timer.ms();
    if (this.opts.proverTestDelayType === 'fixed') {
      await sleep(Math.max(0, (this.opts.proverTestDelayMs ?? 0) - duration));
    } else if (this.opts.proverTestDelayType === 'realistic') {
      const delay = WITGEN_DELAY_MS[type] + PROOF_DELAY_MS[type];
      await sleep(Math.max(0, delay * (this.opts.proverTestDelayFactor ?? 1) - duration));
    }

    return res;
  }

  // Not implemented for test circuits
  public verifyProof(_1: ServerProtocolArtifact, _2: Proof): Promise<void> {
    return Promise.reject(new Error('Method not implemented.'));
  }

  private async simulate<
    PROOF_LENGTH extends number,
    CircuitInputType extends { toBuffer: () => Buffer },
    CircuitOutputType extends { toBuffer: () => Buffer },
    CircuitReturnType,
  >(
    input: CircuitInputType,
    artifactName: ServerProtocolArtifact,
    proofLength: PROOF_LENGTH,
    convertInput: (input: CircuitInputType) => InputMap,
    convertOutput: (returnValue: CircuitReturnType) => CircuitOutputType,
  ) {
    const timer = new Timer();
    const inputs = convertInput(input);
    const circuitName = mapProtocolArtifactNameToCircuitName(artifactName);
    const artifact = getSimulatedServerCircuitArtifact(artifactName);

    let returnValue: CircuitReturnType;
    if (
      ['CheckpointRootRollupArtifact', 'CheckpointRootSingleBlockRollupArtifact'].includes(artifactName) ||
      this.simulator == undefined
    ) {
      // TODO(#10323): Native ACVM simulator does not support foreign call handler so we use the wasm simulator
      // when simulating checkpoint root rollup circuits or when the native ACVM simulator is not provided.
      returnValue = (
        await this.wasmSimulator.executeProtocolCircuit<CircuitReturnType>(inputs, artifact, foreignCallHandler)
      ).returnValue;
    } else {
      returnValue = (
        await this.simulator.executeProtocolCircuit<CircuitReturnType>(
          inputs,
          artifact,
          undefined, // Native ACM simulator does not support foreign call handler
        )
      ).returnValue;
    }

    const result = convertOutput(returnValue);

    this.instrumentation.recordDuration('simulationDuration', circuitName, timer);
    emitCircuitSimulationStats(circuitName, timer.ms(), input.toBuffer().length, result.toBuffer().length, this.logger);
    return makePublicInputsAndRecursiveProof(result, makeRecursiveProof(proofLength), ProtocolCircuitVks[artifactName]);
  }
}
