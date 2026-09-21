import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { AztecLMDBStoreV2, createStore } from '@aztec-labs/kv-store/lmdb-v2';
import type { BlockHash, L2BlockSource } from '@aztec-labs/stdlib/block';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import { type NextBlockMinFeesProvider, getNetworkTxGasLimits } from '@aztec-labs/stdlib/gas';
import type {
  AztecNode,
  ClientProtocolCircuitVerifier,
  WorldStateSynchronizer,
} from '@aztec-labs/stdlib/interfaces/server';
import type { DataStoreConfig } from '@aztec-labs/stdlib/kv-store';
import { type TelemetryClient, getTelemetryClient } from '@aztec-labs/telemetry-client';

import { P2PClient } from '../client/p2p_client.js';
import type { P2PConfig } from '../config.js';
import { AttestationPool, type AttestationPoolApi } from '../mem_pools/attestation_pool/attestation_pool.js';
import type { MemPools } from '../mem_pools/interface.js';
import type { TxPoolV2 } from '../mem_pools/tx_pool_v2/interfaces.js';
import { AztecKVTxPoolV2 } from '../mem_pools/tx_pool_v2/tx_pool_v2.js';
import {
  createCheckAllowedSetupCalls,
  createTxValidatorForOnDemandReceivedTxs,
  createTxValidatorForTransactionsEnteringPendingTxPool,
  getDefaultAllowedSetupFunctions,
} from '../msg_validators/index.js';
import { TxValidationCache } from '../msg_validators/tx_validator/tx_validation_cache.js';
import { DummyP2PService } from '../services/dummy_service.js';
import { LibP2PService } from '../services/index.js';
import { createFileStoreTxSources } from '../services/tx_collection/file_store_tx_source.js';
import { TxCollection } from '../services/tx_collection/tx_collection.js';
import { NodeRpcTxSource, type TxSource, createNodeRpcTxSources } from '../services/tx_collection/tx_source.js';
import { TxFileStore } from '../services/tx_file_store/tx_file_store.js';
import { configureP2PClientAddresses, createLibP2PPeerIdFromPrivateKey, getPeerIdPrivateKey } from '../util.js';

export type P2PClientDeps = {
  txPool?: TxPoolV2;
  store?: AztecAsyncKVStore;
  attestationPool?: AttestationPoolApi;
  logger?: Logger;
  txCollectionNodeSources?: TxSource[];
  rpcTxProviders?: AztecNode[];
  p2pServiceFactory?: (...args: Parameters<(typeof LibP2PService)['new']>) => Promise<LibP2PService>;
};

export const P2P_STORE_NAME = 'p2p';
export const P2P_ARCHIVE_STORE_NAME = 'p2p-archive';
export const P2P_PEER_STORE_NAME = 'p2p-peers';
export const P2P_ATTESTATION_STORE_NAME = 'p2p-attestation';

export const P2P_STORE_VERSION = 5;
export const P2P_ARCHIVE_STORE_VERSION = 2;
export const P2P_PEER_STORE_VERSION = 1;
export const P2P_ATTESTATION_STORE_VERSION = 4;

export async function createP2PClient(
  inputConfig: P2PConfig & DataStoreConfig & ChainConfig,
  archiver: L2BlockSource & ContractDataSource,
  proofVerifier: ClientProtocolCircuitVerifier,
  worldStateSynchronizer: WorldStateSynchronizer,
  epochCache: EpochCacheInterface,
  nextBlockMinFeesProvider: NextBlockMinFeesProvider,
  packageVersion: string,
  dateProvider: DateProvider = new DateProvider(),
  telemetry: TelemetryClient = getTelemetryClient(),
  deps: P2PClientDeps = {},
  initialBlockHash: BlockHash,
) {
  const config = await configureP2PClientAddresses({
    ...inputConfig,
    dataStoreMapSizeKb: inputConfig.p2pStoreMapSizeKb ?? inputConfig.dataStoreMapSizeKb,
  });

  const logger = deps.logger ?? createLogger('p2p');

  if (config.bootstrapNodes.length === 0) {
    logger.warn(
      'No bootstrap nodes have been provided. Set the BOOTSTRAP_NODES environment variable in order to join the P2P network',
    );
  }

  const bindings = logger.getBindings();
  const store = deps.store ?? (await createStore(P2P_STORE_NAME, P2P_STORE_VERSION, config, bindings));
  const archive = await createStore(P2P_ARCHIVE_STORE_NAME, P2P_ARCHIVE_STORE_VERSION, config, bindings);
  const peerStore = await createStore(P2P_PEER_STORE_NAME, P2P_PEER_STORE_VERSION, config, bindings);
  const attestationStore = await createStore(
    P2P_ATTESTATION_STORE_NAME,
    P2P_ATTESTATION_STORE_VERSION,
    config,
    bindings,
  );
  const l1Constants = await archiver.getL1Constants();

  const rollupAddress = inputConfig.rollupAddress.toString().toLowerCase().replace(/^0x/, '');
  const txFileStoreBasePath = `aztec-${inputConfig.l1ChainId}-${inputConfig.rollupVersion}-0x${rollupAddress}`;

  const allowedInSetup = [
    ...(await getDefaultAllowedSetupFunctions()),
    ...(inputConfig.txPublicSetupAllowListExtend ?? []),
  ];
  const checkAllowedSetupCalls = createCheckAllowedSetupCalls(
    archiver,
    allowedInSetup,
    () => epochCache.getEpochAndSlotInNextL1Slot().ts,
  );

  const txPool =
    deps.txPool ??
    new AztecKVTxPoolV2(
      store,
      archive,
      {
        l2BlockSource: archiver,
        worldStateSynchronizer,
        checkAllowedSetupCalls,
        createTxValidator: async () => {
          const currentBlockNumber = await archiver.getBlockNumber();
          const { ts: nextSlotTimestamp } = epochCache.getEpochAndSlotInNextL1Slot();
          const l1Constants = await archiver.getL1Constants();
          // Undefined fails open on the max-fee check alone, so a pricing outage cannot empty the pending pool.
          const gasFees = await nextBlockMinFeesProvider.getNextBlockMinFees();
          const networkTxGasLimits = getNetworkTxGasLimits(config, l1Constants);
          return createTxValidatorForTransactionsEnteringPendingTxPool(
            worldStateSynchronizer,
            nextSlotTimestamp,
            BlockNumber(currentBlockNumber + 1),
            {
              maxTxL2Gas: networkTxGasLimits.l2Gas,
              maxTxDAGas: networkTxGasLimits.daGas,
            },
            gasFees,
          );
        },
        nextBlockMinFeesProvider,
      },
      telemetry,
      {
        maxPendingTxCount: config.maxPendingTxCount,
        archivedTxLimit: config.archivedTxLimit,
        minTxPoolAgeMs: config.minTxPoolAgeMs,
        dropTransactionsProbability: config.dropTransactionsProbability,
        priceBumpPercentage: config.priceBumpPercentage,
        keepFinalizedTxsForSlots: config.keepFinalizedTxsForSlots,
      },
      dateProvider,
    );

  const mempools: MemPools = {
    txPool,
    attestationPool: deps.attestationPool ?? new AttestationPool(attestationStore, telemetry),
  };

  const txValidationCache =
    config.txValidationCacheSize > 0 ? new TxValidationCache(config.txValidationCacheSize) : undefined;

  const p2pService = await createP2PService(
    config,
    archiver,
    proofVerifier,
    worldStateSynchronizer,
    epochCache,
    nextBlockMinFeesProvider,
    store,
    peerStore,
    mempools,
    deps.p2pServiceFactory,
    packageVersion,
    logger.createChild('libp2p_service'),
    telemetry,
    txValidationCache,
  );

  const txValidatorForTxCollection = createTxValidatorForOnDemandReceivedTxs(
    proofVerifier,
    config,
    /*bindings=*/ undefined,
    txValidationCache,
  );
  const nodeSources = [
    ...createNodeRpcTxSources(config.txCollectionNodeRpcUrls, txValidatorForTxCollection, config),
    ...(deps.rpcTxProviders ?? []).map(
      (node, i) => new NodeRpcTxSource(node, txValidatorForTxCollection, `node-rpc-provider-${i}`),
    ),
    ...(deps.txCollectionNodeSources ?? []),
  ];
  if (nodeSources.length > 0) {
    logger.info(`Using ${nodeSources.length} node RPC sources for tx collection.`, {
      nodes: nodeSources.map(n => n.getInfo()),
    });
  }

  const fileStoreSources = await createFileStoreTxSources(
    config.txCollectionFileStoreUrls,
    txFileStoreBasePath,
    txValidatorForTxCollection,
    logger.createChild('file-store-tx-source'),
    telemetry,
  );
  if (fileStoreSources.length > 0) {
    logger.info(`Using ${fileStoreSources.length} file store sources for tx collection.`, {
      stores: fileStoreSources.map(s => s.getInfo()),
    });
  }

  const txCollection = new TxCollection(
    p2pService.getBatchTxRequesterService(),
    nodeSources,
    l1Constants,
    mempools.txPool,
    config,
    fileStoreSources,
    dateProvider,
    telemetry,
    logger.createChild('tx-collection'),
  );

  const txFileStore = await TxFileStore.create(
    mempools.txPool,
    config,
    txFileStoreBasePath,
    logger.createChild('tx-file-store'),
    telemetry,
  );

  return new P2PClient(
    store,
    archiver,
    mempools,
    p2pService,
    txCollection,
    txFileStore,
    epochCache,
    config,
    dateProvider,
    telemetry,
    undefined,
    initialBlockHash,
  );
}

async function createP2PService(
  config: P2PConfig & DataStoreConfig,
  archiver: L2BlockSource & ContractDataSource,
  proofVerifier: ClientProtocolCircuitVerifier,
  worldStateSynchronizer: WorldStateSynchronizer,
  epochCache: EpochCacheInterface,
  nextBlockMinFeesProvider: NextBlockMinFeesProvider,
  store: AztecAsyncKVStore,
  peerStore: AztecLMDBStoreV2,
  mempools: MemPools,
  p2pServiceFactory: P2PClientDeps['p2pServiceFactory'],
  packageVersion: string,
  logger: Logger,
  telemetry: TelemetryClient,
  txValidationCache?: TxValidationCache,
) {
  if (!config.p2pEnabled) {
    logger.verbose('P2P is disabled. Using dummy P2P service.');
    return new DummyP2PService();
  }

  logger.verbose('P2P is enabled. Using LibP2P service.');

  // Create peer discovery service
  const peerIdPrivateKey = await getPeerIdPrivateKey(config, store, logger);
  const peerId = await createLibP2PPeerIdFromPrivateKey(peerIdPrivateKey.getValue());

  const p2pService = await (p2pServiceFactory ?? LibP2PService.new)(config, peerId, {
    packageVersion,
    mempools,
    l2BlockSource: archiver,
    epochCache,
    proofVerifier,
    worldStateSynchronizer,
    peerStore,
    nextBlockMinFeesProvider,
    telemetry,
    logger: logger.createChild(`libp2p_service`),
    txValidationCache,
  });

  return p2pService;
}
