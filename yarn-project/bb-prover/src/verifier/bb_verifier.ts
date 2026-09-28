import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { Timer } from '@aztec-labs/foundation/timer';
import { ProtocolCircuitVks } from '@aztec-labs/noir-protocol-circuits-types/server/vks';
import {
  type ClientProtocolArtifact,
  type ProtocolArtifact,
  type ServerProtocolArtifact,
  mapProtocolArtifactNameToCircuitName,
} from '@aztec-labs/noir-protocol-circuits-types/types';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Proof } from '@aztec-labs/stdlib/proofs';
import type { CircuitVerificationStats } from '@aztec-labs/stdlib/stats';
import { Tx } from '@aztec-labs/stdlib/tx';
import type { VerificationKeyData } from '@aztec-labs/stdlib/vks';
import { promises as fs } from 'fs';

import { type BBJsApi, BBJsFactory } from '../bb/bb_js_backend.js';
import type { BBConfig } from '../config.js';
import { getUltraHonkFlavorForCircuit } from '../honk.js';

/**
 * Whether a failure was environmental, and so may be retried: the bb process died, its connection broke, or it could
 * not be started.
 *
 * The bare `retry` property is the contract, feature-detected rather than imported, so it holds across the bb.js and
 * ipc-runtime package boundaries alike. An error without it is the verification's own verdict.
 */
function isRetryableFailure(err: unknown): boolean {
  return err instanceof Error && (err as Error & { retry?: unknown }).retry === true;
}

/** Thrown when no live bb process could check a proof, so the proof was neither accepted nor rejected. */
export class ProofVerifierUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProofVerifierUnavailableError';
  }
}

export class BBCircuitVerifier implements ClientProtocolCircuitVerifier {
  /** bb instances a Chonk verification tries, while each one's bb dies under it, before the verifier is unavailable. */
  private static readonly MAX_CHONK_VERIFY_ATTEMPTS = 2;

  private bbJsFactory: BBJsFactory;

  protected constructor(
    private config: BBConfig,
    private logger: Logger,
    bbJsFactory?: BBJsFactory,
  ) {
    // BB_NUM_IVC_VERIFIERS bounds the number of long-lived bb processes the pool keeps alive.
    // If 0, fall back to spawning a fresh bb per verification.
    this.bbJsFactory =
      bbJsFactory ??
      new BBJsFactory(config.bbBinaryPath, {
        poolSize: config.numConcurrentIVCVerifiers > 0 ? config.numConcurrentIVCVerifiers : undefined,
        logger,
        debugDir: config.bbDebugOutputDir,
      });
  }

  public stop(): Promise<void> {
    return this.bbJsFactory.destroy();
  }

  public static async new(config: BBConfig, logger = createLogger('bb-prover:verifier')) {
    if (!config.bbWorkingDirectory) {
      throw new Error(`Barretenberg working directory (BB_WORKING_DIRECTORY) is not set`);
    }
    await fs.mkdir(config.bbWorkingDirectory, { recursive: true });
    return new BBCircuitVerifier(config, logger);
  }

  public getVerificationKeyData(circuit: ProtocolArtifact): VerificationKeyData {
    const vk = ProtocolCircuitVks[circuit];
    if (vk === undefined) {
      throw new Error(`Could not find VK for artifact ${circuit}`);
    }
    return vk;
  }

  /** Verify an UltraHonk proof via bb.js API (no temp files). */
  public async verifyProofForCircuit(circuit: ServerProtocolArtifact, proof: Proof) {
    const verificationKey = this.getVerificationKeyData(circuit);
    const flavor = getUltraHonkFlavorForCircuit(circuit);

    this.logger.debug(`${circuit} Verifying with key: ${verificationKey.keyAsFields.hash.toString()}`);

    // Split proof buffer into public input fields and proof fields (32-byte each)
    const publicInputFields = splitBufferToFieldArrays(proof.buffer.subarray(0, proof.numPublicInputs * 32));
    const proofFields = splitBufferToFieldArrays(proof.buffer.subarray(proof.numPublicInputs * 32));

    await using instance = await this.bbJsFactory.getInstance();
    const { verified, durationMs } = await instance.verifyProof(
      proofFields,
      verificationKey.keyAsBytes,
      publicInputFields,
      flavor,
    );

    if (!verified) {
      throw new Error(`Failed to verify ${circuit} proof!`);
    }

    this.logger.debug(`${circuit} verification successful`, {
      circuitName: mapProtocolArtifactNameToCircuitName(circuit),
      duration: durationMs,
      eventName: 'circuit-verification',
      proofType: 'ultra-honk',
    } satisfies CircuitVerificationStats);
  }

  /**
   * Verify a Chonk (IVC) proof from a transaction via bb.js API. Throws {@link ProofVerifierUnavailableError} when no
   * live bb process could check the proof; any other failure returns `valid: false`.
   */
  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    const proofType = 'Chonk';
    const txHash = tx.getTxHash().toString();
    try {
      const totalTimer = new Timer();

      const circuit: ClientProtocolArtifact = tx.data.forPublic ? 'HidingKernelToPublic' : 'HidingKernelToRollup';
      const verificationKey = this.getVerificationKeyData(circuit);

      // Reconstruct the full proof with public inputs prepended, then convert Fr[] to Uint8Array[]
      const proofWithPubInputs = tx.chonkProof.attachPublicInputs(tx.data.publicInputs().toFields());
      const fieldsAsBuffers = proofWithPubInputs.fieldsWithPublicInputs.map(f => new Uint8Array(f.toBuffer()));

      const { verified, durationMs } = await this.verifyChonkProofOnLiveInstance(
        fieldsAsBuffers,
        verificationKey.keyAsBytes,
        txHash,
      );

      if (!verified) {
        throw new Error(`Failed to verify ${proofType} proof for ${circuit}!`);
      }

      this.logger.debug(`${proofType} verification successful`, {
        circuitName: mapProtocolArtifactNameToCircuitName(circuit),
        duration: durationMs,
        eventName: 'circuit-verification',
        proofType: 'chonk',
      } satisfies CircuitVerificationStats);

      return { valid: true, durationMs, totalDurationMs: totalTimer.ms() };
    } catch (err) {
      if (err instanceof ProofVerifierUnavailableError) {
        throw err;
      }
      this.logger.warn(`Failed to verify ${proofType} proof`, { txHash, err });
      return { valid: false, durationMs: 0, totalDurationMs: 0 };
    }
  }

  /**
   * Runs a Chonk verification on a pooled bb instance. A call that failed for environmental reasons — its bb process
   * died, or could not be started — is retried; any other failure is the verification's own verdict and is rethrown.
   *
   * The error says so itself, through the `retry` property bb.js sets. Asking the instance whether it is still alive
   * would be a guess: the process can die between the answer and the next call.
   */
  private async verifyChonkProofOnLiveInstance(
    fieldsWithPublicInputs: Uint8Array[],
    verificationKey: Uint8Array,
    txHash: string,
  ): Promise<{ verified: boolean; durationMs: number }> {
    for (let attempt = 1; ; attempt++) {
      await using instance = await this.borrowInstance();
      try {
        return await instance.verifyChonkProof(fieldsWithPublicInputs, verificationKey);
      } catch (err) {
        if (!isRetryableFailure(err)) {
          throw err;
        }
        if (attempt >= BBCircuitVerifier.MAX_CHONK_VERIFY_ATTEMPTS) {
          throw new ProofVerifierUnavailableError(`bb died while verifying the proof, on ${attempt} instances`, {
            cause: err,
          });
        }
        this.logger.warn('bb died while verifying a proof; retrying on another instance', { txHash, attempt });
      }
    }
  }

  private async borrowInstance(): Promise<BBJsApi & AsyncDisposable> {
    try {
      return await this.bbJsFactory.getInstance();
    } catch (err) {
      throw new ProofVerifierUnavailableError('No bb instance available to verify the proof', { cause: err });
    }
  }
}

/** Split a buffer into 32-byte Uint8Array field elements. */
function splitBufferToFieldArrays(buffer: Buffer): Uint8Array[] {
  const fields: Uint8Array[] = [];
  for (let i = 0; i < buffer.length; i += 32) {
    fields.push(new Uint8Array(buffer.subarray(i, i + 32)));
  }
  return fields;
}
