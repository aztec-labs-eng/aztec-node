import type { BlobClientInterface } from '@aztec-labs/blob-client/client';
import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { KeystoreManager } from '@aztec-labs/node-keystore';
import type { P2PClient } from '@aztec-labs/p2p';
import type { L2BlockSink, L2BlockSource } from '@aztec-labs/stdlib/block';
import type { CheckpointReexecutionTracker } from '@aztec-labs/stdlib/checkpoint';
import type { ValidatorClientFullConfig, WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { ConsensusTimetable } from '@aztec-labs/stdlib/timetable';
import type { TelemetryClient } from '@aztec-labs/telemetry-client';
import type { SlashingProtectionDatabase } from '@aztec-labs/validator-ha-signer/types';

import type { FullNodeCheckpointsBuilder } from './checkpoint_builder.js';
import { ValidatorMetrics } from './metrics.js';
import { ProposalHandler } from './proposal_handler.js';
import { ValidatorClient } from './validator.js';

export function createProposalHandler(
  config: ValidatorClientFullConfig,
  deps: {
    checkpointsBuilder: FullNodeCheckpointsBuilder;
    worldState: WorldStateSynchronizer;
    blockSource: L2BlockSource & L2BlockSink;
    l1ToL2MessageSource: L1ToL2MessageSource;
    p2pClient: P2PClient;
    epochCache: EpochCache;
    blobClient: BlobClientInterface;
    dateProvider: DateProvider;
    telemetry: TelemetryClient;
    reexecutionTracker: CheckpointReexecutionTracker;
  },
) {
  const metrics = new ValidatorMetrics(deps.telemetry);
  const consensusTimetable = new ConsensusTimetable({
    l1Constants: deps.epochCache.getL1Constants(),
    blockDuration: config.blockDurationMs / 1000,
  });
  return new ProposalHandler(
    deps.checkpointsBuilder,
    deps.worldState,
    deps.blockSource,
    deps.l1ToL2MessageSource,
    deps.p2pClient.getTxProvider(),
    deps.epochCache,
    consensusTimetable,
    config,
    deps.blobClient,
    deps.reexecutionTracker,
    metrics,
    deps.dateProvider,
    deps.telemetry,
    undefined,
  );
}

export function createValidatorClient(
  config: ValidatorClientFullConfig,
  deps: {
    checkpointsBuilder: FullNodeCheckpointsBuilder;
    worldState: WorldStateSynchronizer;
    p2pClient: P2PClient;
    blockSource: L2BlockSource & L2BlockSink;
    l1ToL2MessageSource: L1ToL2MessageSource;
    telemetry: TelemetryClient;
    dateProvider: DateProvider;
    epochCache: EpochCache;
    keyStoreManager: KeystoreManager | undefined;
    blobClient: BlobClientInterface;
    reexecutionTracker: CheckpointReexecutionTracker;
    slashingProtectionDb?: SlashingProtectionDatabase;
  },
) {
  if (config.disableValidator || !deps.keyStoreManager) {
    return undefined;
  }

  const txProvider = deps.p2pClient.getTxProvider();
  return ValidatorClient.new(
    config,
    deps.checkpointsBuilder,
    deps.worldState,
    deps.epochCache,
    deps.p2pClient,
    deps.blockSource,
    deps.l1ToL2MessageSource,
    txProvider,
    deps.keyStoreManager,
    deps.blobClient,
    deps.reexecutionTracker,
    deps.dateProvider,
    deps.telemetry,
    deps.slashingProtectionDb,
  );
}
