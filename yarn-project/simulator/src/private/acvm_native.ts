import type { ForeignCallHandler } from '@aztec-foundation/noir-acvm_js';
import { abiDecode } from '@aztec-foundation/noir-noirc_abi';
import type { InputMap } from '@aztec-foundation/noir-types';

import { runInDirectory } from '@aztec-labs/foundation/fs';
import { type Logger, type LoggerBindings, resolveLogger } from '@aztec-labs/foundation/log';
import { Timer } from '@aztec-labs/foundation/timer';
import type { FunctionArtifactWithContractName } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';
import * as proc from 'child_process';
import { promises as fs } from 'fs';
import { Unpackr } from 'msgpackr';
import * as path from 'path';
import { gunzipSync } from 'zlib';

import type { ACIRCallback, ACIRExecutionResult } from './acvm/acvm.js';
import type { ACVMWitness } from './acvm/acvm_types.js';
import type { CircuitSimulator, ProtocolCircuitResult } from './circuit_simulator.js';

export enum ACVM_RESULT {
  SUCCESS,
  FAILURE,
}

export type ACVMSuccess = {
  status: ACVM_RESULT.SUCCESS;
  duration: number;
  witness: Map<number, string>;
};

export type ACVMFailure = {
  status: ACVM_RESULT.FAILURE;
  reason: string;
};

export type ACVMResult = ACVMSuccess | ACVMFailure;

/**
 * `noir-execute` rejects an artifact whose `debug_symbols` is the empty string, and the protocol
 * circuit artifacts ship with debug info stripped. This is a deflated, base64-encoded
 * `ProgramDebugInfo` with no entries, which deserializes to the same "no debug info" state the
 * stripped artifacts already represent.
 */
const EMPTY_DEBUG_SYMBOLS = 'q1ZKSU0qTY/PzEvLL1ayio6tBQA=';

const PROVER_FILE = 'Prover.json';
const WITNESS_NAME = 'output-witness';

/** Witness stack values arrive as big-endian 32-byte field elements; the ACVM witness map holds hex strings. */
const witnessUnpackr = new Unpackr({ mapsAsObjects: false });

/**
 * Decodes the witness file `noir-execute` writes: a gzipped, single-byte-tagged msgpack
 * `WitnessStack`, whose top entry holds the solved witness of the circuit that was executed.
 * @param witnessGz - The raw contents of the output witness file.
 * @returns The solved witness map.
 */
function parseWitnessStack(witnessGz: Buffer): Map<number, string> {
  const decompressed = gunzipSync(witnessGz);
  // The leading byte is the serialization format marker, which is not part of the msgpack payload.
  const stack = witnessUnpackr.unpack(decompressed.subarray(1)) as [[[number, Map<number, Buffer>]]];
  const [, witness] = stack[0][stack[0].length - 1];
  const result = new Map<number, string>();
  for (const [index, value] of witness) {
    result.set(index, `0x${value.toString('hex')}`);
  }
  return result;
}

export class NativeACVMSimulator implements CircuitSimulator {
  private logger: Logger;
  /**
   * Artifacts are rewritten and written to disk once per circuit rather than per execution: they run
   * to tens of megabytes, and `noir-execute` reads the artifact from a path.
   */
  private artifactPaths = new Map<string, Promise<string>>();

  constructor(
    private workingDirectory: string,
    private pathToAcvm: string,
    private witnessFilename?: string,
    loggerOrBindings?: Logger | LoggerBindings,
  ) {
    this.logger = resolveLogger('simulator:acvm-native', loggerOrBindings);
  }

  async executeProtocolCircuit<ReturnType>(
    inputs: InputMap,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler | undefined,
  ): Promise<ProtocolCircuitResult<ReturnType>> {
    this.rejectForeignCalls(callback);
    const artifactPath = await this.getArtifactPath(artifact);

    return await runInDirectory(
      this.workingDirectory,
      async directory => {
        const proverFile = path.join(directory, PROVER_FILE);
        await fs.writeFile(proverFile, JSON.stringify(inputs));

        // `--overwrite-return` writes the circuit's return value back into the prover file in ABI
        // form, which is what the caller wants; the solved witness is only asked for when something
        // downstream consumes the file, so that a simulation does not pay to write and compress it.
        const timer = new Timer();
        await this.run(artifactPath, proverFile, directory, this.witnessFilename !== undefined);
        const duration = timer.ms();

        if (this.witnessFilename !== undefined) {
          await fs.copyFile(path.join(directory, `${WITNESS_NAME}.gz`), this.witnessFilename);
        }

        const { return: returnValue } = JSON.parse(await fs.readFile(proverFile, 'utf-8'));
        return { returnValue: returnValue as ReturnType, duration };
      },
      false,
      this.logger,
    );
  }

  async executeProtocolCircuitToWitness(
    input: ACVMWitness,
    artifact: NoirCompiledCircuitWithName,
    callback: ForeignCallHandler | undefined,
  ): Promise<ACVMSuccess> {
    this.rejectForeignCalls(callback);
    const artifactPath = await this.getArtifactPath(artifact);

    return await runInDirectory(
      this.workingDirectory,
      async directory => {
        // `noir-execute` takes inputs in ABI form, so a caller holding a witness map has to have it
        // decoded back. Only this witness-level entry point pays for that.
        const { inputs } = abiDecode(artifact.abi, input) as { inputs: InputMap };
        await fs.writeFile(path.join(directory, PROVER_FILE), JSON.stringify(inputs));

        const timer = new Timer();
        await this.run(artifactPath, path.join(directory, PROVER_FILE), directory, true);
        const witnessPath = path.join(directory, `${WITNESS_NAME}.gz`);
        const witness = parseWitnessStack(await fs.readFile(witnessPath));
        const duration = timer.ms();

        if (this.witnessFilename !== undefined) {
          await fs.copyFile(witnessPath, this.witnessFilename);
        }
        return { status: ACVM_RESULT.SUCCESS as const, witness, duration };
      },
      false,
      this.logger,
    );
  }

  executeUserCircuit(
    _input: ACVMWitness,
    _artifact: FunctionArtifactWithContractName,
    _callback: ACIRCallback,
  ): Promise<ACIRExecutionResult> {
    throw new Error('Not implemented');
  }

  private rejectForeignCalls(callback: ForeignCallHandler | undefined) {
    if (callback) {
      throw new Error('Native ACVM simulator does not support foreign calls. Ignoring callback.');
    }
  }

  /** Spawns `noir-execute`, resolving once the circuit has been solved. */
  private run(artifactPath: string, proverFile: string, directory: string, saveWitness: boolean): Promise<void> {
    const args = [
      'execute',
      '--artifact-path',
      artifactPath,
      '--prover-file',
      proverFile,
      '--overwrite-return',
      // Without an output directory the witness is solved and discarded, skipping the msgpack
      // serialization and gzip of a witness that can run to tens of megabytes.
      ...(saveWitness ? ['--output-dir', directory, '--witness-name', WITNESS_NAME] : []),
    ];

    this.logger.debug(`Calling noir-execute with ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const errChunks: Buffer[] = [];
      let errLen = 0;
      const child = proc.spawn(this.pathToAcvm, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (data: Buffer) => {
        errChunks.push(data);
        errLen += data.length;
      });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          const stderr = Buffer.concat(errChunks, errLen).toString('utf-8');
          this.logger.error(`From noir-execute: ${stderr}`);
          reject(new Error(`Failed to generate witness: ${stderr}`));
        }
      });
    });
  }

  /**
   * Writes the artifact in the shape `noir-execute` expects, reusing the file across executions of
   * the same circuit. Keyed on the fields that distinguish a circuit's compiled output, since
   * simulated and real variants of a circuit share a name.
   */
  private getArtifactPath(artifact: NoirCompiledCircuitWithName): Promise<string> {
    const key = `${artifact.name}-${artifact.hash ?? 'nohash'}-${artifact.bytecode.length}`;
    let written = this.artifactPaths.get(key);
    if (!written) {
      written = (async () => {
        const dir = path.join(this.workingDirectory, 'artifacts');
        await fs.mkdir(dir, { recursive: true });
        const artifactPath = path.join(dir, `${key}.json`);
        /* eslint-disable camelcase */
        const { noir_version, hash, abi, bytecode } = artifact as NoirCompiledCircuitWithName & {
          noir_version?: string;
        };
        await fs.writeFile(
          artifactPath,
          JSON.stringify({
            noir_version: noir_version ?? '0.0.0',
            hash: hash ?? 0,
            abi,
            bytecode,
            debug_symbols: EMPTY_DEBUG_SYMBOLS,
            file_map: {},
          }),
        );
        /* eslint-enable camelcase */
        return artifactPath;
      })();
      this.artifactPaths.set(key, written);
    }
    return written;
  }
}
