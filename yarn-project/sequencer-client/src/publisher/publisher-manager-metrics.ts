import type { IPublisherManagerMetrics } from '@aztec-labs/ethereum/publisher-manager';
import {
  Attributes,
  type Gauge,
  Metrics,
  type TelemetryClient,
  type UpDownCounter,
} from '@aztec-labs/telemetry-client';
import { formatEther } from 'viem';

/** Telemetry for publisher affordability checks, labelled by whether the publishers belong to a sequencer or prover. */
export class PublisherManagerMetrics implements IPublisherManagerMetrics {
  private readonly requiredBalance: Gauge;
  private readonly lowBalanceCount: UpDownCounter;

  constructor(
    client: TelemetryClient,
    private readonly scope: 'sequencer' | 'prover',
  ) {
    const meter = client.getMeter('PublisherManager');
    this.requiredBalance = meter.createGauge(Metrics.L1_PUBLISHER_REQUIRED_BALANCE);
    this.lowBalanceCount = meter.createUpDownCounter(Metrics.L1_PUBLISHER_LOW_BALANCE_COUNT);
  }

  public recordRequiredBalance(required: bigint): void {
    this.requiredBalance.record(parseFloat(formatEther(required)), { [Attributes.L1_TX_SCOPE]: this.scope });
  }

  public recordLowBalance(address: string): void {
    this.lowBalanceCount.add(1, { [Attributes.L1_TX_SCOPE]: this.scope, [Attributes.L1_SENDER]: address });
  }
}
