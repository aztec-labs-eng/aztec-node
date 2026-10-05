import { createLogger } from '@aztec-labs/foundation/log';
import { ProofVerifierUnavailableError } from '@aztec-labs/stdlib/errors';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Tx } from '@aztec-labs/stdlib/tx';

import type { BBConfig } from '../config.js';
import { BatchChonkVerifier } from './batch_chonk_verifier.js';

/** A verifier that, once failed, stays failed: {@link BatchChonkVerifier}, or a double of it in tests. */
export interface FailingChonkVerifier extends ClientProtocolCircuitVerifier {
  isFailed(): boolean;
}

/**
 * Keeps a {@link BatchChonkVerifier} running by replacing it when it fails.
 *
 * The verifier holds a session on one bb process (verification keys, worker pool, result FIFO), and a bb death
 * leaves it failed for good. Everything that session holds comes from configuration, so a fresh verifier restores it
 * exactly; only proofs in flight are lost, and those were already rejected as unavailable.
 *
 * Replacement happens on the next verification after a failure, at most once a `replaceIntervalMs`, indefinitely and
 * on a flat cadence: the convention the AVM simulator pool uses, so a node recovers as soon as bb is healthy again
 * rather than waiting out a backoff. Between attempts, verifications are rejected as unavailable.
 *
 * Nothing here waits on a verifier being created except the verifications that need it. stop() stops the verifier in
 * use and leaves one still being created to stop itself when it is ready, so a bb that is slow to start cannot hold up
 * shutdown.
 */
export class SelfHealingChonkVerifier implements ClientProtocolCircuitVerifier {
  private readonly logger = createLogger('bb-prover:self_healing_chonk_verifier');
  /** The verifier verifications go to, or the creation of its replacement. */
  private current: Promise<FailingChonkVerifier>;
  /** The verifier in use, which stop() stops; unset while its replacement is being created. */
  private started: FailingChonkVerifier | undefined;
  private lastReplacedAt = 0;
  private stopped = false;

  constructor(
    private readonly create: () => Promise<FailingChonkVerifier>,
    first: FailingChonkVerifier,
    private readonly label: string,
    private readonly replaceIntervalMs = 1000,
  ) {
    this.started = first;
    this.current = Promise.resolve(first);
  }

  /** Start a batch verifier for the protocol circuits, replaced whenever it fails. */
  static async new(config: BBConfig, batchSize: number, label: string): Promise<SelfHealingChonkVerifier> {
    const create = () => BatchChonkVerifier.new(config, batchSize, label);
    return new SelfHealingChonkVerifier(create, await create(), label);
  }

  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    const verifier = await this.liveVerifier();
    return await verifier.verifyProof(tx);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.started?.stop();
  }

  private async liveVerifier(): Promise<FailingChonkVerifier> {
    const current = this.current;
    const verifier = await this.settled(current);
    if (this.stopped) {
      throw new ProofVerifierUnavailableError('Chonk verifier stopped');
    }
    if (verifier && !verifier.isFailed()) {
      return verifier;
    }
    // Only the first caller to find this verifier failed replaces it; the rest share the replacement.
    if (this.current === current) {
      if (Date.now() - this.lastReplacedAt < this.replaceIntervalMs) {
        throw new ProofVerifierUnavailableError('Chonk verifier is down');
      }
      this.lastReplacedAt = Date.now();
      this.logger.warn('Replacing the failed Chonk verifier', { label: this.label });
      this.started = undefined;
      if (verifier) {
        void this.retire(verifier);
      }
      this.current = this.startReplacement();
    }
    try {
      return await this.current;
    } catch (err) {
      throw new ProofVerifierUnavailableError('Chonk verifier could not be restarted', { cause: err });
    }
  }

  /** The verifier `pending` resolves to, or undefined if its creation failed. */
  private async settled(pending: Promise<FailingChonkVerifier>): Promise<FailingChonkVerifier | undefined> {
    try {
      return await pending;
    } catch {
      return undefined;
    }
  }

  private async startReplacement(): Promise<FailingChonkVerifier> {
    const verifier = await this.create();
    if (this.stopped) {
      // stop() did not wait for this one, so it stops itself.
      await this.retire(verifier);
      throw new ProofVerifierUnavailableError('Chonk verifier stopped');
    }
    this.started = verifier;
    this.logger.info('Replaced the failed Chonk verifier', { label: this.label });
    return verifier;
  }

  private async retire(verifier: FailingChonkVerifier): Promise<void> {
    try {
      await verifier.stop();
    } catch (err) {
      this.logger.warn('Error stopping a replaced Chonk verifier', { label: this.label, err });
    }
  }
}
