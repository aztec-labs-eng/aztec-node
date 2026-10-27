import { CHONK_PROOF_LENGTH } from '@aztec-labs/constants';
import { LruSet } from '@aztec-labs/foundation/collection';
import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { ReadWriteLock } from '@aztec-labs/foundation/queue';
import { InterruptibleSleep } from '@aztec-labs/foundation/sleep';
import { Timer } from '@aztec-labs/foundation/timer';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { createHash } from 'node:crypto';

import type { BBConfig } from '../config.js';
import { BatchChonkVerifier } from './batch_chonk_verifier.js';

/** A verifier that, once failed, stays failed: {@link BatchChonkVerifier}, or a double of it in tests. */
export interface FailingChonkVerifier extends ClientProtocolCircuitVerifier {
  /** Whether the verifier has failed permanently and must be replaced. */
  isFailed(): boolean;
}

/**
 * Keeps a {@link BatchChonkVerifier} running by replacing it whenever its bb process dies, so callers only ever get a
 * verdict on a proof.
 *
 * The verifier holds a session on one bb process (verification keys, worker pool, result FIFO), and a bb death leaves
 * it failed for good. Everything that session holds comes from configuration, so a fresh verifier restores it exactly.
 *
 * A bb death fails every proof in flight at once, without saying which of them caused it. So each of those is checked
 * again on its own, with no other proof in flight (see {@link verifyProof}), and a death then is down to that proof: it
 * is invalid, and remembered, so it doesn't crash bb again when it is sent again. A bb that dies on every proof looks
 * the same from here, so a proof is only blamed once bb has given a verdict on some other proof since it last blamed
 * one, and waits for one until then. A bb that never works therefore blames nothing (and verifies nothing, which the
 * verification metrics show), rather than giving anyone who can crash it a way to shut the node down.
 *
 * A bb that cannot be started at all is nothing the node can work around, so it exits for its orchestrator to restart
 * it. Replacements are made at most once a `replaceIntervalMs`.
 */
export class SelfHealingChonkVerifier implements ClientProtocolCircuitVerifier {
  /** How many proofs that crashed bb are remembered. */
  static readonly CRASHED_PROOFS_REMEMBERED = 1024;

  private readonly logger = createLogger('bb-prover:self_healing_chonk_verifier');
  /** The verifier verifications go to, or the creation of its replacement. */
  private current: Promise<FailingChonkVerifier>;
  /** The verifier in use, which stop() stops; unset while its replacement is being created. */
  private started: FailingChonkVerifier | undefined;
  /** When the verifier was last replaced, as a `Date.now()` timestamp in ms; 0 if it never has been. */
  private lastReplacedAtMs = 0;
  private stopped = false;
  /** Wakes verifications waiting for the next replacement when the verifier stops. */
  private readonly sleeper = new InterruptibleSleep();
  /**
   * Every check holds this lock: shared normally, so bb batches proofs together, and exclusive for a proof checked on
   * its own after a bb death, so that no other proof is in flight with it.
   */
  private readonly checkLock = new ReadWriteLock();
  /** Proofs found to crash bb, by the hash of their tx, so they are answered without sending them to bb again. */
  private readonly crashedProofs = new LruSet<string>(SelfHealingChonkVerifier.CRASHED_PROOFS_REMEMBERED);
  /** Whether bb has given a verdict on any proof since a proof was last blamed for crashing it. */
  private verdictSinceLastBlame = false;
  /** Resolved when bb next gives a verdict, or the verifier stops. */
  private nextVerdict = promiseWithResolvers<void>();

  constructor(
    private readonly create: () => Promise<FailingChonkVerifier>,
    first: FailingChonkVerifier,
    private readonly label: string,
    private readonly replaceIntervalMs = 1000,
    private readonly exitNode: (err: unknown) => never = exitBecauseBbWontStart,
  ) {
    this.started = first;
    this.current = Promise.resolve(first);
  }

  /** Start a batch verifier for the protocol circuits, replaced whenever it fails. */
  static async new(config: BBConfig, batchSize: number, label: string): Promise<SelfHealingChonkVerifier> {
    const create = () => BatchChonkVerifier.new(config, batchSize, label);
    return new SelfHealingChonkVerifier(create, await create(), label);
  }

  /**
   * Verifies a tx's Chonk proof. Answers valid or invalid, and rejects only once stopped or on an error other than bb
   * dying:
   * 1. The proof is checked alongside any others, so bb batches it with them.
   * 2. If bb dies with it in flight, it is checked again on its own: proofs already in flight finish first, new ones
   *    wait once its turn starts, and proofs checked on their own go one at a time, in order.
   * 3. If bb dies on it again, it is blamed and answered invalid, provided bb has given a verdict on some other proof
   *    since it last blamed one. Otherwise it waits for such a verdict and goes back to step 2.
   */
  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    const timer = new Timer();
    // A tx with no proof is invalid without asking bb, and must not count as bb giving a verdict.
    if (tx.chonkProof.fields.length !== CHONK_PROOF_LENGTH) {
      return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
    }
    if (this.crashedBefore(tx)) {
      return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
    }
    const result = await this.checkLock.runShared(() => this.verifyOnLiveVerifier(tx));
    if (result) {
      return result;
    }
    for (;;) {
      const result = await this.checkLock.runExclusive(() => this.verifyOnItsOwn(tx, timer));
      if (result) {
        return result;
      }
      this.logger.warn(
        'Chonk verifier went down on a proof checked on its own, but has given no verdict since it last did',
        { label: this.label, txHash: tx.getTxHash().toString() },
      );
      await this.nextVerdict.promise;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.sleeper.interrupt();
    this.nextVerdict.resolve();
    await this.started?.stop();
  }

  /**
   * Checks a proof with no other proof in flight, and blames it if bb dies on it. Both happen within its exclusive
   * turn, so a copy of the same tx checked next is answered from `crashedProofs` rather than crashing bb again. Returns
   * undefined if bb died but has given no verdict since it last blamed a proof, so nothing can be blamed yet.
   */
  private async verifyOnItsOwn(tx: Tx, timer: Timer): Promise<IVCProofVerificationResult | undefined> {
    if (this.crashedBefore(tx)) {
      return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
    }
    const result = await this.verifyOnLiveVerifier(tx);
    if (result || !this.verdictSinceLastBlame) {
      return result;
    }
    this.logger.warn('Proof took the Chonk verifier down when checked on its own', {
      label: this.label,
      txHash: tx.getTxHash().toString(),
    });
    this.verdictSinceLastBlame = false;
    this.crashedProofs.add(crashKey(tx));
    return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
  }

  /** Whether a copy of this tx has crashed bb. Skips the hash, which serializes the whole tx, until some proof has. */
  private crashedBefore(tx: Tx): boolean {
    return this.crashedProofs.size > 0 && this.crashedProofs.has(crashKey(tx));
  }

  /**
   * Verifies on the live verifier. Returns undefined if that verifier died with the proof in flight, so the proof was
   * never checked.
   */
  private async verifyOnLiveVerifier(tx: Tx): Promise<IVCProofVerificationResult | undefined> {
    const verifier = await this.liveVerifier();
    try {
      const result = await verifier.verifyProof(tx);
      this.verdictSinceLastBlame = true;
      this.nextVerdict.resolve();
      this.nextVerdict = promiseWithResolvers<void>();
      return result;
    } catch (err) {
      if (verifier.isFailed() && !this.stopped) {
        return undefined;
      }
      throw err;
    }
  }

  private async liveVerifier(): Promise<FailingChonkVerifier> {
    for (;;) {
      const current = this.current;
      const verifier = await current;
      if (this.stopped) {
        throw new Error('Chonk verifier stopped');
      }
      if (!verifier.isFailed()) {
        return verifier;
      }
      // Only the first caller to find this verifier failed replaces it; the rest share the replacement. Either way the
      // loop checks the replacement too, since it may have failed before the proof gets to it.
      if (this.current !== current) {
        continue;
      }
      const waitMs = this.lastReplacedAtMs + this.replaceIntervalMs - Date.now();
      if (waitMs > 0) {
        await this.sleeper.sleep(waitMs);
        continue;
      }
      this.lastReplacedAtMs = Date.now();
      this.logger.warn('Replacing the failed Chonk verifier', { label: this.label });
      this.started = undefined;
      void this.retire(verifier);
      this.current = this.startReplacement();
    }
  }

  private async startReplacement(): Promise<FailingChonkVerifier> {
    let verifier: FailingChonkVerifier;
    try {
      verifier = await this.create();
    } catch (err) {
      if (this.stopped) {
        throw new Error('Chonk verifier stopped');
      }
      this.exitNode(err);
    }
    if (this.stopped) {
      // stop() did not wait for this one, so it stops itself.
      await this.retire(verifier);
      throw new Error('Chonk verifier stopped');
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

/** Identifies a tx by its full contents: its hash does not cover the proof, so it could be reused with an honest one. */
function crashKey(tx: Tx): string {
  return createHash('sha256').update(tx.toBuffer()).digest('hex');
}

/**
 * Exits the process because no bb process could be started to replace a dead one. No proof is involved in starting
 * bb, so the environment is broken: crash, and let the orchestrator restart the node.
 */
function exitBecauseBbWontStart(err: unknown): never {
  createLogger('bb-prover:self_healing_chonk_verifier').fatal(
    'Could not start a bb process to replace the failed Chonk verifier; exiting',
    err,
  );
  process.exit(1);
}
