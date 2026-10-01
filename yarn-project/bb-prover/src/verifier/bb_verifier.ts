import { isRetryableError } from '@aztec-labs/foundation/error';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { Timer } from '@aztec-labs/foundation/timer';
import { ProtocolCircuitVks } from '@aztec-labs/noir-protocol-circuits-types/server/vks';
import {
  type ClientProtocolArtifact,
  type ProtocolArtifact,
  type ServerProtocolArtifact,
  mapProtocolArtifactNameToCircuitName,
} from '@aztec-labs/noir-protocol-circuits-types/types';
import { ProofVerifierUnavailableError } from '@aztec-labs/stdlib/errors';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Proof } from '@aztec-labs/stdlib/proofs';
import type { CircuitVerificationStats } from '@aztec-labs/stdlib/stats';
import { Tx } from '@aztec-labs/stdlib/tx';
import type { VerificationKeyData } from '@aztec-labs/stdlib/vks';
import { promises as fs } from 'fs';

import { type BBJsApi, BBJsFactory } from '../bb/bb_js_backend.js';
import type { BBConfig } from '../config.js';
import { getUltraHonkFlavorForCircuit } from '../honk.js';

export { ProofVerifierUnavailableError };

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
    const poolSize = config.numConcurrentIVCVerifiers > 0 ? config.numConcurrentIVCVerifiers : undefined;
    this.bbJsFactory =
      bbJsFactory ??
      new BBJsFactory(config.bbBinaryPath, {
        poolSize,
        // A pooled instance outlives the call that borrowed it, so it replaces a bb process that dies
        // under it and the next borrower gets a working one. Each verification stands alone, so a
        // replacement has nothing to carry over. A fresh-per-call instance has nothing to heal.
        respawn: poolSize !== undefined,
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
      let borrowed: BBJsApi & AsyncDisposable;
      try {
        borrowed = await this.bbJsFactory.getInstance();
      } catch (err) {
        // A bb that could not be started is worth another go, within the same budget a death gets.
        // Anything else — the factory destroyed under us — will not improve by asking again. Either
        // way no proof was checked, so this is never the proof's fault.
        if (isRetryableError(err) && attempt < BBCircuitVerifier.MAX_CHONK_VERIFY_ATTEMPTS) {
          this.logger.warn('no bb instance available to verify a proof; retrying', { txHash, attempt });
          continue;
        }
        throw new ProofVerifierUnavailableError('No bb instance available to verify the proof', { cause: err });
      }

      await using instance = borrowed;
      try {
        return await instance.verifyChonkProof(fieldsWithPublicInputs, verificationKey);
      } catch (err) {
        // Only an environmental failure is worth retrying; anything else is the verification's own
        // verdict and belongs to the caller.
        if (!isRetryableError(err)) {
          throw err;
        }
        if (attempt >= BBCircuitVerifier.MAX_CHONK_VERIFY_ATTEMPTS) {
          throw new ProofVerifierUnavailableError(`bb died while verifying the proof, on ${attempt} attempts`, {
            cause: err,
          });
        }
        this.logger.warn('bb died while verifying a proof; retrying', { txHash, attempt });
      }
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
