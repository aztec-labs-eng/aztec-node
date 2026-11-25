import type { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { unique } from '@aztec-labs/foundation/collection';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { EpochProverFactory } from '@aztec-labs/prover-client';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import type { PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import {
  type L1RollupConstants,
  getProofSubmissionDeadlineTimestamp,
  getSlotRangeForEpoch,
} from '@aztec-labs/stdlib/epoch-helpers';
import type { EpochProvingJobState } from '@aztec-labs/stdlib/interfaces/server';

import type { CheckpointStore } from './checkpoint-store.js';
import type { EpochProofStatus } from './epoch-proof-status.js';
import { CheckpointProver } from './job/checkpoint-prover.js';
import {
  EpochSession,
  type EpochSessionDeps,
  type EpochSessionHooks,
  type EpochSessionOptions,
  type SessionSpec,
  specKey,
} from './job/epoch-session.js';
import type { ProverNodeJobMetrics } from './metrics.js';
import type { ProofPublishingService } from './proof-publishing-service.js';

/** Trigger payload for `reconcile`. */
export type ReconcileTrigger =
  | { kind: 'checkpoint'; epoch: EpochNumber }
  | { kind: 'prune'; affectedEpochs: EpochNumber[] }
  | { kind: 'tick' }
  | { kind: 'start-proof'; spec: SessionSpec };

/** Why a full session for an epoch cannot be opened right now. */
type FullSessionBlocker =
  | 'session-exists'
  | 'session-limit-reached'
  | 'epoch-incomplete'
  | 'deadline-passed'
  | 'checkpoint-prover-failed'
  | 'covered-epoch-waits-for-tick'
  | 'own-proof-registration-unavailable'
  | 'own-proof-already-on-l1'
  | 'archiver-has-no-checkpoints'
  | 'checkpoints-missing-from-store';

/** How a reconcile trigger may open a full session. */
type FullSessionOptions = {
  /** Whether an epoch the proven tip already covers may be opened. Only the tick sets this. */
  openCovered: boolean;
  /** Session slots to leave free for other work. */
  reservedSlots: number;
};

/** Config bag for session lifecycle decisions. */
export type SessionManagerConfig = {
  /** Cap on the number of non-terminal sessions (full + partial). 0 disables. */
  maxPendingJobs: number;
  /** Interval at which the internal periodic tick fires `reconcile({ kind: 'tick' })`. */
  tickIntervalMs: number;
  /** Forwarded to every session: delay before top-tree proving, letting late reorgs settle. */
  finalizationDelayMs: number | undefined;
  /**
   * Never open full sessions on our own; prove only the epochs requested through `startProof`. For a prover
   * that serves paid partial-epoch proofs without competing for full epochs.
   */
  disableFullEpochProving?: boolean;
};

export type SessionManagerDeps = {
  checkpointStore: CheckpointStore;
  l2BlockSource: Pick<L2BlockSource, 'isEpochComplete' | 'getCheckpoints' | 'getCheckpoint' | 'getL1Constants'>;
  proverFactory: EpochProverFactory;
  proverId: EthAddress;
  /** Read to tell which epochs the proven tip covers and whether this prover holds a full-epoch proof of them. */
  proofStatus: Pick<EpochProofStatus, 'isBlockProven' | 'getNextUnprovenEpoch' | 'readOwnFullEpochProof'>;
  publishingService: ProofPublishingService;
  metrics: ProverNodeJobMetrics;
  dateProvider: DateProvider;
  config: SessionManagerConfig;
  /**
   * Fired once when a full session ends in its own genuine failure (`EpochSession.hasFailed()` — top-tree
   * or submit failed with every prover healthy). The owner uploads a post-mortem here. Not fired for a
   * `stopped` session (a prover under it failed — possibly a prune), which is recovered on re-add instead.
   */
  onSessionFailed?: (session: EpochSession) => Promise<void>;
  bindings?: LoggerBindings;
};

/**
 * Owns the lifecycle of every `EpochSession`. Each L2BlockStream event and periodic tick
 * arrives via a dedicated entry point (`onCheckpointAdded`, `onPrune`, `onTick`, etc.) which
 * schedules a `reconcile(trigger)` on a serial queue. Reconcile walks both session
 * maps, cancels any session whose canonical content has shifted, re-creates it with
 * the same spec but new content, and opens fresh full sessions for any epoch implicated
 * by the trigger.
 */
export class SessionManager {
  private readonly log: Logger;
  private readonly fullSessions: Map<EpochNumber, EpochSession> = new Map();
  private readonly partialSessions: Map<string, EpochSession> = new Map();
  /**
   * Serialises every reconcile call. The trigger sources (chain events, the periodic tick, `startProof`) run
   * independently, and a reconcile awaits archiver and L1 reads between looking at the session maps and changing
   * them. Without this queue two reconciles could open a session for the same epoch.
   */
  private readonly reconcileQueue = new SerialQueue();
  /** Cached L1 constants, populated on first read. */
  private cachedL1Constants: L1RollupConstants | undefined;
  /** Test-only hooks applied to every session this manager constructs. */
  private sessionHooks: EpochSessionHooks | undefined;
  /** Periodic tick that nudges reconcile to pick up newly-complete epochs. Started by `start()`. */
  private epochTicker: RunningPromise | undefined;

  constructor(private readonly deps: SessionManagerDeps) {
    this.log = createLogger('prover-node:session-manager', deps.bindings);
    this.reconcileQueue.start();
  }

  /**
   * Starts the periodic tick. Separated from the constructor so tests can drive `onTick()`
   * manually without the background ticker interleaving. Idempotent.
   */
  public start(): void {
    if (this.epochTicker) {
      return;
    }
    this.epochTicker = new RunningPromise(() => this.onTick(), this.log, this.deps.config.tickIntervalMs);
    this.epochTicker.start();
  }

  /**
   * Installs hooks applied to every session constructed from now on. Used by the e2e
   * harness to interpose around top-tree proving (gate it, override it, observe it)
   * without monkey-patching the orchestrator factory.
   */
  public setSessionHooks(hooks: EpochSessionHooks): void {
    this.sessionHooks = hooks;
  }

  // ---------------- read-only views ----------------

  /** Every session the manager holds: the running ones, and finished ones that have not been dropped. */
  public allSessions(): EpochSession[] {
    return [...this.fullSessions.values(), ...this.partialSessions.values()];
  }

  /** Returns the full session for `epoch`, if any. */
  public getFullSession(epoch: EpochNumber): EpochSession | undefined {
    return this.fullSessions.get(epoch);
  }

  /** Returns the partial session for `spec`, if any. */
  public getPartialSession(spec: SessionSpec): EpochSession | undefined {
    return this.partialSessions.get(specKey(spec));
  }

  /** Observability summary used by the prover-node API. */
  public getJobs(): { uuid: string; status: EpochProvingJobState; epochNumber: EpochNumber }[] {
    return this.allSessions().map(s => ({
      uuid: s.getId(),
      status: s.getState(),
      epochNumber: s.getEpochNumber(),
    }));
  }

  // ---------------- event entry points ----------------

  /** Called when a checkpoint of the epoch is in the store: newly registered, or seen again on a retry. */
  public onCheckpointAdded(epoch: EpochNumber): Promise<void> {
    return this.scheduleReconcile({ kind: 'checkpoint', epoch });
  }

  /** Called after a prune has removed provers of these epochs from the store. */
  public onPrune(affectedEpochs: EpochNumber[]): Promise<void> {
    return this.scheduleReconcile({ kind: 'prune', affectedEpochs });
  }

  /**
   * Called by the periodic tick that `start()` arms. Picks up epochs that have become complete
   * by time without a fresh checkpoint event (e.g. the epoch's last slots are empty), and
   * advances to the next epoch once the previous one is proven on L1. Also revisits epochs the
   * proven tip already covers, which this prover still proves if it holds no full-epoch proof of them.
   */
  public onTick(): Promise<void> {
    return this.scheduleReconcile({ kind: 'tick' });
  }

  // ---------------- public API ----------------

  /**
   * Schedules a proof attempt for the supplied epoch and returns the job id without waiting for
   * the proof to complete — proving can far outlast an HTTP request, so callers poll `getJobs()`
   * for the outcome. Every session — full or partial — begins at the epoch's first slot; the
   * partial's spec stops at the last canonical slot, while the full's stops at the epoch's last
   * slot. Dedupes against any existing session covering the same range, returning its id.
   */
  public async startProof(epoch: EpochNumber): Promise<string> {
    const canonical = await this.deps.checkpointStore.listForEpoch(epoch);
    if (canonical.length === 0) {
      throw new EmptyEpochError(epoch);
    }
    // Don't re-prove an epoch the L1 proven chain already encompasses — it was already proven
    // (possibly by another prover node), so a fresh proof would be wasted work.
    if (await this.isProvenChainEncompassing(canonical)) {
      throw new EpochAlreadyProvenError(epoch);
    }
    const l1Constants = await this.getL1Constants();
    const [fromSlot] = getSlotRangeForEpoch(epoch, l1Constants);
    const toSlot = canonical[canonical.length - 1].slotNumber;
    const spec: SessionSpec = { kind: 'partial', epochNumber: epoch, fromSlot, toSlot };

    // Reuse a session already covering this exact range rather than scheduling a duplicate.
    const existingFull = this.getFullSession(epoch);
    if (
      existingFull &&
      !existingFull.isTerminal() &&
      existingFull.getSpec().fromSlot === fromSlot &&
      existingFull.getSpec().toSlot === toSlot
    ) {
      return existingFull.getId();
    }
    const existingPartial = this.getPartialSession(spec);
    if (existingPartial && !existingPartial.isTerminal()) {
      return existingPartial.getId();
    }

    await this.scheduleReconcile({ kind: 'start-proof', spec });
    const created = this.getPartialSession(spec);
    if (!created) {
      throw new Error(`Failed to schedule partial proof for epoch ${epoch}`);
    }
    return created.getId();
  }

  /** Stops the tick, drains the reconcile queue, and cancels every live session. */
  public async stop(): Promise<void> {
    await this.epochTicker?.stop();
    await this.reconcileQueue.cancel();
    const sessions = this.allSessions();
    // A clean shutdown is just a restart, so preserve the in-flight broker jobs (abortJobs: false)
    // for the restarted node to reuse rather than re-proving the epoch from scratch.
    await Promise.allSettled(sessions.map(s => s.cancel('prover-node stopping', { abortJobs: false })));
  }

  // ---------------- reconcile ----------------

  private scheduleReconcile(trigger: ReconcileTrigger): Promise<void> {
    return this.reconcileQueue.put(() => this.reconcile(trigger));
  }

  private async reconcile(trigger: ReconcileTrigger): Promise<void> {
    this.log.debug(`Reconciling`, { trigger });

    this.replaceInvalidSessions();

    if (!this.deps.config.disableFullEpochProving) {
      if (trigger.kind === 'tick') {
        await this.openFullSessionsOnTick();
      } else {
        for (const epoch of this.epochsForTrigger(trigger)) {
          await this.openFullSessionIfReady(epoch, { openCovered: false, reservedSlots: 0 });
        }
      }
    }

    if (trigger.kind === 'start-proof') {
      this.openPartialSession(trigger.spec);
    }
  }

  /**
   * Brings the existing sessions in line with the store. A session proves a fixed list of checkpoints, so when the
   * store's checkpoints for its slot range change, the session is cancelled and a new one takes its place.
   */
  private replaceInvalidSessions(): void {
    this.replaceInvalidSessionsIn(this.fullSessions);
    this.replaceInvalidSessionsIn(this.partialSessions);
  }

  private replaceInvalidSessionsIn<K>(sessions: Map<K, EpochSession>): void {
    for (const [key, session] of Array.from(sessions.entries())) {
      // A finished partial session is dropped whatever the store holds, so its checkpoints are not looked up.
      if (session.isTerminal() && session.getKind() !== 'full') {
        sessions.delete(key);
        continue;
      }
      const current = this.checkpointsForSpec(session.getSpec());
      const verdict = this.judgeSession(session, current);
      if (verdict === 'keep') {
        continue;
      }
      if (!session.isTerminal()) {
        this.fireAndForgetCancel(session, 'canonical content changed');
      }
      sessions.delete(key);
      if (verdict === 'replace') {
        const replacement = this.constructSession(session.getSpec(), current);
        sessions.set(key, replacement);
        void this.runSession(replacement);
      }
    }
  }

  /**
   * Decides what happens to a session, given the store's current checkpoints for its slot range.
   *
   * | Session                                | Checkpoints unchanged | Checkpoints changed |
   * | -------------------------------------- | --------------------- | ------------------- |
   * | Still running                          | keep                  | replace             |
   * | Full, ended `completed` or `failed`    | keep                  | replace             |
   * | Full, ended in any other state         | drop                  | replace             |
   * | Partial, ended in any state            | drop                  | drop                |
   *
   * A full session that completed is kept because the archiver's proven tip can lag the submission, and without the
   * session the tick would prove the epoch again. One that failed with healthy provers is kept so the same checkpoints
   * are not proven again to the same failure. "Replace" becomes "drop" when no session can be built over the new
   * checkpoints; a dropped full session is opened again later by the normal rules for opening one.
   */
  private judgeSession(session: EpochSession, current: readonly CheckpointProver[]): 'keep' | 'drop' | 'replace' {
    const isFull = session.getKind() === 'full';
    if (this.checkpointsMatch(session.getCheckpoints(), current)) {
      if (!session.isTerminal()) {
        return 'keep';
      }
      return isFull && (session.getState() === 'completed' || session.hasFailed()) ? 'keep' : 'drop';
    }
    if (session.isTerminal() && !isFull) {
      return 'drop';
    }
    return this.canBuildOver(current) ? 'replace' : 'drop';
  }

  /** A session may be built over a checkpoint set only when it is non-empty and contains no failed prover. */
  private canBuildOver(canonical: readonly CheckpointProver[]): boolean {
    return canonical.length > 0 && !this.hasFailedProver(canonical);
  }

  /** Opens a full session for the epoch unless something blocks it. A later reconcile tries again. */
  private async openFullSessionIfReady(epoch: EpochNumber, opts: FullSessionOptions): Promise<void> {
    const result = await this.checkFullSession(epoch, opts);
    if ('blocker' in result) {
      // These two hold for most epochs on most ticks, so logging them would drown the others.
      if (result.blocker !== 'session-exists' && result.blocker !== 'epoch-incomplete') {
        this.log.debug(`Not opening a full session for epoch ${epoch}: ${result.blocker}`, { epoch, ...result });
      }
      return;
    }
    const session = this.constructSession(result.spec, result.checkpoints);
    this.fullSessions.set(epoch, session);
    void this.runSession(session);
  }

  /**
   * Returns the checkpoints a full session for the epoch would prove, or the first reason it cannot be opened now.
   * Every check that can reject the epoch from the store and the cached registration read runs before the epoch's
   * checkpoints are loaded from the archiver: a covered epoch that stays stored without a session is visited on
   * every tick, and a restart catch-up registers one checkpoint at a time.
   */
  private async checkFullSession(
    epoch: EpochNumber,
    opts: FullSessionOptions,
  ): Promise<
    | { blocker: FullSessionBlocker; archiverCount?: number; storeCount?: number }
    | { spec: SessionSpec; checkpoints: CheckpointProver[] }
  > {
    // A session present here is running, or is a finished session kept by `judgeSession`.
    if (this.fullSessions.has(epoch)) {
      return { blocker: 'session-exists' };
    }
    if (this.atMaxSessionLimit(opts.reservedSlots)) {
      return { blocker: 'session-limit-reached' };
    }
    if (!(await this.deps.l2BlockSource.isEpochComplete(epoch))) {
      return { blocker: 'epoch-incomplete' };
    }
    const l1Constants = await this.getL1Constants();
    const deadline = this.computeDeadline(epoch);
    if (deadline && deadline.getTime() <= this.deps.dateProvider.now()) {
      // L1 no longer accepts a proof of the epoch. Its checkpoints stay in the store until the expiry sweep.
      return { blocker: 'deadline-passed' };
    }
    const [fromSlot, toSlot] = getSlotRangeForEpoch(epoch, l1Constants);
    const checkpoints = this.deps.checkpointStore.listInSlotRange(fromSlot, toSlot);
    if (this.hasFailedProver(checkpoints)) {
      // A session over a failed prover would fail at once. The epoch recovers when a prune and re-registration
      // replace the prover.
      return { blocker: 'checkpoint-prover-failed' };
    }
    // The proven tip can cover an epoch for which this prover holds no full-epoch proof: a proof landed while the
    // epoch was still open, which L1 registers as non-full. L1 still accepts and rewards our full-epoch proof until
    // the submission window closes, so the tip alone does not make the epoch done. While the store holds only part
    // of the epoch, the registration is read with the wrong count; the archiver comparison below then blocks.
    if (checkpoints.length > 0 && (await this.isProvenChainEncompassing(checkpoints))) {
      if (!opts.openCovered) {
        return { blocker: 'covered-epoch-waits-for-tick' };
      }
      const registered = await this.deps.proofStatus.readOwnFullEpochProof(epoch, checkpoints.length);
      if (registered === undefined) {
        return { blocker: 'own-proof-registration-unavailable' };
      }
      if (registered) {
        return { blocker: 'own-proof-already-on-l1' };
      }
    }
    const archiverCps = await this.deps.l2BlockSource.getCheckpoints({ epoch });
    if (archiverCps.length === 0) {
      return { blocker: 'archiver-has-no-checkpoints' };
    }
    if (!this.archiverFullyCovered(archiverCps, checkpoints)) {
      return {
        blocker: 'checkpoints-missing-from-store',
        archiverCount: archiverCps.length,
        storeCount: checkpoints.length,
      };
    }
    return { spec: { kind: 'full', epochNumber: epoch, fromSlot, toSlot }, checkpoints };
  }

  private openPartialSession(spec: SessionSpec): void {
    const canonical = this.deps.checkpointStore.listInSlotRange(spec.fromSlot, spec.toSlot);
    if (canonical.length === 0 || this.hasFailedProver(canonical)) {
      return;
    }
    // Reuse a live partial session for this epoch whose checkpoint set already matches the
    // canonical content — e.g. a repeated `startProof` with no new checkpoints mined since the
    // last one. Reconstructing would re-prove identical content and burn a pending-job slot.
    const existing = Array.from(this.partialSessions.values()).find(
      s =>
        s.getSpec().epochNumber === spec.epochNumber &&
        !s.isTerminal() &&
        this.checkpointsMatch(s.getCheckpoints(), canonical),
    );
    if (existing) {
      return;
    }
    if (this.atMaxSessionLimit()) {
      throw new Error(`Maximum pending proving jobs ${this.deps.config.maxPendingJobs} reached.`);
    }
    const session = this.constructSession(spec, canonical);
    this.partialSessions.set(specKey(spec), session);
    void this.runSession(session);
  }

  // ---------------- session construction ----------------

  protected constructSession(spec: SessionSpec, checkpoints: readonly CheckpointProver[]): EpochSession {
    return this.doConstructSession(spec, checkpoints, this.buildSessionDeps(spec.epochNumber), this.sessionHooks);
  }

  /** Extracted for test override. */
  protected doConstructSession(
    spec: SessionSpec,
    checkpoints: readonly CheckpointProver[],
    sessionDeps: EpochSessionDeps,
    hooks?: EpochSessionHooks,
  ): EpochSession {
    return new EpochSession(spec, checkpoints, { ...sessionDeps, hooks });
  }

  private buildSessionDeps(epochNumber: EpochNumber): EpochSessionDeps {
    const config: EpochSessionOptions = {
      finalizationDelayMs: this.deps.config.finalizationDelayMs,
    };
    return {
      proverFactory: this.deps.proverFactory,
      proverId: this.deps.proverId,
      publishingService: this.deps.publishingService,
      l2BlockSource: this.deps.l2BlockSource,
      metrics: this.deps.metrics,
      dateProvider: this.deps.dateProvider,
      deadline: this.computeDeadline(epochNumber),
      config,
      bindings: this.deps.bindings,
    };
  }

  private computeDeadline(epochNumber: EpochNumber): Date | undefined {
    if (!this.cachedL1Constants) {
      return undefined;
    }
    const ts = getProofSubmissionDeadlineTimestamp(epochNumber, this.cachedL1Constants);
    return new Date(Number(ts) * 1000);
  }

  private async runSession(session: EpochSession): Promise<void> {
    // A reconcile may have cancelled this session before it starts (content-change
    // recreation). Don't proceed — start() would build a TopTreeJob that should never run.
    if (session.isTerminal()) {
      this.log.debug(`Skipping start for ${session.getId()}: already terminal (${session.getState()})`);
      return;
    }
    const state = await session.start();
    this.log.info(`Session ${session.getId()} exited with state ${state}`);

    // A full session that ended `failed` had healthy provers, so the failure was not caused by a prune. Its
    // data is uploaded once: `judgeSession` keeps the session, so the same checkpoints are not run again. A
    // `stopped` session may have failed because of a prune and is not uploaded.
    if (session.getKind() === 'full' && session.hasFailed() && this.deps.onSessionFailed) {
      try {
        await this.deps.onSessionFailed(session);
      } catch (err) {
        this.log.error(`Error in onSessionFailed callback for epoch ${session.getEpochNumber()}`, err);
      }
    }
  }

  // ---------------- reconcile helpers ----------------

  /** True when the live sessions, plus `reservedSlots` kept free, reach `maxPendingJobs`. */
  private atMaxSessionLimit(reservedSlots = 0): boolean {
    const { maxPendingJobs: max } = this.deps.config;
    if (!max || max <= 0) {
      return false;
    }
    const live = this.allSessions().filter(s => !s.isTerminal()).length;
    return live + reservedSlots >= max;
  }

  /**
   * Opens full sessions on the periodic tick: the next unproven epoch first, then every epoch in the store that the
   * proven tip already covers, which only earn this prover its reward. While the next unproven epoch is complete but
   * has no session, for whatever reason (its checkpoints are still being registered, no slot was free, or a slot freed
   * during this tick), one session slot stays free for it. A failed checkpoint prover blocks the next epoch until a
   * prune/re-add replaces it, so it does not hold a slot meanwhile.
   *
   * The tick does not track prior attempts. `openFullSessionIfReady` skips a covered epoch once our own full-epoch
   * proof of it is on L1. It is also what keeps this from re-proving a doomed epoch: it refuses to build a session
   * when any checkpoint prover in the set has failed, so a stuck epoch is cheaply skipped each tick rather than
   * re-proved.
   */
  private async openFullSessionsOnTick(): Promise<void> {
    const next = await this.deps.proofStatus.getNextUnprovenEpoch();
    if (next !== undefined) {
      await this.openFullSessionIfReady(next, { openCovered: true, reservedSlots: 0 });
    }
    const nextNeedsSlot =
      next !== undefined &&
      !this.fullSessions.has(next) &&
      !this.hasFailedProver(this.checkpointsInEpoch(next, await this.getL1Constants())) &&
      (await this.deps.l2BlockSource.isEpochComplete(next));
    const reservedSlots = nextNeedsSlot ? 1 : 0;
    for (const epoch of this.storedEpochs()) {
      if (next === undefined || epoch < next) {
        await this.openFullSessionIfReady(epoch, { openCovered: true, reservedSlots });
      }
    }
  }

  /**
   * Maps a checkpoint or prune trigger to the epochs whose full session should be (re)opened. Both fire when an
   * epoch's canonical content changes (a checkpoint arrives, or a reorg prunes/replaces one) — which is what installs
   * a fresh prover in place of a failed one, letting the next open succeed and recovering a pruned-then-re-added
   * epoch.
   */
  private epochsForTrigger(trigger: Exclude<ReconcileTrigger, { kind: 'tick' }>): EpochNumber[] {
    switch (trigger.kind) {
      case 'checkpoint':
        return [trigger.epoch];
      case 'prune':
        return trigger.affectedEpochs;
      case 'start-proof':
        return [];
    }
  }

  /** Distinct epochs with checkpoints in the store, ascending. The store drops an epoch once its window closes. */
  private storedEpochs(): EpochNumber[] {
    return unique(this.deps.checkpointStore.list().map(p => p.epochNumber));
  }

  private checkpointsInEpoch(epoch: EpochNumber, l1Constants: L1RollupConstants): CheckpointProver[] {
    const [fromSlot, toSlot] = getSlotRangeForEpoch(epoch, l1Constants);
    return this.deps.checkpointStore.listInSlotRange(fromSlot, toSlot);
  }

  private checkpointsForSpec(spec: SessionSpec): CheckpointProver[] {
    return this.deps.checkpointStore.listInSlotRange(spec.fromSlot, spec.toSlot);
  }

  /**
   * True if any prover in the set has failed. The epoch cannot be proven over a failed prover (it can
   * never produce its block proofs), so a session must not be built or rebuilt over it until a prune/re-add
   * has replaced it with a fresh prover.
   */
  private hasFailedProver(checkpoints: readonly CheckpointProver[]): boolean {
    return checkpoints.some(c => c.isFailed());
  }

  private fireAndForgetCancel(session: EpochSession, reason: string): void {
    void session.cancel(reason).catch(err => this.log.warn(`Error cancelling session ${session.getId()}`, err));
  }

  private checkpointsMatch(a: readonly CheckpointProver[], b: readonly CheckpointProver[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].isCancelled()) {
        return false;
      }
    }
    return true;
  }

  private archiverFullyCovered(
    archiverCps: readonly PublishedCheckpoint[],
    storeCps: readonly CheckpointProver[],
  ): boolean {
    if (storeCps.length < archiverCps.length) {
      return false;
    }
    // Compare by content-addressed id (number, slot, archive root) rather than checkpoint number:
    // a reorg can keep the number while changing the checkpoint's post-state archive root.
    const storeIds = new Set(storeCps.map(p => p.id));
    return archiverCps.every(cp => storeIds.has(CheckpointProver.idFor(cp.checkpoint)));
  }

  /**
   * Returns true if the L1 proven tip already covers every canonical checkpoint in the set. It says nothing about who
   * proved them: callers decide whether a covered set still needs a proof from this prover. Conservatively returns
   * false when nothing is proven yet.
   */
  private isProvenChainEncompassing(canonical: readonly CheckpointProver[]): Promise<boolean> {
    const lastCheckpoint = canonical[canonical.length - 1].checkpoint;
    const lastBlock = lastCheckpoint.blocks[lastCheckpoint.blocks.length - 1].number;
    return this.deps.proofStatus.isBlockProven(lastBlock);
  }

  private async getL1Constants(): Promise<L1RollupConstants> {
    if (!this.cachedL1Constants) {
      this.cachedL1Constants = await this.deps.l2BlockSource.getL1Constants();
    }
    return this.cachedL1Constants;
  }
}

class EmptyEpochError extends Error {
  constructor(epochNumber: EpochNumber) {
    super(`No blocks found for epoch ${epochNumber}`);
    this.name = 'EmptyEpochError';
  }
}

class EpochAlreadyProvenError extends Error {
  constructor(epochNumber: EpochNumber) {
    super(`Epoch ${epochNumber} is already proven on L1`);
    this.name = 'EpochAlreadyProvenError';
  }
}
