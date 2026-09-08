import type { ExecutionError, ForeignCallHandler } from '@aztec-foundation/noir-acvm_js';
import { abiDecodeError } from '@aztec-foundation/noir-noirc_abi';
import type { InputMap } from '@aztec-foundation/noir-types';

import { parseDebugSymbols } from '@aztec-labs/stdlib/abi';
import type { FunctionArtifactWithContractName } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledCircuit, NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';

import { type ACIRCallback, type ACIRExecutionResult, extractCallStack } from './acvm/acvm.js';
import type { ACVMWitness } from './acvm/acvm_types.js';
import type { ACVMSuccess } from './acvm_native.js';

/** The outcome of executing a protocol circuit at the ABI level. */
export type ProtocolCircuitResult<ReturnType> = {
  /** The circuit's return value, decoded against the artifact's ABI. */
  returnValue: ReturnType;
  /** How long the execution took, in milliseconds. */
  duration: number;
};

/**
 * Low level simulation interface
 */
export interface CircuitSimulator {
  /**
   * Execute a protocol circuit and decode its return value.
   *
   * Inputs and outputs are exchanged in ABI form rather than as witness maps, which lets each
   * simulator talk to its backend in that backend's native currency: the native simulator writes the
   * inputs straight out as a prover file and reads the return value back, never materializing a
   * witness map, while the WASM simulator encodes and decodes around `executeCircuit`.
   *
   * @param inputs - The circuit's parameters, keyed by ABI parameter name.
   * @param artifact - ACIR circuit bytecode and its metadata.
   * @param callback - A callback to process any foreign calls from the circuit. Can be undefined as for native
   * ACVM simulator we don't process foreign calls.
   * @returns The circuit's decoded return value.
   */
  executeProtocolCircuit<ReturnType>(
    inputs: InputMap,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler | undefined,
  ): Promise<ProtocolCircuitResult<ReturnType>>;

  /**
   * Execute a protocol circuit and return its full solved witness.
   *
   * Only for callers that need the witness itself — client IVC hands it to the proving backend. Prefer
   * {@link executeProtocolCircuit} otherwise: materializing the witness costs a hex string per entry,
   * and solved witnesses run to hundreds of thousands of entries.
   *
   * @param input - The initial witness map defining all of the inputs to `circuit`.
   * @param artifact - ACIR circuit bytecode and its metadata.
   * @param callback - A callback to process any foreign calls from the circuit.
   * @returns The solved witness calculated by executing the circuit on the provided inputs.
   */
  executeProtocolCircuitToWitness(
    input: ACVMWitness,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler | undefined,
  ): Promise<ACVMSuccess>;

  /**
   * Execute a user circuit (smart contract function)/generate a witness
   * @param input - The initial witness map defining all of the inputs to `circuit`.
   * @param artifact - Contract function ACIR circuit bytecode and its metadata.
   * @param callback - A callback to process any foreign calls from the circuit.
   * @returns The solved witness calculated by executing the circuit on the provided inputs, as well as the return
   * witness indices as specified by the circuit.
   */
  executeUserCircuit(
    input: ACVMWitness,
    artifact: FunctionArtifactWithContractName,
    callback: ACIRCallback,
  ): Promise<ACIRExecutionResult>;
}

export type DecodedError = ExecutionError & { decodedAssertionPayload?: any; noirCallStack?: string[] };

// Payload parsing taken from noir/noir-repo/tooling/noir_js/src/witness_generation.ts.
// TODO: import this in isolation without having to import noir_js in its entirety.
export function enrichNoirError(artifact: NoirCompiledCircuit, originalError: ExecutionError): DecodedError {
  const enrichedError = originalError as DecodedError;

  if (originalError.rawAssertionPayload) {
    try {
      // Decode the payload
      const decodedPayload = abiDecodeError(artifact.abi, originalError.rawAssertionPayload);

      if (typeof decodedPayload === 'string') {
        // If it's a string, just add it to the error message
        enrichedError.message = `Circuit execution failed: ${decodedPayload}`;
      } else {
        // If not, attach the payload to the original error
        enrichedError.decodedAssertionPayload = decodedPayload;
      }
    } catch {
      // Ignore errors decoding the payload
    }
  }

  try {
    // Decode the callstack
    const callStack = extractCallStack(originalError, {
      // TODO(https://github.com/AztecProtocol/aztec-packages/issues/5813)
      // We only support handling debug info for the circuit entry point.
      // So for now we simply index into the first debug info.
      debugSymbols: parseDebugSymbols(artifact.debug_symbols)[0],
      files: artifact.file_map,
    });

    enrichedError.noirCallStack = callStack?.map(errorLocation => {
      if (typeof errorLocation === 'string') {
        return `at opcode ${errorLocation}`;
      } else {
        return `at ${errorLocation.locationText} (${errorLocation.filePath}:${errorLocation.line}:${errorLocation.column})`;
      }
    });
  } catch {
    // Ignore errors resolving the callstack
  }

  return enrichedError;
}
