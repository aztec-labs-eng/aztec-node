import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { getPublicClient } from '@aztec-labs/ethereum/client';
import { DefaultL1ContractsConfig } from '@aztec-labs/ethereum/config';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { deployAztecL1Contracts } from '@aztec-labs/ethereum/deploy-aztec-l1-contracts';
import {
  type Anvil,
  EthCheatCodes,
  type RecordingRpcServer,
  RollupCheatCodes,
  describeWithAnvil,
  startAnvil,
  startRecordingRpcServer,
} from '@aztec-labs/ethereum/test';
import type { ViemClient } from '@aztec-labs/ethereum/types';
import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { ManualDateProvider } from '@aztec-labs/foundation/timer';
import { GlobalVariableBuilder } from '@aztec-labs/sequencer-client';
import type { L1SyncPoint, L2BlockSource } from '@aztec-labs/stdlib/block';
import { type MockProxy, mock } from 'jest-mock-extended';
import { foundry } from 'viem/chains';

import { NextBlockFeeCache } from './next_block_fee_cache.js';
import { type L2FrontierArgs, makeFrontier, makeProposedCheckpointData } from './test_helpers.js';

/** Counts and inspects the L1 requests one re-price of the next-block boundary fee sends, against a real rollup. */
describeWithAnvil('NextBlockFeeCache on L1', () => {
  let anvil: Anvil;
  let rpcUrl: string;
  /** Sits between the cache under test and anvil, recording every request the cache sends. */
  let server: RecordingRpcServer;
  let publicClient: ViemClient;
  let cheatCodes: EthCheatCodes;
  let rollup: RollupContract;
  let cacheRollup: RollupContract;
  let globalVariableBuilder: GlobalVariableBuilder;
  let blockSource: MockProxy<L2BlockSource>;
  let epochCache: MockProxy<EpochCacheInterface>;
  let cache: NextBlockFeeCache;
  let l1SyncPoint: L1SyncPoint;

  beforeAll(async () => {
    const privateKeyRaw = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
    ({ anvil, rpcUrl } = await startAnvil({ port: 0 }));
    publicClient = getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id });
    cheatCodes = new EthCheatCodes([rpcUrl], new ManualDateProvider());

    const deployed = await deployAztecL1Contracts(rpcUrl, privateKeyRaw, foundry.id, {
      ...DefaultL1ContractsConfig,
      vkTreeRoot: Fr.random(),
      protocolContractsHash: Fr.random(),
      genesisArchiveRoot: Fr.random(),
      realVerifier: false,
    });
    rollup = new RollupContract(publicClient, deployed.l1ContractAddresses.rollupAddress.toString());
    await RollupCheatCodes.create([rpcUrl], deployed.l1ContractAddresses, new ManualDateProvider()).advanceSlots(4);

    server = await startRecordingRpcServer({ forwardTo: rpcUrl });
    const cacheClient = getPublicClient({ l1RpcUrls: [server.url], l1ChainId: foundry.id });
    cacheRollup = new RollupContract(cacheClient, rollup.address);
    globalVariableBuilder = new GlobalVariableBuilder(cacheClient, {
      rollupAddress: deployed.l1ContractAddresses.rollupAddress,
      ethereumSlotDuration: DefaultL1ContractsConfig.ethereumSlotDuration,
      rollupVersion: await rollup.getVersion(),
      slotDuration: await rollup.getSlotDuration(),
      l1GenesisTime: await rollup.getL1GenesisTime(),
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await anvil?.stop().catch(err => createLogger('cleanup').error(`Error stopping anvil`, err));
  });

  beforeEach(async () => {
    blockSource = mock<L2BlockSource>();
    epochCache = mock<EpochCacheInterface>();
    epochCache.getEpochAndSlotInNextL1Slot.mockReturnValue({
      epoch: EpochNumber.ZERO,
      slot: await rollup.getSlotNumber(),
      ts: 0n,
      nowSeconds: 0n,
    });
    cache = new NextBlockFeeCache({
      blockSource,
      globalVariableBuilder,
      rollupContract: cacheRollup,
      epochCache,
      signatureContext: { chainId: foundry.id, rollupAddress: EthAddress.fromString(cacheRollup.address) },
    });
    await syncToL1Head();
  });

  afterEach(async () => {
    await cache.stop();
  });

  /** Mines a block and points the archiver's sync point at it. */
  const syncToL1Head = async () => {
    await cheatCodes.mine();
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    l1SyncPoint = { blockNumber: block.number, blockHash: Buffer32.fromString(block.hash) };
  };

  /** A frontier at a checkpoint boundary, on the genesis checkpoint L1 holds, anchored at the current sync point. */
  const setFrontier = (args: Partial<L2FrontierArgs> = {}) =>
    blockSource.getL2Frontier.mockResolvedValue(
      makeFrontier({
        proposed: BlockNumber(0),
        checkpointedBlock: BlockNumber(0),
        checkpointed: CheckpointNumber(0),
        l1SyncPoint,
        ...args,
      }),
    );

  /** A frontier whose next block builds on a proposed checkpoint 1 that L1 has not seen yet. */
  const setPipelinedFrontier = async () =>
    setFrontier({
      proposed: BlockNumber(1),
      proposedCheckpoint: makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(1),
        lastBlock: BlockNumber(1),
        slotNumber: await rollup.getSlotNumber(),
      }),
    });

  /** The requests one re-price at a new L1 sync point sends, after a first pass has primed what is memoized. */
  const requestsForNextReprice = async (setScenario: () => unknown) => {
    await setScenario();
    await cache.refresh();
    await syncToL1Head();
    await setScenario();
    const from = server.requests.length;
    await cache.refresh();
    return server.requests.slice(from);
  };

  it('re-prices with one L1 request without a proposed parent', async () => {
    const requests = await requestsForNextReprice(() => setFrontier());

    expect(requests.map(r => r.method)).toEqual(['eth_call']);
  });

  it('re-prices with two L1 requests on a proposed parent', async () => {
    const requests = await requestsForNextReprice(() => setPipelinedFrontier());

    expect(requests.map(r => r.method)).toEqual(['eth_call', 'eth_call']);
  });

  it.each([
    ['without a proposed parent', () => setFrontier()],
    ['on a proposed parent', () => setPipelinedFrontier()],
  ])('pins every read of a re-price %s to the sync point block hash', async (_name, setScenario) => {
    const requests = await requestsForNextReprice(setScenario);

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.method).toEqual('eth_call');
      expect(request.params[1]).toEqual({ blockHash: l1SyncPoint.blockHash.toString(), requireCanonical: true });
    }
  });
});
