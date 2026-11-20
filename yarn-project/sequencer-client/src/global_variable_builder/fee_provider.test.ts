import { getPublicClient } from '@aztec-labs/ethereum/client';
import { DefaultL1ContractsConfig } from '@aztec-labs/ethereum/config';
import { MULTI_CALL_3_ADDRESS, RollupContract, TempCheckpointLogField } from '@aztec-labs/ethereum/contracts';
import { deployAztecL1Contracts } from '@aztec-labs/ethereum/deploy-aztec-l1-contracts';
import {
  type Anvil,
  EthCheatCodes,
  type RecordedRpcRequest,
  type RecordingRpcServer,
  RollupCheatCodes,
  describeWithAnvil,
  startAnvil,
  startRecordingRpcServer,
} from '@aztec-labs/ethereum/test';
import type { ViemClient, ViemPublicClient } from '@aztec-labs/ethereum/types';
import { maxBigint } from '@aztec-labs/foundation/bigint';
import { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryFastUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { ManualDateProvider } from '@aztec-labs/foundation/timer';
import { type ArchiverEmitter, type L1SyncPoint, L2BlockSourceEvents } from '@aztec-labs/stdlib/block';
import { getNextL1SlotTimestamp, getSlotAtNextL1Block, getTimestampForSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { FEE_ORACLE_LAG, GasFees, ManaUsageEstimate, computeExcessMana } from '@aztec-labs/stdlib/gas';
import { EventEmitter } from 'events';
import { foundry } from 'viem/chains';

import { computeFeePredictions } from './fee_predictor.js';
import { FeeProviderImpl } from './fee_provider.js';
import type { GlobalVariableBuilderConfig } from './global_builder.js';

describeWithAnvil('FeeProviderImpl', () => {
  let anvil: Anvil;
  let rpcUrl: string;
  /** Sits between the providers under test and anvil, recording every request they send. */
  let server: RecordingRpcServer;
  /** Requests through the recording server wait on this before they are forwarded to anvil. */
  let gate: Promise<void>;
  /** While set, the recording server fails every request instead of forwarding it. */
  let l1Down: boolean;
  let publicClient: ViemClient;
  let providerClient: ViemPublicClient;
  let cheatCodes: EthCheatCodes;
  let rollupCheatCodes: RollupCheatCodes;
  let rollup: RollupContract;
  let config: GlobalVariableBuilderConfig;
  let dateProvider: ManualDateProvider;
  let events: ArchiverEmitter;
  let syncPoint: L1SyncPoint | undefined;
  let providers: FeeProviderImpl[];
  let snapshotId: string;

  beforeAll(async () => {
    const privateKeyRaw = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
    ({ anvil, rpcUrl } = await startAnvil({ port: 0 }));
    publicClient = getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id });
    dateProvider = new ManualDateProvider();
    cheatCodes = new EthCheatCodes([rpcUrl], dateProvider);

    const deployed = await deployAztecL1Contracts(rpcUrl, privateKeyRaw, foundry.id, {
      ...DefaultL1ContractsConfig,
      vkTreeRoot: Fr.random(),
      protocolContractsHash: Fr.random(),
      genesisArchiveRoot: Fr.random(),
      realVerifier: false,
    });
    rollup = new RollupContract(publicClient, deployed.l1ContractAddresses.rollupAddress.toString());
    rollupCheatCodes = RollupCheatCodes.create([rpcUrl], deployed.l1ContractAddresses, dateProvider);
    config = {
      rollupAddress: deployed.l1ContractAddresses.rollupAddress,
      ethereumSlotDuration: DefaultL1ContractsConfig.ethereumSlotDuration,
      rollupVersion: await rollup.getVersion(),
      slotDuration: await rollup.getSlotDuration(),
      l1GenesisTime: await rollup.getL1GenesisTime(),
    };

    server = await startRecordingRpcServer({
      forwardTo: rpcUrl,
      answer: async (_method, forward) => {
        await gate;
        if (l1Down) {
          throw new Error('L1 is down');
        }
        return forward();
      },
    });
    providerClient = getPublicClient({ l1RpcUrls: [server.url], l1ChainId: foundry.id });
    // Move past genesis, so slots before and after the clock exist for the scenarios below.
    await rollupCheatCodes.advanceSlots(4);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await anvil?.stop().catch(err => createLogger('cleanup').error(`Error stopping anvil`, err));
  });

  beforeEach(async () => {
    gate = Promise.resolve();
    l1Down = false;
    events = new EventEmitter() as ArchiverEmitter;
    providers = [];
    snapshotId = await cheatCodes.rpcCall('evm_snapshot', []);
    await syncToL1Head();
  });

  afterEach(async () => {
    gate = Promise.resolve();
    l1Down = false;
    await Promise.all(providers.map(provider => provider.stop()));
    await cheatCodes.rpcCall('evm_revert', [snapshotId]);
  });

  /** Points the sync point at L1's head and the node clock at its timestamp, as an archiver pass would. */
  const syncToL1Head = async (): Promise<L1SyncPoint> => {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    syncPoint = { blockNumber: block.number, blockHash: Buffer32.fromString(block.hash) };
    dateProvider.setTime(Number(block.timestamp) * 1000);
    return syncPoint;
  };

  /** Mines a block and points the sync point at it. */
  const mineAndSync = async () => {
    await cheatCodes.mine();
    return await syncToL1Head();
  };

  const makeProvider = () => {
    const provider = new FeeProviderImpl(dateProvider, providerClient, config, {
      getL1SyncPoint: () => Promise.resolve(syncPoint),
      events,
    });
    providers.push(provider);
    return provider;
  };

  /** Starts a provider whose loop never ticks during a test, so only the test and the provider's events drive it. */
  const startProvider = async () => {
    const provider = makeProvider();
    await provider.start(60_000);
    return provider;
  };

  const requestsDuring = async (fn: () => Promise<unknown>): Promise<RecordedRpcRequest[]> => {
    const from = server.requests.length;
    await fn();
    return server.requests.slice(from);
  };

  const isMulticall = (request: RecordedRpcRequest) =>
    request.method === 'eth_call' &&
    (request.params[0] as { to?: string }).to?.toLowerCase() === MULTI_CALL_3_ADDRESS.toLowerCase();

  const announce = (l1SyncPoint: L1SyncPoint) =>
    events.emit(L2BlockSourceEvents.L1SyncPointUpdated, { type: 'l1SyncPointUpdated', l1SyncPoint });

  /** Raises the pending checkpoint's excess mana, which moves every fee the provider serves. */
  const raisePendingExcessMana = async () => {
    const pending = await rollup.getCheckpointNumber();
    const { feeHeader } = await rollup.getCheckpoint(pending);
    const feeHeaderSlot = await rollup.getTempCheckpointLogStorageSlot(pending, TempCheckpointLogField.FeeHeader);
    const raised = { ...feeHeader, excessMana: feeHeader.excessMana + 10n * (await rollup.getManaTarget()) };
    await cheatCodes.store(
      EthAddress.fromString(rollup.address),
      feeHeaderSlot,
      RollupContract.compressFeeHeader(raised),
    );
  };

  /** Lands the next checkpoint at the current L1 slot, carrying the pending checkpoint's fee header. */
  const landCheckpoint = async () => {
    const pending = await rollup.getCheckpointNumber();
    const { feeHeader } = await rollup.getCheckpoint(pending);
    await rollupCheatCodes.setPendingCheckpoint(CheckpointNumber.add(pending, 1), await rollup.getSlotNumber(), {
      ...feeHeader,
      excessMana: feeHeader.excessMana + 2n * (await rollup.getManaTarget()),
    });
  };

  /** Lands a checkpoint and lets its proof window lapse, so L1 can prune it from then on. */
  const makePrunable = async () => {
    await landCheckpoint();
    const epochDuration = await rollup.getEpochDuration();
    await rollupCheatCodes.advanceSlots(epochDuration * ((await rollup.getProofSubmissionEpochs()) + 2));
    const { timestamp } = await publicClient.getBlock({ blockTag: 'latest' });
    expect(await rollup.canPruneAtTime(timestamp)).toBe(true);
  };

  /** Prunes the unproven checkpoints the way L1 does, rolling the pending tip back to the proven one. */
  const prune = async () => {
    const { proven } = await rollupCheatCodes.getTips();
    await cheatCodes.store(
      EthAddress.fromString(rollup.address),
      RollupContract.chainTipsStorageSlot,
      RollupContract.packChainTips(BigInt(proven), BigInt(proven)),
    );
  };

  /**
   * What the provider must serve at `blockNumber`, computed with one individually pinned wrapper call per value, in
   * the order the formulas consume them.
   */
  const readSequentially = async (blockNumber: bigint, manaUsage: ManaUsageEstimate): Promise<GasFees[]> => {
    const opts = { blockNumber };
    const now = dateProvider.nowInSeconds();
    const slotConfig = { slotDuration: config.slotDuration, l1GenesisTime: config.l1GenesisTime };

    const pending = await rollup.getCheckpointNumber(opts);
    const pendingCheckpoint = await rollup.getCheckpoint(pending, opts);
    const earliest = await rollup.getTimestampForSlot(SlotNumber.add(pendingCheckpoint.slotNumber, 1), opts);
    const nextEth = getNextL1SlotTimestamp(now, config);
    const currentMinFees = new GasFees(0, await rollup.getManaMinFeeAt(maxBigint(earliest, nextEth), true, opts));

    const manaTarget = await rollup.getManaTarget(opts);
    const currentSlot = await rollup.getSlotNumber(opts);
    const firstSlot = SlotNumber(Math.max(currentSlot, getSlotAtNextL1Block(BigInt(now), config)));
    const canPrune = await rollup.canPruneAtTime(getTimestampForSlot(firstSlot, slotConfig), opts);
    const lastCheckpoint = await rollup.getCheckpoint(
      canPrune ? await rollup.getProvenCheckpointNumber(opts) : pending,
      opts,
    );
    const nextSlot = SlotNumber(Math.max(SlotNumber.add(lastCheckpoint.slotNumber, 1), firstSlot));
    const l1FeesBySlot = await Promise.all(
      times(FEE_ORACLE_LAG, i =>
        rollup.getL1FeesAt(getTimestampForSlot(SlotNumber.add(nextSlot, i), slotConfig), opts),
      ),
    );
    const { feeHeader } = lastCheckpoint;
    const predictions = computeFeePredictions(
      {
        lastSlot: lastCheckpoint.slotNumber,
        excessMana: computeExcessMana(feeHeader.excessMana, feeHeader.manaUsed, manaTarget),
        ethPerFeeAsset: feeHeader.ethPerFeeAsset,
        manaTarget,
        manaLimit: await rollup.getManaLimit(opts),
        provingCostPerManaEth: await rollup.getProvingCostPerMana(opts),
        epochDuration: BigInt(await rollup.getEpochDuration()),
        protocolFeeMarginBps: BigInt(await rollup.getProtocolFeeMargin(opts)),
        l1FeesBySlot,
      },
      manaUsage,
    );
    return [currentMinFees, ...predictions];
  };

  /** Asserts that a provider at the current sync point serves exactly what sequential reads at that block give. */
  const expectMatchesSequentialReads = async (provider: FeeProviderImpl) => {
    for (const manaUsage of Object.values(ManaUsageEstimate)) {
      expect(await provider.getPredictedMinFees(manaUsage)).toEqual(
        await readSequentially(syncPoint!.blockNumber, manaUsage),
      );
    }
  };

  describe('L1 requests', () => {
    it('costs one L1 request per new sync point, also when a checkpoint landed', async () => {
      const provider = await startProvider();

      await mineAndSync();
      const quiet = await requestsDuring(() => provider.refresh());

      await landCheckpoint();
      await mineAndSync();
      const landed = await requestsDuring(() => provider.refresh());

      expect(quiet.map(r => r.method)).toEqual(['eth_call']);
      expect(landed.map(r => r.method)).toEqual(['eth_call']);
    });

    it('pins every fee read to the sync point block hash', async () => {
      const provider = await startProvider();
      await landCheckpoint();
      const pinnedTo = await mineAndSync();

      const requests = await requestsDuring(() => provider.refresh());

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.method).toEqual('eth_call');
        expect(request.params[1]).toEqual({ blockHash: pinnedTo.blockHash.toString(), requireCanonical: true });
      }
    });

    it('makes no L1 request while the sync point stays put', async () => {
      const provider = await startProvider();

      const requests = await requestsDuring(async () => {
        await provider.refresh();
        await provider.getPredictedMinFees(ManaUsageEstimate.Target, { ...syncPoint! });
      });

      expect(requests).toEqual([]);
    });

    it('shares one refresh between concurrent requests tagged with a new sync point', async () => {
      const provider = await startProvider();
      const next = await mineAndSync();

      const requests = await requestsDuring(() =>
        Promise.all([provider.getCurrentMinFees({ ...next }), provider.getCurrentMinFees({ ...next })]),
      );

      expect(requests).toHaveLength(1);
    });

    it('completes a cold start within three requests with L1 ahead of the clock and the chain prunable', async () => {
      await makePrunable();
      await mineAndSync();
      dateProvider.setTime(dateProvider.now() - 3 * config.slotDuration * 1000);

      const provider = makeProvider();
      const requests = await requestsDuring(() => provider.refresh());

      expect(requests.filter(isMulticall).length).toBeLessThanOrEqual(3);
      await expectMatchesSequentialReads(provider);
    });
  });

  describe('fees', () => {
    it.each([
      ['on a quiet L1 block', () => Promise.resolve()],
      ['after a checkpoint landed', landCheckpoint],
      ['while the pending chain can be pruned', makePrunable],
      ['after a prune', () => makePrunable().then(prune)],
    ])('match sequential reads at the sync point %s, warm and cold', async (_name, setUp) => {
      const warm = await startProvider();
      await setUp();
      await mineAndSync();

      await warm.refresh();
      const cold = makeProvider();
      await cold.refresh();

      await expectMatchesSequentialReads(warm);
      await expectMatchesSequentialReads(cold);
    });

    it('defaults the prediction to target mana usage', async () => {
      const provider = await startProvider();

      expect(await provider.getPredictedMinFees()).toEqual(
        await provider.getPredictedMinFees(ManaUsageEstimate.Target),
      );
    });

    it('prices at L1 head before the archiver has synced', async () => {
      const head = await mineAndSync();
      syncPoint = undefined;

      const provider = await startProvider();

      syncPoint = head;
      await expectMatchesSequentialReads(provider);
    });
  });

  describe('tagged requests', () => {
    it("answers a tagged read after a same-height reorg with the new fork's projections", async () => {
      const provider = await startProvider();
      const forkPoint = await cheatCodes.rpcCall('evm_snapshot', []);
      const dropped = await mineAndSync();
      await provider.refresh();
      const droppedFees = await provider.getPredictedMinFees(ManaUsageEstimate.Target, { ...dropped });

      await cheatCodes.rpcCall('evm_revert', [forkPoint]);
      await raisePendingExcessMana();
      const replacement = await mineAndSync();
      const fees = await provider.getPredictedMinFees(ManaUsageEstimate.Target, { ...replacement });

      expect(replacement.blockNumber).toEqual(dropped.blockNumber);
      expect(replacement.blockHash).not.toEqual(dropped.blockHash);
      const fresh = makeProvider();
      await fresh.refresh();
      expect(fees).toEqual(await fresh.getPredictedMinFees(ManaUsageEstimate.Target));
      expect(fees).not.toEqual(droppedFees);
    });

    it('answers a request tagged with a block the provider has moved past from its current view', async () => {
      const provider = await startProvider();
      const older = syncPoint!;
      await raisePendingExcessMana();
      await mineAndSync();
      await provider.refresh();

      const requests = await requestsDuring(async () => {
        expect(await provider.getCurrentMinFees({ ...older })).toEqual(await provider.getCurrentMinFees());
      });
      expect(requests).toEqual([]);
    });

    it('answers a request tagged with a block the provider has moved past without joining a refresh', async () => {
      const provider = await startProvider();
      const older = syncPoint!;
      await raisePendingExcessMana();
      await mineAndSync();
      await provider.refresh();
      const current = await provider.getCurrentMinFees();
      const release = promiseWithResolvers<void>();
      gate = release.promise;
      await mineAndSync();
      const stalled = provider.refresh();

      const served = await Promise.race([provider.getCurrentMinFees({ ...older }), sleep(1000).then(() => 'waited')]);

      expect(served).toEqual(current);
      release.resolve();
      await stalled;
    });

    it('serves the current view once a capped wait for a new sync point runs out', async () => {
      const provider = await startProvider();
      const before = await provider.getCurrentMinFees();
      await raisePendingExcessMana();
      const next = await mineAndSync();
      const release = promiseWithResolvers<void>();
      gate = release.promise;

      await expect(provider.getCurrentMinFees({ ...next, maxWaitMs: 50 })).resolves.toEqual(before);

      release.resolve();
    });
  });

  describe('refresh loop', () => {
    it('refreshes on an L1 sync point update without waiting for the loop', async () => {
      const provider = await startProvider();
      const before = await provider.getCurrentMinFees();

      await raisePendingExcessMana();
      announce(await mineAndSync());

      await retryFastUntil(async () => !(await provider.getCurrentMinFees()).equals(before), 'refresh on event');
    });

    it('refreshes again right after a refresh a request started for an older sync point', async () => {
      const provider = await startProvider();
      const older = await mineAndSync();
      const release = promiseWithResolvers<void>();
      gate = release.promise;
      const sent = server.requests.length;
      const request = provider.getCurrentMinFees({ ...older });
      await retryFastUntil(() => server.requests.length > sent, 'request to reach L1');

      await raisePendingExcessMana();
      announce(await mineAndSync());
      release.resolve();
      await request;

      const fresh = makeProvider();
      await fresh.refresh();
      const expected = await fresh.getCurrentMinFees();
      await retryFastUntil(async () => (await provider.getCurrentMinFees()).equals(expected), 'refresh after event');
    });

    it('keeps its last view through a failed refresh and recovers on the next tick', async () => {
      const provider = makeProvider();
      await provider.start(50);
      const before = await provider.getCurrentMinFees();

      l1Down = true;
      await raisePendingExcessMana();
      await mineAndSync();
      await expect(provider.refresh()).rejects.toThrow();
      expect(await provider.getCurrentMinFees()).toEqual(before);

      l1Down = false;
      await retryFastUntil(async () => !(await provider.getCurrentMinFees()).equals(before), 'recovery on tick');
    });

    it('fails to start if the initial refresh fails', async () => {
      l1Down = true;

      await expect(makeProvider().start(60_000)).rejects.toThrow();
    });

    it('stops refreshing once stopped', async () => {
      const provider = makeProvider();
      await provider.start(10);
      await provider.stop();

      const requests = await requestsDuring(async () => {
        announce(await mineAndSync());
        await sleep(50);
      });

      expect(requests).toEqual([]);
    });
  });
});
