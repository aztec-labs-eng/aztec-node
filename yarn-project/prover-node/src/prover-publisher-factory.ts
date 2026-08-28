import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import type { PublisherManager } from '@aztec-labs/ethereum/publisher-manager';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { LoggerBindings } from '@aztec-labs/foundation/log';
import type { ProverPublisherConfig, ProverTxSenderConfig } from '@aztec-labs/sequencer-client';
import type { TelemetryClient } from '@aztec-labs/telemetry-client';

import { ProverNodePublisher } from './prover-node-publisher.js';

export class ProverPublisherFactory {
  constructor(
    private config: ProverTxSenderConfig & ProverPublisherConfig,
    private deps: {
      rollupContract: RollupContract;
      publisherManager: PublisherManager<L1TxUtils>;
      proofSubmissionTarget?: EthAddress;
      telemetry?: TelemetryClient;
    },
    private bindings?: LoggerBindings,
  ) {}

  public async start() {
    await this.deps.publisherManager.start();
  }

  public async stop() {
    await this.deps.publisherManager.stop();
  }

  /**
   * Creates a new Prover Publisher instance.
   * @returns A new ProverNodePublisher instance.
   */
  public async create(): Promise<ProverNodePublisher> {
    const l1Publisher = await this.deps.publisherManager.getAvailablePublisher();
    return new ProverNodePublisher(
      this.config,
      {
        rollupContract: this.deps.rollupContract,
        l1TxUtils: l1Publisher,
        proofSubmissionTarget: this.deps.proofSubmissionTarget,
        telemetry: this.deps.telemetry,
      },
      this.bindings,
    );
  }
}
