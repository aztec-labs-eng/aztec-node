import { type ExecutionError, type ForeignCallHandler, executeCircuit } from '@aztec-foundation/noir-acvm_js';
import { abiDecode, abiEncode } from '@aztec-foundation/noir-noirc_abi';
import type { InputMap, WitnessMap } from '@aztec-foundation/noir-types';

import { Timer } from '@aztec-labs/foundation/timer';
import type { FunctionArtifactWithContractName } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';

import type { ACIRCallback, ACIRExecutionResult } from './acvm/acvm.js';
import type { ACVMWitness } from './acvm/acvm_types.js';
import type { ACVMSuccess } from './acvm_native.js';
import { type CircuitSimulator, type ProtocolCircuitResult, enrichNoirError } from './circuit_simulator.js';

/**
 * A circuit simulator that uses the WASM simulator with the ability to handle blobs via the foreign call handler.
 * This class is temporary while brillig cannot handle the blob math, and it is kept separate
 * because the zkg commitment library used in the blob code is not browser compatible.
 *
 * It is only used in the context of server-side code executing simulated protocol circuits.
 */
export class WASMSimulatorWithBlobs implements CircuitSimulator {
  async executeProtocolCircuit<ReturnType>(
    inputs: InputMap,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler,
  ): Promise<ProtocolCircuitResult<ReturnType>> {
    // `executeCircuit` only speaks witness maps, so the ABI encode/decode happens here rather than
    // in the caller. See the note on CircuitSimulator.executeProtocolCircuit.
    const { witness, duration } = await this.executeProtocolCircuitToWitness(
      abiEncode(artifact.abi, inputs),
      artifact,
      callback,
    );
    return { returnValue: abiDecode(artifact.abi, witness).return_value as ReturnType, duration };
  }

  async executeProtocolCircuitToWitness(
    input: WitnessMap,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler,
  ): Promise<ACVMSuccess> {
    // Decode the bytecode from base64 since the acvm does not know about base64 encoding
    const decodedBytecode = Buffer.from(artifact.bytecode, 'base64');
    //
    // Execute the circuit
    try {
      const timer = new Timer();
      const _witnessMap = await executeCircuit(
        decodedBytecode,
        input,
        callback, // handle calls to debug_log and evaluate_blobs mock
      );
      return { witness: _witnessMap, duration: timer.ms() } as ACVMSuccess;
    } catch (err) {
      // Typescript types caught errors as unknown or any, so we need to narrow its type to check if it has raw
      // assertion payload.
      if (typeof err === 'object' && err !== null && 'rawAssertionPayload' in err) {
        throw enrichNoirError(artifact, err as ExecutionError);
      }
      throw new Error(`Circuit execution failed: ${err}`);
    }
  }

  executeUserCircuit(
    _input: ACVMWitness,
    _artifact: FunctionArtifactWithContractName,
    _callback: ACIRCallback,
  ): Promise<ACIRExecutionResult> {
    throw new Error('Not implemented');
  }
}
