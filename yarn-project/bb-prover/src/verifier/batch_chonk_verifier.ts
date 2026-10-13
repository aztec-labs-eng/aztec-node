import { BackendType, Barretenberg } from '@aztec-foundation/bb.js';

import { CHONK_PROOF_LENGTH } from '@aztec-labs/constants';
import { FifoFrameReader } from '@aztec-labs/foundation/fifo';
import { createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { Timer } from '@aztec-labs/foundation/timer';
import { ProtocolCircuitVks } from '@aztec-labs/noir-protocol-circuits-types/server/vks';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { getTelemetryClient } from '@aztec-labs/telemetry-client';
import { Unpackr } from 'msgpackr';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { BBConfig } from '../config.js';
import { IVCVerifierMetrics } from './queued_chonk_verifier.js';

const execFileAsync = promisify(execFile);
const STOP_DRAIN_TIMEOUT_MS = 5_000;
/**
 * Most proofs in flight at once. bb's batch verifier rejects a proof once 1024 are waiting (its `MAX_QUEUE_SIZE`) and
 * reports it as FAILED, indistinguishable from a proof it checked and rejected. Proofs in flight here include every
 * one bb has queued, so capping them at that size keeps bb's queue from overflowing; a proof past the cap waits for
 * room.
 */
export const MAX_PROOFS_IN_FLIGHT = 1024;

/** Result from the FIFO, matching the C++ VerifyResult struct. */
interface FifoVerifyResult {
  request_id: number;
  status: number;
  error_message: string;
  time_in_verify_ms: number;
}

/** Maps client protocol artifacts used for chonk verification to VK indices. */
const CHONK_VK_ARTIFACTS = ['HidingKernelToRollup', 'HidingKernelToPublic'] as const;

interface PendingRequest {
  resolve: (result: IVCProofVerificationResult) => void;
  reject: (error: Error) => void;
  totalTimer: Timer;
  /** The startup request that makes bb open the result stream; not a proof anyone asked about. */
  probe?: boolean;
}

/**
 * Batch verifier for Chonk IVC proofs. Uses the bb batch verifier service
 * which batches IPA verification into a constant number of SRS MSMs for better throughput.
 *
 * Architecture:
 * - Spawns a persistent `bb msgpack run` process via Barretenberg (native backend)
 * - Sends proofs via the msgpack RPC protocol (ChonkBatchVerifierQueue)
 * - Receives results via a named FIFO pipe (async, out-of-order)
 * - Bisects batch failures to isolate individual bad proofs
 */
export class BatchChonkVerifier implements ClientProtocolCircuitVerifier {
  private bb!: Barretenberg;
  private fifoDir: string | undefined;
  private fifoPath = '';
  private nextRequestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private sendQueue: SerialQueue;
  private fifoReader: FifoFrameReader;
  private logger = createLogger('bb-prover:batch_chonk_verifier');
  private metrics: IVCVerifierMetrics;
  /** Maps artifact name to VK index in the batch verifier. */
  private vkIndexMap = new Map<string, number>();
  /** Bound cleanup handler for process exit signals. */
  private exitCleanup: (() => void) | null = null;
  private stopped = false;
  private fatalError: Error | undefined;
  private pendingDrainedResolvers = new Set<() => void>();
  /** Proofs waiting for room under {@link MAX_PROOFS_IN_FLIGHT}, oldest first. */
  private roomWaiters: (() => void)[] = [];

  private constructor(
    private config: Pick<BBConfig, 'bbChonkVerifyConcurrency'> & Partial<Pick<BBConfig, 'bbBinaryPath'>>,
    private vkBuffers: Uint8Array[],
    private batchSize: number,
    private label: string,
  ) {
    this.fifoReader = new FifoFrameReader();
    this.sendQueue = new SerialQueue();
    this.sendQueue.start(1);
    this.metrics = new IVCVerifierMetrics(getTelemetryClient(), `BatchChonkVerifier-${label}`);
  }

  /** Create and start a BatchChonkVerifier using the protocol circuit VKs. */
  static async new(config: BBConfig, batchSize: number, label: string): Promise<BatchChonkVerifier> {
    const vkBuffers: Uint8Array[] = [];
    const vkIndexMap = new Map<string, number>();
    for (const artifact of CHONK_VK_ARTIFACTS) {
      const vk = ProtocolCircuitVks[artifact];
      if (!vk) {
        throw new Error(`Missing VK for ${artifact}`);
      }
      vkIndexMap.set(artifact, vkBuffers.length);
      vkBuffers.push(vk.keyAsBytes);
    }
    const verifier = new BatchChonkVerifier(config, vkBuffers, batchSize, label);
    verifier.vkIndexMap = vkIndexMap;
    await verifier.start();
    return verifier;
  }

  /** Create and start a BatchChonkVerifier with custom VKs (for testing). */
  static async newForTesting(
    config: Pick<BBConfig, 'bbChonkVerifyConcurrency'> & Partial<Pick<BBConfig, 'bbBinaryPath'>>,
    vks: Uint8Array[],
    batchSize: number,
  ): Promise<BatchChonkVerifier> {
    const verifier = new BatchChonkVerifier(config, vks, batchSize, 'test');
    for (let i = 0; i < vks.length; i++) {
      verifier.vkIndexMap.set(String(i), i);
    }
    await verifier.start();
    return verifier;
  }

  private async start(): Promise<void> {
    this.logger.info('Starting BatchChonkVerifier');

    try {
      this.bb = await Barretenberg.new({
        bbPath: this.config.bbBinaryPath,
        backend: BackendType.NativeUnixSocket,
      });
      await this.bb.initSRSChonk();

      // Keep the FIFO in a private directory so cleanup has a single owner.
      this.fifoDir = await mkdtemp(path.join(os.tmpdir(), `bb-batch-${this.label}-${process.pid}-`));
      this.fifoPath = path.join(this.fifoDir, 'results.fifo');
      await execFileAsync('mkfifo', [this.fifoPath]);
      this.registerExitCleanup();
      this.startFifoReader();

      await this.bb.chonkBatchVerifierStart({
        vks: this.vkBuffers,
        numCores: this.config.bbChonkVerifyConcurrency || 0,
        batchSize: this.batchSize,
        fifoPath: this.fifoPath,
      });
      await this.openResultStream();
    } catch (err) {
      this.fifoReader.stop();
      this.deregisterExitCleanup();
      await this.cleanupFifo();
      await this.bb?.destroy().catch(() => {});
      throw err;
    }
    this.logger.info('BatchChonkVerifier started', { fifoPath: this.fifoPath });
  }

  /**
   * Makes bb open the result stream now. bb opens it only to write its first result, and the stream ending is how a bb
   * death reaches proofs already queued, so until then such a death would leave them waiting forever. A proof with no
   * fields fails to deserialize, and bb writes that result before acknowledging the request.
   */
  private async openResultStream(): Promise<void> {
    const requestId = this.nextRequestId++;
    const result = new Promise<IVCProofVerificationResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, totalTimer: new Timer(), probe: true });
    });
    // Awaited together so a failure of the stream before bb acknowledges the request is still handled.
    await Promise.all([this.bb.chonkBatchVerifierQueue({ requestId, vkIndex: 0, proofFields: [] }), result]);
  }

  /**
   * Verifies a tx's Chonk proof. Returns `valid: false` only for a malformed proof or one bb checked and rejected; rejects
   * whenever the proof could not be checked, such as when bb died with it in flight (see {@link isFailed}).
   */
  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    const totalTimer = new Timer();
    const txHash = tx.getTxHash().toString();
    // The empty placeholder can't be handed to bb at all; bb rejects any other malformed proof itself.
    if (tx.chonkProof.fields.length !== CHONK_PROOF_LENGTH) {
      this.logger.warn(`Rejecting malformed Chonk proof`, { txHash, length: tx.chonkProof.fields.length });
      return { valid: false, durationMs: 0, totalDurationMs: totalTimer.ms() };
    }
    try {
      const circuit = tx.data.forPublic ? 'HidingKernelToPublic' : 'HidingKernelToRollup';
      const vkIndex = this.vkIndexMap.get(circuit);
      if (vkIndex === undefined) {
        throw new Error(`No VK index for circuit ${circuit}`);
      }
      const proofWithPubInputs = tx.chonkProof.attachPublicInputs(tx.data.publicInputs().toFields());
      const proofFields = proofWithPubInputs.fieldsWithPublicInputs.map(f => f.toBuffer());
      return await this.enqueueProof(vkIndex, proofFields);
    } catch (err) {
      // A verdict only ever arrives through handleResult, so bb gave no answer on this proof.
      this.logger.warn(`Could not verify Chonk proof`, { txHash, err });
      throw err;
    }
  }

  /** Enqueue raw proof fields for verification, once there is room. Used directly by tests with custom VKs. */
  public async enqueueProof(vkIndex: number, proofFields: Uint8Array[]): Promise<IVCProofVerificationResult> {
    while (!this.stopped && !this.fatalError && this.pendingRequests.size >= MAX_PROOFS_IN_FLIGHT) {
      await new Promise<void>(resolve => this.roomWaiters.push(resolve));
    }
    if (this.stopped) {
      return Promise.reject(new Error('BatchChonkVerifier stopped'));
    }
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }

    const totalTimer = new Timer();
    const requestId = this.nextRequestId++;

    const resultPromise = new Promise<IVCProofVerificationResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject, totalTimer });
    });

    void this.sendQueue
      .put(async () => {
        if (this.fatalError) {
          throw this.fatalError;
        }
        await this.bb.chonkBatchVerifierQueue({
          requestId,
          vkIndex,
          proofFields,
        });
      })
      .catch(err => {
        // bb not taking the proof (bb.js reports the process gone before the result stream ends, or bb errors) leaves
        // its queue in an unknown state, so the verifier fails and is replaced.
        this.failVerifier(err instanceof Error ? err : new Error(String(err)));
      });

    return await resultPromise;
  }

  /**
   * Whether the verifier has failed for good: its bb process or result stream broke, so every proof in flight was
   * rejected unchecked, as is every proof enqueued from now on. A failed verifier never recovers; replace it.
   */
  public isFailed(): boolean {
    return this.fatalError !== undefined;
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping BatchChonkVerifier');
    this.stopped = true;
    this.wakeRoomWaiters();

    try {
      // Stop accepting new proofs and flush the send queue. Bound it so an unresponsive
      // native process can't block teardown of our own event-loop handles indefinitely.
      await this.withTimeout(this.sendQueue.end(), STOP_DRAIN_TIMEOUT_MS, 'send queue flush');

      // Stop the bb service (flushes remaining proofs).
      await this.withTimeout(this.bb.chonkBatchVerifierStop({}), STOP_DRAIN_TIMEOUT_MS, 'chonkBatchVerifierStop');

      // Native stop flushes callbacks; keep the FIFO open until those frames are observed.
      const drained = await this.waitForPendingRequestsToDrain(STOP_DRAIN_TIMEOUT_MS);
      if (!drained) {
        this.rejectPendingRequests(new Error('Timed out waiting for BatchChonkVerifier results during stop'));
      }
    } catch (err) {
      this.logger.warn(`Error during BatchChonkVerifier graceful stop: ${err}`);
      this.rejectPendingRequests(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Always release our own event-loop handles — the FIFO read stream (a blocking
      // threadpool read that can't be unref'd), the unix socket, the native process, and the
      // exit handler — so the host process exits cleanly even if the native backend is wedged.
      this.fifoReader.stop();
      this.deregisterExitCleanup();
      await this.cleanupFifo();
      await this.bb.destroy().catch(err => this.logger.warn(`Error destroying bb backend during stop: ${err}`));
    }

    this.logger.info('BatchChonkVerifier stopped');
  }

  /**
   * Races a promise against a timeout so a wedged native backend can't block teardown. The
   * timer is unref'd so it never keeps the process alive; the underlying promise stays handled
   * by the race even if the timeout wins, so it cannot surface as an unhandled rejection.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`BatchChonkVerifier ${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private startFifoReader(): void {
    const unpackr = new Unpackr({ useRecords: false });

    this.fifoReader.on('frame', (payload: Buffer) => {
      try {
        const result = unpackr.unpack(payload) as FifoVerifyResult;
        this.handleResult(result);
      } catch (err) {
        this.logger.error(`FIFO: failed to decode msgpack result: ${err}`);
        // A corrupt result stream cannot safely be matched to outstanding requests.
        this.failVerifier(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.fifoReader.on('error', (err: Error) => {
      this.logger.error(`FIFO reader error: ${err}`);
      this.failVerifier(err);
    });

    this.fifoReader.on('end', () => {
      this.logger.debug('FIFO reader: stream ended');
      if (!this.stopped) {
        this.failVerifier(new Error('FIFO stream ended unexpectedly'));
      }
    });

    this.fifoReader.start(this.fifoPath);
  }

  private handleResult(result: FifoVerifyResult): void {
    const pending = this.pendingRequests.get(result.request_id);
    if (!pending) {
      this.logger.warn(`Received result for unknown request_id=${result.request_id}`);
      return;
    }
    this.pendingRequests.delete(result.request_id);
    if (pending.probe) {
      pending.resolve({ valid: result.status === 0, durationMs: 0, totalDurationMs: 0 });
      return;
    }

    const valid = result.status === 0; // VerifyStatus::OK
    const durationMs = result.time_in_verify_ms;
    const totalDurationMs = pending.totalTimer.ms();

    // Every FAILED result is a verdict on the proof, whatever its message. bb reports a malformed proof (an off-curve
    // or non-canonical commitment) as an exception it caught, worded like a failure of its own, so treating those as
    // anything else would let anyone swap a garbage proof into a real tx without penalty. A bb death surfaces through
    // the result stream failing instead.
    const ivcResult: IVCProofVerificationResult = { valid, durationMs, totalDurationMs };
    this.metrics.recordIVCVerification(ivcResult);

    if (!valid) {
      this.logger.warn(`Proof verification failed for request_id=${result.request_id}: ${result.error_message}`);
    } else {
      this.logger.debug(`Proof verified`, {
        requestId: result.request_id,
        durationMs: Math.ceil(durationMs),
        totalDurationMs: Math.ceil(totalDurationMs),
      });
    }

    pending.resolve(ivcResult);
    this.notifyPendingDrained();
  }

  private registerExitCleanup(): void {
    this.exitCleanup = () => {
      this.cleanupFifoSync();
    };
    process.on('exit', this.exitCleanup);
  }

  private deregisterExitCleanup(): void {
    if (this.exitCleanup) {
      process.removeListener('exit', this.exitCleanup);
      this.exitCleanup = null;
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of Array.from(this.pendingRequests)) {
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
    this.notifyPendingDrained();
  }

  private failVerifier(error: Error): void {
    if (!this.fatalError) {
      this.fatalError = error;
    }
    this.rejectPendingRequests(error);
  }

  private waitForPendingRequestsToDrain(timeoutMs: number): Promise<boolean> {
    if (this.pendingRequests.size === 0) {
      return Promise.resolve(true);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onDrain: (() => void) | undefined;
    const drained = new Promise<boolean>(resolve => {
      onDrain = () => resolve(true);
      this.pendingDrainedResolvers.add(onDrain);
    });
    const timedOut = new Promise<boolean>(resolve => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
    });

    return Promise.race([drained, timedOut]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (onDrain) {
        this.pendingDrainedResolvers.delete(onDrain);
      }
    });
  }

  /** Wakes as many proofs waiting for room as there is room for, or all of them once the verifier is done. */
  private wakeRoomWaiters(): void {
    const done = this.stopped || this.fatalError !== undefined;
    const room = done ? this.roomWaiters.length : MAX_PROOFS_IN_FLIGHT - this.pendingRequests.size;
    for (const wake of this.roomWaiters.splice(0, Math.max(0, room))) {
      wake();
    }
  }

  private notifyPendingDrained(): void {
    this.wakeRoomWaiters();
    if (this.pendingRequests.size > 0) {
      return;
    }
    for (const resolve of Array.from(this.pendingDrainedResolvers)) {
      resolve();
    }
  }

  private async cleanupFifo(): Promise<void> {
    if (this.fifoDir) {
      await rm(this.fifoDir, { recursive: true, force: true }).catch(() => {});
    } else if (this.fifoPath) {
      await rm(this.fifoPath, { force: true }).catch(() => {});
    }
    this.fifoDir = undefined;
    this.fifoPath = '';
  }

  private cleanupFifoSync(): void {
    try {
      if (this.fifoDir) {
        rmSync(this.fifoDir, { recursive: true, force: true });
      } else if (this.fifoPath) {
        rmSync(this.fifoPath, { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
