import type { IPublisherManagerMetrics, PublisherBalanceSnapshot } from '@aztec-labs/ethereum/publisher-manager';
import {
  Attributes,
  type BatchObservableResult,
  Metrics,
  type ObservableGauge,
  type TelemetryClient,
} from '@aztec-labs/telemetry-client';
import { formatEther } from 'viem';

/**
 * Telemetry for the publisher balance check, labelled by whether the publishers belong to a sequencer or prover. Gauges
 * are observed from the latest snapshot at export time, and are no longer observed once the publisher manager stops.
 */
export class PublisherManagerMetrics implements IPublisherManagerMetrics {
  private readonly balance: ObservableGauge;
  private readonly sendsAffordable: ObservableGauge;
  private readonly funderBalance: ObservableGauge;
  private readonly requiredBalance: ObservableGauge;
  private snapshot: PublisherBalanceSnapshot | undefined;

  constructor(
    client: TelemetryClient,
    private readonly scope: 'sequencer' | 'prover',
  ) {
    const meter = client.getMeter('PublisherManager');
    this.balance = meter.createObservableGauge(Metrics.L1_PUBLISHER_BALANCE);
    this.sendsAffordable = meter.createObservableGauge(Metrics.L1_PUBLISHER_SENDS_AFFORDABLE);
    this.funderBalance = meter.createObservableGauge(Metrics.L1_FUNDER_BALANCE);
    this.requiredBalance = meter.createObservableGauge(Metrics.L1_PUBLISHER_REQUIRED_BALANCE);
    meter.addBatchObservableCallback(this.observe, [
      this.balance,
      this.sendsAffordable,
      this.funderBalance,
      this.requiredBalance,
    ]);
  }

  public recordBalanceSnapshot(snapshot: PublisherBalanceSnapshot | undefined): void {
    this.snapshot = snapshot;
  }

  private observe = (observer: BatchObservableResult): void => {
    const { snapshot, scope } = this;
    if (snapshot === undefined) {
      return;
    }

    for (const { address, balance, sendsAffordable } of snapshot.publishers) {
      const attributes = { [Attributes.SENDER_ADDRESS]: address, [Attributes.L1_TX_SCOPE]: scope };
      observer.observe(this.balance, toEth(balance), attributes);
      if (sendsAffordable !== undefined) {
        observer.observe(this.sendsAffordable, sendsAffordable, attributes);
      }
    }

    if (snapshot.funder) {
      observer.observe(this.funderBalance, toEth(snapshot.funder.balance), {
        [Attributes.SENDER_ADDRESS]: snapshot.funder.address,
        [Attributes.L1_TX_SCOPE]: scope,
      });
    }

    if (snapshot.required !== undefined) {
      observer.observe(this.requiredBalance, toEth(snapshot.required), { [Attributes.L1_TX_SCOPE]: scope });
    }
  };
}

function toEth(wei: bigint): number {
  return parseFloat(formatEther(wei));
}
