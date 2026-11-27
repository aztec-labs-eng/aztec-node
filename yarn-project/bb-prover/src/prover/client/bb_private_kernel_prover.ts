import { AztecClientBackend, type BackendOptions, Barretenberg } from '@aztec-foundation/bb.js';
import { serializeWitness } from '@aztec-foundation/noir-noirc_abi';
import type { Abi, WitnessMap } from '@aztec-foundation/noir-types';

import { getEnv } from '@aztec-labs/foundation/config/env';
import { type LogLevel, type Logger, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { Timer } from '@aztec-labs/foundation/timer';
import {
  convertHidingKernelPublicInputsToWitnessMapWithAbi,
  convertHidingKernelToRollupInputsToWitnessMapWithAbi,
  convertPrivateKernelInit2InputsToWitnessMapWithAbi,
  convertPrivateKernelInit2OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInit3InputsToWitnessMapWithAbi,
  convertPrivateKernelInit3OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInit4InputsToWitnessMapWithAbi,
  convertPrivateKernelInit4OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInit5InputsToWitnessMapWithAbi,
  convertPrivateKernelInit5OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInitInputsToWitnessMapWithAbi,
  convertPrivateKernelInitOutputsFromWitnessMapWithAbi,
  convertPrivateKernelInner2InputsToWitnessMapWithAbi,
  convertPrivateKernelInner2OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInner3InputsToWitnessMapWithAbi,
  convertPrivateKernelInner3OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInner4InputsToWitnessMapWithAbi,
  convertPrivateKernelInner4OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInner5InputsToWitnessMapWithAbi,
  convertPrivateKernelInner5OutputsFromWitnessMapWithAbi,
  convertPrivateKernelInnerInputsToWitnessMapWithAbi,
  convertPrivateKernelInnerOutputsFromWitnessMapWithAbi,
  convertPrivateKernelResetInputsToWitnessMapWithAbi,
  convertPrivateKernelResetOutputsFromWitnessMapWithAbi,
  convertPrivateKernelResetTailInputsToWitnessMapWithAbi,
  convertPrivateKernelResetTailToPublicInputsToWitnessMapWithAbi,
  convertPrivateKernelTailForPublicOutputsFromWitnessMapWithAbi,
  convertPrivateKernelTailOutputsFromWitnessMapWithAbi,
  foreignCallHandler,
  getPrivateKernelResetArtifactName,
  getPrivateKernelResetTailArtifactName,
  updateResetCircuitSampleInputs,
} from '@aztec-labs/noir-protocol-circuits-types/client';
import {
  type ArtifactProvider,
  type ClientProtocolArtifact,
  mapProtocolArtifactNameToCircuitName,
} from '@aztec-labs/noir-protocol-circuits-types/types';
import type { CircuitSimulator } from '@aztec-labs/simulator/client';
import type { PrivateKernelProver } from '@aztec-labs/stdlib/interfaces/client';
import type {
  HidingKernelToPublicPrivateInputs,
  HidingKernelToRollupPrivateInputs,
  PrivateExecutionStep,
  PrivateKernelCircuitPublicInputs,
  PrivateKernelInit2CircuitPrivateInputs,
  PrivateKernelInit3CircuitPrivateInputs,
  PrivateKernelInit4CircuitPrivateInputs,
  PrivateKernelInit5CircuitPrivateInputs,
  PrivateKernelInitCircuitPrivateInputs,
  PrivateKernelInner2CircuitPrivateInputs,
  PrivateKernelInner3CircuitPrivateInputs,
  PrivateKernelInner4CircuitPrivateInputs,
  PrivateKernelInner5CircuitPrivateInputs,
  PrivateKernelInnerCircuitPrivateInputs,
  PrivateKernelResetCircuitPrivateInputs,
  PrivateKernelResetTailCircuitPrivateInputs,
  PrivateKernelSimulateOutput,
  PrivateKernelTailCircuitPublicInputs,
} from '@aztec-labs/stdlib/kernel';
import type { NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';
import { ChonkProofWithPublicInputs } from '@aztec-labs/stdlib/proofs';
import type { CircuitSimulationStats, CircuitWitnessGenerationStats } from '@aztec-labs/stdlib/stats';
import { Buffer } from 'buffer';
import { ungzip } from 'pako';

export type BBPrivateKernelProverOptions = Omit<BackendOptions, 'logger'> & { logger?: Logger };
export abstract class BBPrivateKernelProver implements PrivateKernelProver {
  private log: Logger;

  /**
   * The bb this prover accumulates on, created on first use and kept for the life of the prover.
   *
   * Its own rather than the process-wide singleton. Accumulation is a session — chonkStart, a load
   * and an accumulate per circuit, then chonkProve — while the singleton is shared with every
   * protocol hash on a node, so a hash would queue behind a whole proof and two proofs would
   * interleave into one session and corrupt each other. Stateless callers, gate counting included,
   * stay on the singleton where they belong.
   */
  private chonkBb: Barretenberg | undefined;

  /** Serialises accumulation: bb holds one session, so two proofs cannot share a process. */
  private readonly chonkQueue = new SerialQueue();
  private stopPromise?: Promise<void>;

  constructor(
    protected artifactProvider: ArtifactProvider,
    protected simulator: CircuitSimulator,
    protected options: BBPrivateKernelProverOptions = {},
  ) {
    this.log = options.logger || createLogger('bb-prover:private-kernel');
    this.chonkQueue.start();
  }

  /** Drains queued proofs and releases this prover's dedicated bb instance. */
  public stop(): Promise<void> {
    return (this.stopPromise ??= this.stopChonkProver());
  }

  private async stopChonkProver(): Promise<void> {
    await this.chonkQueue.end();
    const bb = this.chonkBb;
    this.chonkBb = undefined;
    await bb?.destroy();
  }

  public async generateInitOutput(
    inputs: PrivateKernelInitCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInitArtifact',
      convertPrivateKernelInitInputsToWitnessMapWithAbi,
      convertPrivateKernelInitOutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInit(
    inputs: PrivateKernelInitCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInitArtifact',
      convertPrivateKernelInitInputsToWitnessMapWithAbi,
      convertPrivateKernelInitOutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInit2Output(
    inputs: PrivateKernelInit2CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInit2Artifact',
      convertPrivateKernelInit2InputsToWitnessMapWithAbi,
      convertPrivateKernelInit2OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInit2(
    inputs: PrivateKernelInit2CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInit2Artifact',
      convertPrivateKernelInit2InputsToWitnessMapWithAbi,
      convertPrivateKernelInit2OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInit3Output(
    inputs: PrivateKernelInit3CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInit3Artifact',
      convertPrivateKernelInit3InputsToWitnessMapWithAbi,
      convertPrivateKernelInit3OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInit3(
    inputs: PrivateKernelInit3CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInit3Artifact',
      convertPrivateKernelInit3InputsToWitnessMapWithAbi,
      convertPrivateKernelInit3OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInit4Output(
    inputs: PrivateKernelInit4CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInit4Artifact',
      convertPrivateKernelInit4InputsToWitnessMapWithAbi,
      convertPrivateKernelInit4OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInit4(
    inputs: PrivateKernelInit4CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInit4Artifact',
      convertPrivateKernelInit4InputsToWitnessMapWithAbi,
      convertPrivateKernelInit4OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInit5Output(
    inputs: PrivateKernelInit5CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInit5Artifact',
      convertPrivateKernelInit5InputsToWitnessMapWithAbi,
      convertPrivateKernelInit5OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInit5(
    inputs: PrivateKernelInit5CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInit5Artifact',
      convertPrivateKernelInit5InputsToWitnessMapWithAbi,
      convertPrivateKernelInit5OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInnerOutput(
    inputs: PrivateKernelInnerCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInnerArtifact',
      convertPrivateKernelInnerInputsToWitnessMapWithAbi,
      convertPrivateKernelInnerOutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInner(
    inputs: PrivateKernelInnerCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInnerArtifact',
      convertPrivateKernelInnerInputsToWitnessMapWithAbi,
      convertPrivateKernelInnerOutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInner2Output(
    inputs: PrivateKernelInner2CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInner2Artifact',
      convertPrivateKernelInner2InputsToWitnessMapWithAbi,
      convertPrivateKernelInner2OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInner2(
    inputs: PrivateKernelInner2CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInner2Artifact',
      convertPrivateKernelInner2InputsToWitnessMapWithAbi,
      convertPrivateKernelInner2OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInner3Output(
    inputs: PrivateKernelInner3CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInner3Artifact',
      convertPrivateKernelInner3InputsToWitnessMapWithAbi,
      convertPrivateKernelInner3OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInner3(
    inputs: PrivateKernelInner3CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInner3Artifact',
      convertPrivateKernelInner3InputsToWitnessMapWithAbi,
      convertPrivateKernelInner3OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInner4Output(
    inputs: PrivateKernelInner4CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInner4Artifact',
      convertPrivateKernelInner4InputsToWitnessMapWithAbi,
      convertPrivateKernelInner4OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInner4(
    inputs: PrivateKernelInner4CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInner4Artifact',
      convertPrivateKernelInner4InputsToWitnessMapWithAbi,
      convertPrivateKernelInner4OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateInner5Output(
    inputs: PrivateKernelInner5CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'PrivateKernelInner5Artifact',
      convertPrivateKernelInner5InputsToWitnessMapWithAbi,
      convertPrivateKernelInner5OutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateInner5(
    inputs: PrivateKernelInner5CircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    return await this.simulateCircuitOutput(
      inputs,
      'PrivateKernelInner5Artifact',
      convertPrivateKernelInner5InputsToWitnessMapWithAbi,
      convertPrivateKernelInner5OutputsFromWitnessMapWithAbi,
    );
  }

  public async generateResetOutput(
    inputs: PrivateKernelResetCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    const variantInputs = inputs.trimToSizes();
    const artifactName = getPrivateKernelResetArtifactName(inputs.dimensions);
    return await this.generateCircuitOutput(
      variantInputs,
      artifactName,
      convertPrivateKernelResetInputsToWitnessMapWithAbi,
      convertPrivateKernelResetOutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateReset(
    inputs: PrivateKernelResetCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs>> {
    updateResetCircuitSampleInputs(inputs);
    const variantInputs = inputs.trimToSizes();
    const artifactName = getPrivateKernelResetArtifactName(inputs.dimensions);
    return await this.simulateCircuitOutput(
      variantInputs,
      artifactName,
      convertPrivateKernelResetInputsToWitnessMapWithAbi,
      convertPrivateKernelResetOutputsFromWitnessMapWithAbi,
    );
  }

  public async generateResetTailOutput(
    inputs: PrivateKernelResetTailCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    const artifactName = getPrivateKernelResetTailArtifactName(inputs.dimensions, inputs.isForPublic());
    if (!inputs.isForPublic()) {
      return await this.generateCircuitOutput(
        inputs,
        artifactName,
        convertPrivateKernelResetTailInputsToWitnessMapWithAbi,
        convertPrivateKernelTailOutputsFromWitnessMapWithAbi,
      );
    }
    return await this.generateCircuitOutput(
      inputs,
      artifactName,
      convertPrivateKernelResetTailToPublicInputsToWitnessMapWithAbi,
      convertPrivateKernelTailForPublicOutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateResetTail(
    inputs: PrivateKernelResetTailCircuitPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    const artifactName = getPrivateKernelResetTailArtifactName(inputs.dimensions, inputs.isForPublic());
    if (!inputs.isForPublic()) {
      return await this.simulateCircuitOutput(
        inputs,
        artifactName,
        convertPrivateKernelResetTailInputsToWitnessMapWithAbi,
        convertPrivateKernelTailOutputsFromWitnessMapWithAbi,
      );
    }
    return await this.simulateCircuitOutput(
      inputs,
      artifactName,
      convertPrivateKernelResetTailToPublicInputsToWitnessMapWithAbi,
      convertPrivateKernelTailForPublicOutputsFromWitnessMapWithAbi,
    );
  }

  public async generateHidingToRollupOutput(
    inputs: HidingKernelToRollupPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'HidingKernelToRollup',
      convertHidingKernelToRollupInputsToWitnessMapWithAbi,
      convertPrivateKernelTailOutputsFromWitnessMapWithAbi,
    );
  }

  public async generateHidingToPublicOutput(
    inputs: HidingKernelToPublicPrivateInputs,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    return await this.generateCircuitOutput(
      inputs,
      'HidingKernelToPublic',
      convertHidingKernelPublicInputsToWitnessMapWithAbi,
      convertPrivateKernelTailForPublicOutputsFromWitnessMapWithAbi,
    );
  }

  public async simulateCircuitOutput<
    I extends { toBuffer: () => Buffer },
    O extends PrivateKernelCircuitPublicInputs | PrivateKernelTailCircuitPublicInputs,
  >(
    inputs: I,
    circuitType: ClientProtocolArtifact,
    convertInputs: (inputs: I, abi: Abi) => WitnessMap,
    convertOutputs: (outputs: WitnessMap, abi: Abi) => O,
  ): Promise<PrivateKernelSimulateOutput<O>> {
    const compiledCircuit: NoirCompiledCircuitWithName =
      await this.artifactProvider.getSimulatedClientCircuitArtifactByName(circuitType);

    const witnessMap = convertInputs(inputs, compiledCircuit.abi);

    const outputWitness = await this.simulator
      .executeProtocolCircuitToWitness(witnessMap, compiledCircuit, foreignCallHandler)
      .catch((err: Error) => {
        this.log.debug(`Failed to simulate ${circuitType}`, {
          circuitName: mapProtocolArtifactNameToCircuitName(circuitType),
          error: err,
        });
        throw err;
      });
    const output = convertOutputs(outputWitness.witness, compiledCircuit.abi);

    this.log.debug(`Simulated ${circuitType}`, {
      eventName: 'circuit-simulation',
      circuitName: mapProtocolArtifactNameToCircuitName(circuitType),
      duration: outputWitness.duration,
      inputSize: inputs.toBuffer().length,
      outputSize: output.toBuffer().length,
    } satisfies CircuitSimulationStats);

    return this.makeEmptyKernelSimulateOutput<O>(output, circuitType);
  }

  public async generateCircuitOutput<
    I extends { toBuffer: () => Buffer },
    O extends PrivateKernelCircuitPublicInputs | PrivateKernelTailCircuitPublicInputs,
  >(
    inputs: I,
    circuitType: ClientProtocolArtifact,
    convertInputs: (inputs: I, abi: Abi) => WitnessMap,
    convertOutputs: (outputs: WitnessMap, abi: Abi) => O,
  ): Promise<PrivateKernelSimulateOutput<O>> {
    this.log.debug(`Generating witness for ${circuitType}`);
    const compiledCircuit: NoirCompiledCircuitWithName =
      await this.artifactProvider.getClientCircuitArtifactByName(circuitType);

    const witnessMap = convertInputs(inputs, compiledCircuit.abi);
    const outputWitness = await this.simulator.executeProtocolCircuitToWitness(
      witnessMap,
      compiledCircuit,
      foreignCallHandler,
    );
    const output = convertOutputs(outputWitness.witness, compiledCircuit.abi);

    this.log.debug(`Generated witness for ${circuitType}`, {
      eventName: 'circuit-witness-generation',
      circuitName: mapProtocolArtifactNameToCircuitName(circuitType),
      duration: outputWitness.duration,
      inputSize: inputs.toBuffer().length,
      outputSize: output.toBuffer().length,
    } satisfies CircuitWitnessGenerationStats);

    const verificationKey = await this.artifactProvider.getCircuitVkByName(circuitType);
    const bytecode = Buffer.from(compiledCircuit.bytecode, 'base64');

    const kernelOutput: PrivateKernelSimulateOutput<O> = {
      publicInputs: output,
      verificationKey,
      outputWitness: outputWitness.witness,
      bytecode,
    };
    return kernelOutput;
  }

  public async makeEmptyKernelSimulateOutput<
    PublicInputsType extends PrivateKernelTailCircuitPublicInputs | PrivateKernelCircuitPublicInputs,
  >(publicInputs: PublicInputsType, circuitType: ClientProtocolArtifact) {
    const kernelProofOutput: PrivateKernelSimulateOutput<PublicInputsType> = {
      publicInputs,
      verificationKey: await this.artifactProvider.getCircuitVkByName(circuitType),
      outputWitness: new Map(),
      bytecode: Buffer.from([]),
    };
    return kernelProofOutput;
  }

  public async createChonkProof(executionSteps: PrivateExecutionStep[]): Promise<ChonkProofWithPublicInputs> {
    const bytecodes = executionSteps.map(step => ungzip(step.bytecode));
    const witnesses = executionSteps.map(step => ungzip(serializeWitness(step.witness)));
    const vks = executionSteps.map(step => step.vk);

    return await this.chonkQueue.put(async () => {
      const timer = new Timer();
      this.log.info(`Generating ClientIVC proof...`);
      const bb = (this.chonkBb ??= await Barretenberg.new({
        ...this.options,
        logger: this.options.logger?.verbose,
        // An idle prover must not hold open a host that never calls stop().
        unref: true,
        // A replacement process would not have the in-flight Chonk session.
        respawn: false,
      }));
      const backend = new AztecClientBackend(
        bytecodes,
        bb,
        executionSteps.map(step => step.functionName),
        executionSteps.map(step => step.kind),
      );

      try {
        // Use compressed prove path to get both proof fields and compressed proof bytes
        const proof = await backend.prove(witnesses, vks, { compress: true });
        this.log.info(`Generated ClientIVC proof`, {
          eventName: 'client-ivc-proof-generation',
          duration: timer.ms(),
          proofSize: proof.proofFields.length,
          compressedSize: proof.compressedProof?.length,
        });

        // Create ChonkProofWithPublicInputs from the flat field elements
        const proofWithPubInputs = ChonkProofWithPublicInputs.fromBufferArray(proof.proofFields);

        // Attach compressed proof bytes to the ChonkProof (without public inputs).
        // The compressed bytes are for the full proof WITH public inputs from bb;
        // when deserializing, the decompressor will strip them to match CHONK_PROOF_LENGTH.
        proofWithPubInputs.compressedProof = proof.compressedProof ? Buffer.from(proof.compressedProof) : undefined;
        return proofWithPubInputs;
      } catch (err) {
        this.chonkBb = undefined;
        try {
          await bb.destroy();
        } catch (destroyError) {
          this.log.warn('Failed to destroy Chonk prover backend', { err: destroyError });
        }
        throw err;
      }
    });
  }

  public async computeGateCountForCircuit(
    _bytecode: Buffer,
    _circuitName: string,
    _circuitKind: PrivateExecutionStep['kind'],
  ): Promise<number> {
    // Note we do not pass the vk to the backend. This is unneeded for gate counts.
    const barretenberg = await Barretenberg.initSingleton({
      ...this.options,
      logger: this.options.logger?.[(getEnv().LOG_LEVEL as LogLevel) || 'verbose'],
    });
    const backend = new AztecClientBackend([ungzip(_bytecode)], barretenberg, [_circuitName], [_circuitKind]);
    const gateCount = await backend.gates();
    return gateCount[0];
  }
}
