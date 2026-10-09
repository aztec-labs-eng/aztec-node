import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import type { PublisherManager } from '@aztec-labs/ethereum/publisher-manager';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { LoggerBindings } from '@aztec-labs/foundation/log';
import type { ProverPublisherConfig, ProverTxSenderConfig } from '@aztec-labs/sequencer-client';
import type { TelemetryClient } from '@aztec-labs/telemetry-client';

import { SUBMIT_EPOCH_PROOF_REQUIREMENT } from './gas_constants.js';
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
   * Checks that some publisher can afford submitting an epoch proof, regardless of whether it is busy right now.
   * @throws NoAffordablePublisherError if none can.
   */
  public checkSubmissionAffordable(): Promise<void> {
    return this.deps.publisherManager.checkAffordablePublisher(SUBMIT_EPOCH_PROOF_REQUIREMENT);
  }

  /**
   * Creates a new Prover Publisher instance.
   * @param opts.requireAffordableSubmission - Only select a publisher that can afford submitting an epoch proof, and
   *   throw NoAffordablePublisherError if none can.
   * @returns A new ProverNodePublisher instance.
   */
  public async create(opts?: { requireAffordableSubmission?: boolean }): Promise<ProverNodePublisher> {
    const l1Publisher = await this.deps.publisherManager.getAvailablePublisher(undefined, {
      requirement: opts?.requireAffordableSubmission ? SUBMIT_EPOCH_PROOF_REQUIREMENT : undefined,
    });
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
