import { Attributes, Metrics } from '@aztec-labs/telemetry-client';
import { InMemoryMetrics } from '@aztec-labs/telemetry-client/test';

import { PublisherManagerMetrics } from './publisher-manager-metrics.js';

describe('PublisherManagerMetrics', () => {
  const eth = 10n ** 18n;
  let telemetry: InMemoryMetrics;
  let metrics: PublisherManagerMetrics;

  beforeEach(() => {
    telemetry = new InMemoryMetrics();
    metrics = new PublisherManagerMetrics(telemetry, 'sequencer');
  });

  afterEach(async () => {
    await telemetry.stop();
  });

  const sender = (address: string) => ({
    [Attributes.SENDER_ADDRESS]: address,
    [Attributes.L1_TX_SCOPE]: 'sequencer',
  });

  it('exports the latest snapshot labelled by sender and scope', async () => {
    metrics.recordBalanceSnapshot({
      publishers: [
        { address: '0x01', balance: 2n * eth, sendsAffordable: 40 },
        { address: '0x02', balance: eth / 2n, sendsAffordable: 10 },
      ],
      funder: { address: '0x03', balance: 5n * eth },
      required: eth / 20n,
    });

    const exported = await telemetry.collect();

    expect(exported[Metrics.L1_PUBLISHER_BALANCE.name]).toEqual([
      { value: 2, attributes: sender('0x01') },
      { value: 0.5, attributes: sender('0x02') },
    ]);
    expect(exported[Metrics.L1_PUBLISHER_SENDS_AFFORDABLE.name]).toEqual([
      { value: 40, attributes: sender('0x01') },
      { value: 10, attributes: sender('0x02') },
    ]);
    expect(exported[Metrics.L1_FUNDER_BALANCE.name]).toEqual([{ value: 5, attributes: sender('0x03') }]);
    expect(exported[Metrics.L1_PUBLISHER_REQUIRED_BALANCE.name]).toEqual([
      { value: 0.05, attributes: { [Attributes.L1_TX_SCOPE]: 'sequencer' } },
    ]);
  });

  it('exports only balances when affordability is unknown', async () => {
    metrics.recordBalanceSnapshot({ publishers: [{ address: '0x01', balance: eth }] });

    const exported = await telemetry.collect();

    expect(exported[Metrics.L1_PUBLISHER_BALANCE.name]).toEqual([{ value: 1, attributes: sender('0x01') }]);
    expect(exported[Metrics.L1_PUBLISHER_SENDS_AFFORDABLE.name]).toBeUndefined();
    expect(exported[Metrics.L1_PUBLISHER_REQUIRED_BALANCE.name]).toBeUndefined();
    expect(exported[Metrics.L1_FUNDER_BALANCE.name]).toBeUndefined();
  });

  it('exports nothing before the first snapshot', async () => {
    const exported = await telemetry.collect();

    expect(exported[Metrics.L1_PUBLISHER_BALANCE.name]).toBeUndefined();
  });
});
