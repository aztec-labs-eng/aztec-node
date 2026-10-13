import { CHONK_PROOF_LENGTH } from '@aztec-labs/constants';
import { LruMap } from '@aztec-labs/foundation/collection';
import { createLogger } from '@aztec-labs/foundation/log';
import { type PromiseWithResolvers, promiseWithResolvers } from '@aztec-labs/foundation/promise';
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
 * A bb death fails every proof in flight. Each of those is then checked again on its own, with no other proof in
 * flight, so a death then is down to that proof: it is invalid, and remembered, so it doesn't crash bb again when it
 * is sent again. A bb that dies on every proof looks the same from here, so a proof is only blamed once bb has given a
 * verdict on some other proof since it last blamed one, and waits for one until then. A bb that never works therefore
 * blames nothing (and verifies nothing, which the verification metrics show), rather than giving anyone who can crash
 * it a way to shut the node down.
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
  private lastReplacedAt = 0;
  private stopped = false;
  /** Wakes verifications waiting for the next replacement when the verifier stops. */
  private readonly sleeper = new InterruptibleSleep();
  /** Serialises proofs checked on their own. */
  private aloneLane: Promise<void> = Promise.resolve();
  /** Set while a proof is checked on its own, which holds back other proofs until it is done. */
  private exclusive: Promise<void> | undefined;
  private sharedInFlight = 0;
  /** Resolved once no other proof is in flight, for a proof waiting to be checked on its own. */
  private sharedDrained: PromiseWithResolvers<void> | undefined;
  /** Proofs found to crash bb, by the hash of their tx, so they are answered without sending them to bb again. */
  private readonly crashedProofs = new LruMap<string, true>(SelfHealingChonkVerifier.CRASHED_PROOFS_REMEMBERED);
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

  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    const timer = new Timer();
    // A tx with no proof is invalid without asking bb, and must not count as bb giving a verdict.
    if (tx.chonkProof.fields.length !== CHONK_PROOF_LENGTH) {
      return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
    }
    if (this.crashedProofs.size > 0 && this.crashedProofs.has(crashKey(tx))) {
      return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
    }
    try {
      return await this.alongsideOthers(() => this.verifyOnLiveVerifier(tx));
    } catch (err) {
      if (!(err instanceof VerifierDiedError)) {
        throw err;
      }
    }
    for (;;) {
      try {
        return await this.onItsOwn(() => this.verifyOnLiveVerifier(tx));
      } catch (err) {
        if (!(err instanceof VerifierDiedError)) {
          throw err;
        }
      }
      const txHash = tx.getTxHash().toString();
      if (this.verdictSinceLastBlame) {
        this.logger.warn('Proof took the Chonk verifier down when checked on its own', { label: this.label, txHash });
        this.verdictSinceLastBlame = false;
        this.crashedProofs.set(crashKey(tx), true);
        return { valid: false, durationMs: 0, totalDurationMs: timer.ms() };
      }
      this.logger.warn(
        'Chonk verifier went down on a proof checked on its own, but has given no verdict since it last did',
        {
          label: this.label,
          txHash,
        },
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

  /** Verifies on the live verifier, rejecting with {@link VerifierDiedError} if that verifier dies with it in flight. */
  private async verifyOnLiveVerifier(tx: Tx): Promise<IVCProofVerificationResult> {
    const verifier = await this.liveVerifier();
    try {
      const result = await verifier.verifyProof(tx);
      this.verdictSinceLastBlame = true;
      this.nextVerdict.resolve();
      this.nextVerdict = promiseWithResolvers<void>();
      return result;
    } catch (err) {
      if (verifier.isFailed() && !this.stopped) {
        throw new VerifierDiedError('Chonk verifier went down with the proof in flight', { cause: err });
      }
      throw err;
    }
  }

  /** Runs `fn` once no proof is being checked on its own. */
  private async alongsideOthers<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusive) {
      await this.exclusive;
    }
    this.sharedInFlight++;
    try {
      return await fn();
    } finally {
      if (--this.sharedInFlight === 0) {
        this.sharedDrained?.resolve();
      }
    }
  }

  /** Runs `fn` with no other proof in flight: after every proof checked on its own before it, and every other one. */
  private async onItsOwn<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.aloneLane;
    let release!: () => void;
    this.aloneLane = new Promise(resolve => (release = resolve));
    try {
      await previous;
      const done = promiseWithResolvers<void>();
      this.exclusive = done.promise;
      try {
        if (this.sharedInFlight > 0) {
          this.sharedDrained = promiseWithResolvers<void>();
          await this.sharedDrained.promise;
          this.sharedDrained = undefined;
        }
        return await fn();
      } finally {
        this.exclusive = undefined;
        done.resolve();
      }
    } finally {
      release();
    }
  }

  private async liveVerifier(): Promise<FailingChonkVerifier> {
    const current = this.current;
    const verifier = await current;
    if (this.stopped) {
      throw new Error('Chonk verifier stopped');
    }
    if (!verifier.isFailed()) {
      return verifier;
    }
    // Only the first caller to find this verifier failed replaces it; the rest share the replacement.
    if (this.current === current) {
      const wait = this.lastReplacedAt + this.replaceIntervalMs - Date.now();
      if (wait > 0) {
        await this.sleeper.sleep(wait);
        return await this.liveVerifier();
      }
      this.lastReplacedAt = Date.now();
      this.logger.warn('Replacing the failed Chonk verifier', { label: this.label });
      this.started = undefined;
      void this.retire(verifier);
      this.current = this.startReplacement();
    }
    return await this.current;
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

/** The verifier went down with the proof in flight, so it was never checked. */
class VerifierDiedError extends Error {}

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
    { err },
  );
  process.exit(1);
}
