import type { AztecNodeConfig, AztecNodeService } from '@aztec-labs/aztec-node';
import type { TestAztecNodeService } from '@aztec-labs/aztec-node/test';
import type { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { unique } from '@aztec-labs/foundation/collection';
import { TimeoutError } from '@aztec-labs/foundation/error';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { OffenseType } from '@aztec-labs/slasher';
import { getSlotRangeForEpoch, getSlotStartBuildTimestamp } from '@aztec-labs/stdlib/epoch-helpers';
import { tryStop } from '@aztec-labs/stdlib/interfaces/server';
import type { ValidatorStatusInSlot } from '@aztec-labs/stdlib/validators';
import { jest } from '@jest/globals';
import 'jest-extended';

import {
  MultiNodeTestContext,
  SLASHER_ENABLED_MULTI_VALIDATOR_OPTS,
  buildMockGossipValidators,
  getProposerFixingSeed,
} from '../multi_node_test_context.js';
import { SENTINEL_TIMING, awaitCommitteeExists } from './setup.js';

/**
 * Exercises the sentinel's six-case proposer-status taxonomy end-to-end by driving each of the
 * status variants via in-tree validator-config flags (no jest stubbing of internals).
 *
 * Setup: MultiNodeTestContext on the in-memory mock-gossip bus (no real libp2p). 6 validators,
 * ethSlot=4s, aztecSlot=8s, epoch=2, proofSubEpochs=1024,
 * minTxsPerBlock=0, inboxLag=2, sentinelEnabled, fake prover.
 * Each it runs as an isolated CI job (parallel convention).
 *
 *   1. `checkpoint-unvalidated` (case 3) — one validator runs with `broadcastInvalidBlockProposal`,
 *      so honest observers reject its block proposals (state_mismatch) and never push them to
 *      their archivers. When the checkpoint proposal arrives, observers fail to load the last
 *      block → record `unvalidated`; the sentinel slashes the proposer for inactivity.
 *
 *   2. `checkpoint-invalid` (case 4) — one validator runs with
 *      `broadcastInvalidCheckpointProposalOnly`, so its block proposals stay valid (pushed to
 *      observers' archivers) but its checkpoint proposal carries a random epoch out hash. Observers
 *      load the last block, rebuild the checkpoint, find a header mismatch, and record `invalid`; the
 *      sentinel slashes the proposer for inactivity.
 *
 *   3. Successful re-execution + missing attestor (case 5) — all six validators start
 *      honest, then one is stopped mid-test. The stopped node misses its own proposer slots
 *      and stops attesting to others; the sentinel slashes it for inactivity.
 */

const TEST_TIMEOUT = 1_000_000;
jest.setTimeout(TEST_TIMEOUT);

const NUM_VALIDATORS = 6;
const COMMITTEE_SIZE = NUM_VALIDATORS;
// The body advances through real L2 slots at wall-clock pace, so the slot duration directly sets body
// time. SENTINEL_TIMING's 8s slot (eth 4s) uses the fast (mocked-p2p) operational budgets, which fit a
// checkpoint comfortably. proofSubEpochs=1024 disables reorg/proving deadlines and the only assertions
// are sentinel attestation/status records (no proving-window timing), so the fast profile is safe here;
// larger durations only add dead wall-clock without exercising new behavior.
const AZTEC_SLOT_DURATION = SENTINEL_TIMING.aztecSlotDuration;
const SLASHING_UNIT = BigInt(1e18);
const SLASHING_AMOUNT = SLASHING_UNIT * 3n;
const SLASHING_QUORUM = 3;
const SLASHING_ROUND_SIZE_IN_EPOCHS = 2;

describe('multi-node/slashing/sentinel_status_slash', () => {
  let test: MultiNodeTestContext;
  let nodes: AztecNodeService[] = [];
  let rollup: RollupContract;

  beforeEach(async () => {
    test = await MultiNodeTestContext.setup({
      // Sets every epoch up early, so a proposer slot that opens an epoch is not lost while the slot's committee is
      // unknown. Without it the malicious node can lose every proposal after its first one.
      keepEpochsSetUp: true,
      ...SLASHER_ENABLED_MULTI_VALIDATOR_OPTS,
      ...SENTINEL_TIMING,
      aztecTargetCommitteeSize: COMMITTEE_SIZE,
      blockDurationMs: 2000,
      aztecProofSubmissionEpochs: 1024,
      minTxsPerBlock: 0,
      // A single proposer-fault slot in an epoch gives missed/total = 1/6 ≈ 0.167; threshold
      // 0.1 lets that single fault trip inactivity.
      slashInactivityTargetPercentage: 0.1,
      slashInactivityConsecutiveEpochThreshold: 1,
      slashingQuorum: SLASHING_QUORUM,
      slashingRoundSizeInEpochs: SLASHING_ROUND_SIZE_IN_EPOCHS,
      slashAmountSmall: SLASHING_UNIT,
      slashAmountMedium: SLASHING_UNIT * 2n,
      slashAmountLarge: SLASHING_AMOUNT,
      slashInactivityPenalty: SLASHING_AMOUNT,
      slashSelfAllowed: true,
      // Sentinel evaluates an epoch's performance once this buffer has elapsed past its last slot.
      sentinelEpochEndBufferSlots: 2,
      // Suppress the BROADCASTED_INVALID_BLOCK_PROPOSAL slash so the only slashing signal in
      // tests 1 and 2 is the INACTIVITY offense from the sentinel.
      slashBroadcastedInvalidBlockPenalty: 0n,
      initialValidators: buildMockGossipValidators(NUM_VALIDATORS),
    });

    ({ rollup } = await test.getSlashingContracts());

    // Advance until the committee is populated.
    let epoch = EpochNumber(4);
    await retryUntil(
      async () => {
        await test.context.cheatCodes.rollup.advanceToEpoch(epoch);
        const committee = await rollup.getCurrentEpochCommittee();
        if (committee?.length === NUM_VALIDATORS) {
          return true;
        }
        epoch = EpochNumber(epoch + 1);
        return false;
      },
      'epoch with full committee',
      120,
      0,
    );
  });

  afterEach(async () => {
    nodes = [];
    await test.teardown();
  });

  // Cases 1 and 2 share the same body (spawn 1 malicious + 5 honest, warp near the malicious proposer
  // slot, assert observers agree on the fault status, malicious self-records a valid proposal, and an
  // INACTIVITY offense follows). They differ only in the malicious-node config flag and the fault status
  // observers record. Kept as unrolled its (no it.each) so each stays its own CI job under the parallel
  // convention. See {@link runProposerFaultScenario}.

  // broadcastInvalidBlockProposal: observers reject the block via re-execution state_mismatch and never
  // push it to their archivers, so the checkpoint proposal can't find its last block → `unvalidated`.
  it('slashes the proposer with INACTIVITY when checkpoint validation records unvalidated', () =>
    runProposerFaultScenario({
      maliciousOverride: { broadcastInvalidBlockProposal: true },
      expectedStatus: 'checkpoint-unvalidated',
    }));

  // broadcastInvalidCheckpointProposalOnly: block proposals stay valid (land in archivers) but the
  // checkpoint proposal carries a random epoch out hash → observers detect header_mismatch and record `invalid`.
  it('slashes the proposer with INACTIVITY when checkpoint validation records invalid', () =>
    runProposerFaultScenario({
      maliciousOverride: { broadcastInvalidCheckpointProposalOnly: true },
      expectedStatus: 'checkpoint-invalid',
    }));

  // Starts 6 honest validators, waits for the committee, then stops the last validator. Asserts that
  // all remaining observers record `attestation-missed` for the stopped node and that an INACTIVITY
  // offense is emitted for it.
  it('slashes an attestor that gets stopped after the network is running', async () => {
    nodes = await Promise.all(Array.from({ length: NUM_VALIDATORS }, (_, i) => test.createValidatorNodeAt(i)));

    await awaitCommitteeExists({ rollup, logger: test.logger });

    // Pick the last node as the one to stop so that target proposer rotation is unaffected.
    const targetIdx = NUM_VALIDATORS - 1;
    const targetAddress = nodes[targetIdx].getSequencer()!.validatorAddresses![0] as EthAddress;
    test.logger.warn(`Stopping node ${targetIdx} (validator ${targetAddress})`);
    await tryStop(nodes[targetIdx]);
    // Remove from the array so we do not double-stop it on teardown.
    nodes = nodes.filter((_, i) => i !== targetIdx);

    // All remaining nodes are honest observers.
    await assertAllObserversObservedAttestationMissed(nodes, targetAddress);
    await assertInactivityOffenseFor(targetAddress, nodes[0]);
  });

  // -- helpers ------------------------------------------------------------------------------

  /**
   * Runs a single-malicious-proposer fault scenario: spawns the malicious node (with the given config
   * override) and 5 honest observers, warps near the malicious proposer's slot, and asserts every honest
   * observer records `expectedStatus` at the discovered fault slot while the malicious node self-records
   * a valid proposal, then that an INACTIVITY offense follows. We discover the fault slot rather than
   * assuming it is the warped block-proposer slot: the re-execution outcome is keyed by the checkpoint
   * proposal's slot, which only closes a checkpoint (and so records the fault) on some proposer slots.
   */
  async function runProposerFaultScenario({
    maliciousOverride,
    expectedStatus,
  }: {
    maliciousOverride: Partial<AztecNodeConfig>;
    expectedStatus: ValidatorStatusInSlot;
  }): Promise<void> {
    const targetAddress = await spawnMaliciousAndHonestNodes(maliciousOverride);
    await warpToStagedTargetProposerSlot(targetAddress);
    // nodes[0] is the malicious node; honest observers are nodes[1..].
    const honestObservers = nodes.slice(1);
    const faultSlot = await findObservedStatusSlot(honestObservers, targetAddress, expectedStatus);
    await assertAllObserversSentinelStatus(honestObservers, targetAddress, faultSlot, [expectedStatus]);
    // The malicious node self-records a valid proposal for that slot using its locally computed archive (the
    // invalid-broadcast flags corrupt only the broadcast, not the proposer's local state). No honest node attests, so
    // the proposal never lands: it is `checkpoint-valid` when it built on a parent on L1, and `checkpoint-orphaned`
    // when its parent was missing from L1 or replaced there by the time the sentinel classified the slot, as happens
    // when it pipelined on the malicious node's own previous-slot proposal. The
    // fault slot is not always the malicious node's first proposal: when the observers do not all record the fault for
    // that one (for example, it went out before they were all up), the search moves on to a later slot, which may be
    // built on it.
    await assertAllObserversSentinelStatus([nodes[0]], targetAddress, faultSlot, [
      'checkpoint-valid',
      'checkpoint-orphaned',
    ]);
    await assertInactivityOffenseFor(targetAddress, nodes[1]);
  }

  /**
   * Spawns 1 malicious node at index 0 with the given config override, then `NUM_VALIDATORS - 1`
   * honest nodes at indices 1..N-1. Returns the malicious node's validator address.
   */
  async function spawnMaliciousAndHonestNodes(maliciousOverride: Partial<AztecNodeConfig>): Promise<EthAddress> {
    const maliciousNode = await test.createValidatorNodeAt(0, maliciousOverride);
    const targetAddress = maliciousNode.getSequencer()!.validatorAddresses![0] as EthAddress;
    test.logger.warn(`Malicious node validator address: ${targetAddress}`, { maliciousOverride });

    const honestNodes = await Promise.all(
      Array.from({ length: NUM_VALIDATORS - 1 }, (_, i) => test.createValidatorNodeAt(i + 1)),
    );

    nodes = [maliciousNode, ...honestNodes];

    await awaitCommitteeExists({ rollup, logger: test.logger });
    await test.monitor.waitUntilCheckpoint(CheckpointNumber(1));

    return targetAddress;
  }

  // A search budget: the target is the proposer of the staged epoch's second slot about one attempt in six.
  const MAX_STAGING_ATTEMPTS = 60;

  /**
   * Warps to a point where the malicious node is about to propose a slot that every honest observer can validate.
   *
   * An observer ignores proposals for a slot while its epoch cache reports the slot's committee as unstable, and a
   * cached unstable lookup can outlive the L1 block that fixes the seed. A warp that lands late in an epoch with no
   * randao write leaves the next epoch's seed to be fixed just as its proposers start building, so some observers drop
   * the target's proposal. Each attempt instead warps to the first slot of a staging epoch, fixes the seed of the epoch
   * after it, and takes a slot of that epoch where the target proposes only once every honest observer reports the
   * target as its proposer before the target can start building. The observers are checked rather than assumed to
   * recover within any particular time, and an attempt whose committee does not settle in time is abandoned.
   */
  async function warpToStagedTargetProposerSlot(targetAddress: EthAddress): Promise<void> {
    const cheatCodes = test.context.cheatCodes.rollup;
    const constants = test.epochCache.getL1Constants();
    const honestObservers = nodes.slice(1);
    for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt++) {
      const stagingEpoch = EpochNumber((await cheatCodes.getEpoch()) + 1);
      await cheatCodes.advanceToEpoch(stagingEpoch);
      // advanceToEpoch logs and swallows a failed warp.
      if ((await cheatCodes.getEpoch()) !== stagingEpoch) {
        test.logger.warn(`Warp to staging epoch ${stagingEpoch} did not land`, { attempt });
        continue;
      }
      const [firstSlot, lastSlot] = getSlotRangeForEpoch(EpochNumber(stagingEpoch + 1), constants);
      for (let slot = firstSlot; slot <= lastSlot; slot = SlotNumber(slot + 1)) {
        let proposer: EthAddress | undefined;
        try {
          proposer = await getProposerFixingSeed(test.epochCache, cheatCodes, slot);
        } catch (err) {
          if (!(err instanceof TimeoutError)) {
            throw err;
          }
          test.logger.warn(`Committee for slot ${slot} did not become stable, staging again`, { attempt });
          break;
        }
        if (!proposer?.equals(targetAddress)) {
          continue;
        }
        if (await allObserversKnowProposerBeforeBuildStart(honestObservers, slot, targetAddress)) {
          test.logger.warn(`Staged target proposer ${targetAddress} at slot ${slot}`, { attempt });
          return;
        }
        test.logger.warn(`Not every observer knew the proposer of slot ${slot} before its build start`, { attempt });
      }
    }
    throw new Error(`Could not stage target proposer ${targetAddress} in ${MAX_STAGING_ATTEMPTS} attempts`);
  }

  /**
   * Polls every observer's epoch cache until each reports `expectedProposer` for `slot`. Returns false if that does not
   * happen before the slot's proposer can start building it, which under pipelining is one L1 slot before the previous
   * L2 slot starts.
   */
  async function allObserversKnowProposerBeforeBuildStart(
    observerNodes: AztecNodeService[],
    slot: SlotNumber,
    expectedProposer: EthAddress,
  ): Promise<boolean> {
    const buildStartMs = getSlotStartBuildTimestamp(SlotNumber(slot - 1), test.epochCache.getL1Constants()) * 1000;
    while (test.context.dateProvider.now() < buildStartMs) {
      const lookups = await Promise.all(
        observerNodes.map(node => (node as TestAztecNodeService).epochCache.lookupProposer(slot)),
      );
      if (lookups.every(lookup => lookup.state === 'members' && lookup.proposer.equals(expectedProposer))) {
        // A lookup that resolved after the build start may have answered too late for the proposal.
        return test.context.dateProvider.now() < buildStartMs;
      }
      await sleep(200);
    }
    return false;
  }

  /**
   * Finds the earliest slot at which EVERY honest observer has recorded `expectedStatus` for
   * `targetAddress`. The slot at which the malicious node closes its checkpoint (and so the fault
   * is recorded) is not necessarily the block-proposer slot we warp to, so we discover it rather
   * than assuming it. Requiring cross-observer agreement avoids picking a slot that only one
   * observer saw (e.g. one peer happened to be synced to the malicious proposer's gossip earlier
   * than the others), which would then time out the downstream per-observer assertion. Times out
   * — and therefore fails the test — if no common fault slot is ever recorded, so a genuine
   * failure to detect the malicious proposal is still caught.
   */
  async function findObservedStatusSlot(
    observerNodes: AztecNodeService[],
    targetAddress: EthAddress,
    expectedStatus: ValidatorStatusInSlot,
  ): Promise<SlotNumber> {
    const slot = await retryUntil(
      async () => {
        const slotSets = await Promise.all(
          observerNodes.map(async observerNode => {
            const stats = await observerNode.getValidatorsStats();
            const history = stats.stats[targetAddress.toString()]?.history ?? [];
            return new Set(history.filter(h => h.status === expectedStatus).map(h => Number(h.slot)));
          }),
        );
        if (slotSets.some(s => s.size === 0)) {
          return undefined;
        }
        const [first, ...rest] = slotSets;
        const common = [...first].filter(s => rest.every(other => other.has(s))).sort((a, b) => a - b);
        return common.length > 0 ? SlotNumber(common[0]) : undefined;
      },
      `cross-observer ${expectedStatus} for ${targetAddress}`,
      AZTEC_SLOT_DURATION * 15,
    );
    return slot;
  }

  /**
   * Polls every given observer node until each has a sentinel record for the target at the given slot, and
   * asserts that the recorded status is one of `acceptedStatuses` on every observer.
   */
  async function assertAllObserversSentinelStatus(
    observerNodes: AztecNodeService[],
    targetAddress: EthAddress,
    slot: SlotNumber,
    acceptedStatuses: ValidatorStatusInSlot[],
  ): Promise<void> {
    for (const observerNode of observerNodes) {
      const status = await retryUntil(
        async () => {
          const stats = await observerNode.getValidatorsStats();
          const validator = stats.stats[targetAddress.toString()];
          const entry = validator?.history.find(h => Number(h.slot) === Number(slot));
          return entry?.status;
        },
        `sentinel status for ${targetAddress} at slot ${slot}`,
        AZTEC_SLOT_DURATION * 10,
      );
      expect(acceptedStatuses).toContain(status);
    }
    const recorded = acceptedStatuses.join(' or ');
    test.logger.warn(`All ${observerNodes.length} observers recorded ${recorded} for ${targetAddress} at slot ${slot}`);
  }

  /**
   * Polls every honest observer node until each one has at least one `attestation-missed` entry
   * for the target. Used by the stopped-attestor test where the slot of the miss is
   * non-deterministic.
   */
  async function assertAllObserversObservedAttestationMissed(
    observerNodes: AztecNodeService[],
    targetAddress: EthAddress,
  ): Promise<void> {
    for (const observerNode of observerNodes) {
      const slot = await retryUntil(
        async () => {
          const stats = await observerNode.getValidatorsStats();
          const validator = stats.stats[targetAddress.toString()];
          const miss = validator?.history.find(h => h.status === 'attestation-missed');
          return miss?.slot;
        },
        `attestation-missed entry for ${targetAddress}`,
        AZTEC_SLOT_DURATION * 20,
      );
      expect(slot).toBeDefined();
    }
    test.logger.warn(`All ${observerNodes.length} observers recorded attestation-missed for ${targetAddress}`);
  }

  /** Polls the given honest observer node until an INACTIVITY offense for the target appears. */
  async function assertInactivityOffenseFor(targetAddress: EthAddress, observerNode: AztecNodeService): Promise<void> {
    const offenses = await retryUntil(
      async () => {
        const collected = await observerNode.getSlashOffenses('all');
        const inactivityForTarget = collected.filter(
          o => o.offenseType === OffenseType.INACTIVITY && targetAddress.equals(o.validator),
        );
        return inactivityForTarget.length > 0 ? inactivityForTarget : undefined;
      },
      'inactivity offense for target',
      AZTEC_SLOT_DURATION * 40,
    );
    test.logger.warn(`Detected ${offenses.length} INACTIVITY offense(s) for ${targetAddress}`, { offenses });
    expect(unique(offenses.map(o => o.validator.toString()))).toEqual([targetAddress.toString()]);
    expect(unique(offenses.map(o => o.offenseType))).toEqual([OffenseType.INACTIVITY]);
  }
});
