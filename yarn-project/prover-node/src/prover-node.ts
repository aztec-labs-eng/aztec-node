import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { Delayer } from '@aztec-labs/ethereum/l1-tx-utils';
import type { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { compact, pick } from '@aztec-labs/foundation/collection';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider, executeTimeout } from '@aztec-labs/foundation/timer';
import type { EpochProverFactory } from '@aztec-labs/prover-client';
import { ChonkCache } from '@aztec-labs/prover-client/orchestrator';
import { type AvmSimulator, PublicProcessorFactory } from '@aztec-labs/simulator/server';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import {
  type EpochProverManager,
  type EpochProvingJobState,
  EpochProvingJobTerminalState,
  type ITxProvider,
  type ProverNodeApi,
  type Service,
  type WorldStateSynchronizer,
  tryStop,
} from '@aztec-labs/stdlib/interfaces/server';
import type { DataStoreConfig } from '@aztec-labs/stdlib/kv-store';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import {
  L1Metrics,
  type TelemetryClient,
  type Traceable,
  type Tracer,
  getTelemetryClient,
} from '@aztec-labs/telemetry-client';

import { CheckpointFollower } from './checkpoint-follower.js';
import { CheckpointStore } from './checkpoint-store.js';
import type { SpecificProverNodeConfig } from './config.js';
import { EpochExpirySweep } from './epoch-expiry-sweep.js';
import { EpochProofStatus } from './epoch-proof-status.js';
import { FailureUploader } from './failure-uploader.js';
import type { CheckpointProver, CheckpointProverTestHooks } from './job/checkpoint-prover.js';
import type { EpochSessionHooks } from './job/epoch-session.js';
import { ProverNodeJobMetrics, ProverNodeRewardsMetrics } from './metrics.js';
import { ProofPublishingService } from './proof-publishing-service.js';
import type { ProverPublisherFactory } from './prover-publisher-factory.js';
import { SessionManager } from './session-manager.js';

type ProverNodeOptions = SpecificProverNodeConfig & Partial<DataStoreOptions>;
type DataStoreOptions = Pick<DataStoreConfig, 'dataDirectory'> & Pick<ChainConfig, 'l1ChainId' | 'rollupVersion'>;

/**
 * Grace period for the proof-publishing service to settle during shutdown. The service waits for
 * any in-flight L1 proof-submission tx to finish; that tx can take a long time to mine, so we cap
 * the wait rather than letting `stop()` hang indefinitely.
 */
const PUBLISHING_SERVICE_STOP_TIMEOUT_MS = 30_000;

/**
 * An Aztec Prover Node is a standalone process that monitors the chain for new checkpoints,
 * starts proving them as they arrive, and submits epoch proofs to L1 once complete.
 *
 * This class builds the components, starts and stops them in order, and serves the `ProverNodeApi`:
 *
 * - `CheckpointFollower` follows the chain and keeps the `CheckpointStore` in step with it.
 * - `CheckpointStore` holds one `CheckpointProver` per checkpoint; each proves its checkpoint's blocks.
 * - `SessionManager` decides when to prove an epoch and runs an `EpochSession` for it.
 * - `ProofPublishingService` submits finished epoch proofs to L1.
 * - `EpochExpirySweep` drops the state of epochs that can no longer be proven.
 * - `FailureUploader` uploads the data of failed proving attempts.
 */
export class ProverNode implements ProverNodeApi, Traceable {
  private log = createLogger('prover-node');

  protected readonly checkpointStore: CheckpointStore;
  protected readonly chonkCache: ChonkCache;
  protected readonly epochProofStatus: EpochProofStatus;
  protected readonly checkpointFollower: CheckpointFollower;
  protected readonly expirySweep: EpochExpirySweep;
  protected readonly failureUploader: FailureUploader;
  protected sessionManager: SessionManager | undefined;
  protected publishingService: ProofPublishingService | undefined;

  private readonly config: ProverNodeOptions;
  private readonly jobMetrics: ProverNodeJobMetrics;
  private readonly rewardsMetrics: ProverNodeRewardsMetrics;

  public readonly tracer: Tracer;

  constructor(
    protected readonly prover: EpochProverManager & EpochProverFactory,
    protected readonly publisherFactory: ProverPublisherFactory,
    protected readonly l2BlockSource: L2BlockSource & Partial<Service>,
    protected readonly l1ToL2MessageSource: L1ToL2MessageSource,
    protected readonly contractDataSource: ContractDataSource,
    protected readonly worldState: WorldStateSynchronizer,
    protected readonly p2pClient: {
      getTxProvider(): ITxProvider;
    } & Partial<Service>,
    protected readonly rollupContract: RollupContract,
    protected readonly l1Metrics: L1Metrics,
    private readonly avmSimulator: AvmSimulator,
    config: Partial<ProverNodeOptions> = {},
    protected readonly telemetryClient: TelemetryClient = getTelemetryClient(),
    private delayer?: Delayer,
    private readonly dateProvider: DateProvider = new DateProvider(),
  ) {
    this.config = {
      proverNodePollingIntervalMs: 1_000,
      proverNodeMaxPendingJobs: 100,
      proverNodeMaxParallelBlocksPerEpoch: 0,
      txGatheringIntervalMs: 1_000,
      txGatheringBatchSize: 10,
      txGatheringMaxParallelRequestsPerNode: 100,
      txGatheringTimeoutMs: 120_000,
      proverNodeFailedEpochStore: undefined,
      proverNodeEpochProvingDelayMs: undefined,
      ...compact(config),
    };

    this.validateConfig();

    const meter = telemetryClient.getMeter('ProverNode');
    this.tracer = telemetryClient.getTracer('ProverNode');

    this.jobMetrics = new ProverNodeJobMetrics(meter, telemetryClient.getTracer('EpochProvingJob'));
    this.rewardsMetrics = new ProverNodeRewardsMetrics(meter, this.prover.getProverId(), rollupContract);

    const bindings = this.log.getBindings();
    this.epochProofStatus = new EpochProofStatus({
      l2BlockSource: this.l2BlockSource,
      rollupContract: this.rollupContract,
      proverId: this.prover.getProverId(),
      dateProvider: this.dateProvider,
      bindings,
    });
    this.failureUploader = new FailureUploader({
      l2BlockSource: this.l2BlockSource,
      worldState: this.worldState,
      config: {
        failedEpochStore: this.config.proverNodeFailedEpochStore,
        ...pick(this.config, 'l1ChainId', 'rollupVersion', 'dataDirectory'),
      },
      bindings,
    });
    this.chonkCache = new ChonkCache(bindings);
    this.checkpointStore = new CheckpointStore(
      this.l2BlockSource,
      {
        proverFactory: this.prover,
        chonkCache: this.chonkCache,
        publicProcessorFactory: new PublicProcessorFactory(
          this.contractDataSource,
          this.avmSimulator,
          this.dateProvider,
          this.telemetryClient,
          bindings,
        ),
        dbProvider: this.worldState,
        txProvider: this.p2pClient.getTxProvider(),
        dateProvider: this.dateProvider,
        proverId: this.prover.getProverId(),
        metrics: this.jobMetrics,
        txGatheringTimeoutMs: this.config.txGatheringTimeoutMs,
        deadline: undefined,
        // Not awaited: an upload must not hold up the prover's teardown.
        onFailed: prover => void this.tryUploadCheckpointFailure(prover),
      },
      bindings,
    );
    this.checkpointFollower = new CheckpointFollower({
      l2BlockSource: this.l2BlockSource,
      l1ToL2MessageSource: this.l1ToL2MessageSource,
      worldState: this.worldState,
      checkpointStore: this.checkpointStore,
      proofStatus: this.epochProofStatus,
      handlers: {
        onCheckpointRegistered: async epoch => {
          await this.sessionManager?.onCheckpointAdded(epoch);
        },
        // The session manager cancels the affected sessions, and each cancelled session withdraws its own
        // candidate from the publishing service.
        onPruned: async affectedEpochs => {
          await this.sessionManager?.onPrune(affectedEpochs);
        },
        onChainProven: block => this.publishingService?.onChainProven(block),
      },
      config: {
        pollIntervalMs: this.config.proverNodePollingIntervalMs,
        disableFullEpochProving: !!this.config.proverNodeDisableFullEpochProving,
      },
      bindings,
    });
    this.expirySweep = new EpochExpirySweep({
      l2BlockSource: this.l2BlockSource,
      checkpointStore: this.checkpointStore,
      chonkCache: this.chonkCache,
      intervalMs: this.config.proverNodePollingIntervalMs,
      bindings,
    });
  }

  public getProverId() {
    return this.prover.getProverId();
  }

  public getP2P() {
    return this.p2pClient;
  }

  /** Test-only: the shared L1 tx delayer, if enabled. */
  public getDelayer(): Delayer | undefined {
    return this.delayer;
  }

  /** Tests inspect this when validating reconcile behaviour. */
  public getCheckpointStore(): CheckpointStore {
    return this.checkpointStore;
  }

  /** Tests inspect this to verify chonk-cache release semantics. */
  public getChonkCache(): ChonkCache {
    return this.chonkCache;
  }

  /** Tests inspect this when looking up live sessions. */
  public getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error('SessionManager not yet constructed — start() must be called first.');
    }
    return this.sessionManager;
  }

  /** Returns the underlying prover instance. */
  public getProver() {
    return this.prover;
  }

  /** Lists the proving sessions the node holds, with their state. */
  public getJobs(): Promise<{ uuid: string; status: EpochProvingJobState; epochNumber: EpochNumber }[]> {
    return Promise.resolve(this.sessionManager?.getJobs() ?? []);
  }

  /** Schedules proving for the given epoch and returns the job id without waiting for completion. */
  public async startProof(epochNumber: EpochNumber): Promise<string> {
    if (!this.sessionManager) {
      throw new Error('ProverNode not started');
    }
    return await this.sessionManager.startProof(epochNumber);
  }

  // ---------------- Service lifecycle ----------------

  async start() {
    await this.checkpointStore.start();

    await this.publisherFactory.start();
    this.publishingService = new ProofPublishingService({
      publisherFactory: this.publisherFactory,
      l2BlockSource: this.l2BlockSource,
      dateProvider: this.dateProvider,
      config: { skipSubmitProof: !!this.config.proverNodeDisableProofPublish },
      metrics: this.jobMetrics,
      bindings: this.log.getBindings(),
    });
    this.sessionManager = this.createSessionManager(this.publishingService);
    if (this.config.proverNodeDisableFullEpochProving) {
      this.log.info('Full epoch proving disabled: proving only the epochs requested through startProof', {
        proverNodeDisableFullEpochProving: true,
      });
    }
    this.sessionManager.start();
    this.jobMetrics.observeState(this.checkpointStore, this.sessionManager);

    // The follower decides where a restart resumes. The sweep treats every epoch up to that point as expired
    // already, so the two agree on which epochs are still in play.
    const resumeAfterEpoch = await this.checkpointFollower.start();
    this.expirySweep.start(resumeAfterEpoch);

    await this.rewardsMetrics.start();
    this.l1Metrics.start();
    this.log.info(`Started Prover Node with prover id ${this.prover.getProverId().toString()}`, this.config);
  }

  async stop() {
    this.log.info('Stopping ProverNode');
    this.jobMetrics.stopObservingState();
    await this.checkpointFollower.stop();
    await this.expirySweep.stop();
    if (this.sessionManager) {
      await this.sessionManager.stop();
    }
    if (this.publishingService) {
      // The publishing service waits for an L1 proof-submission tx that is in flight, which can outlast a
      // reasonable shutdown. On timeout the tx may still mine; shutdown moves on.
      const publishingService = this.publishingService;
      await executeTimeout(
        () => publishingService.stop(),
        PUBLISHING_SERVICE_STOP_TIMEOUT_MS,
        'prover-node publishing-service stop',
      ).catch(err => this.log.warn(`Timed out stopping proof publishing service`, err));
    }
    await this.checkpointStore.stop();
    this.chonkCache.stop();
    await this.prover.stop();
    await tryStop(this.publisherFactory);
    this.rewardsMetrics.stop();
    this.l1Metrics.stop();
    await this.telemetryClient.stop();
    this.log.info('Stopped ProverNode');
  }

  /** Constructs the session manager. Extracted so a test harness can swap the implementation. */
  protected createSessionManager(publishingService: ProofPublishingService): SessionManager {
    return new SessionManager({
      checkpointStore: this.checkpointStore,
      l2BlockSource: this.l2BlockSource,
      proverFactory: this.prover,
      proverId: this.prover.getProverId(),
      proofStatus: this.epochProofStatus,
      publishingService,
      metrics: this.jobMetrics,
      dateProvider: this.dateProvider,
      config: {
        maxPendingJobs: this.config.proverNodeMaxPendingJobs,
        tickIntervalMs: this.config.proverNodePollingIntervalMs,
        finalizationDelayMs: this.config.proverNodeEpochProvingDelayMs,
        disableFullEpochProving: !!this.config.proverNodeDisableFullEpochProving,
      },
      onSessionFailed: async session => {
        await this.tryUploadEpochFailure(session.getId(), session.getCheckpoints());
      },
      bindings: this.log.getBindings(),
    });
  }

  /**
   * Installs session hooks for the e2e harness to interpose around top-tree proving
   * (gate, override, or observe it) without monkey-patching the orchestrator factory.
   * Applies to every session constructed after this call.
   */
  public setSessionHooks(hooks: EpochSessionHooks): void {
    if (!this.sessionManager) {
      throw new Error('ProverNode not started; call start() before setting session hooks.');
    }
    this.sessionManager.setSessionHooks(hooks);
  }

  /**
   * Installs checkpoint-prover test hooks (e.g. forcing a sub-tree failure) applied to every
   * CheckpointProver constructed after this call. For the e2e harness only.
   */
  public setCheckpointHooks(hooks: CheckpointProverTestHooks): void {
    this.checkpointStore.setTestHooks(hooks);
  }

  /** Uploads the proving data of an epoch whose full session failed. Delegates to `FailureUploader`. */
  public tryUploadEpochFailure(id: string, checkpoints: readonly CheckpointProver[]): Promise<string | undefined> {
    return this.failureUploader.uploadEpochFailure(id, checkpoints);
  }

  /** Uploads the proving data of a single failed checkpoint prover. Delegates to `FailureUploader`. */
  public tryUploadCheckpointFailure(prover: CheckpointProver): Promise<string | undefined> {
    return this.failureUploader.uploadCheckpointFailure(prover);
  }

  private validateConfig() {
    if (
      this.config.proverNodeFailedEpochStore &&
      (!this.config.dataDirectory || !this.config.l1ChainId || this.config.rollupVersion === undefined)
    ) {
      this.log.warn(
        `Invalid prover-node config (missing dataDirectory, l1ChainId, or rollupVersion)`,
        pick(this.config, 'proverNodeFailedEpochStore', 'dataDirectory', 'l1ChainId', 'rollupVersion'),
      );
      throw new Error(
        'All of dataDirectory, l1ChainId, and rollupVersion are required if proverNodeFailedEpochStore is set.',
      );
    }
  }
}

// Re-export so handlers can compare states externally.
export { EpochProvingJobTerminalState };
