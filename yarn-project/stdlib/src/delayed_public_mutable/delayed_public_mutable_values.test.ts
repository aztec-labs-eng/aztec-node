import { DEFAULT_UPDATE_DELAY } from '@aztec-labs/constants';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { updateInlineFndTestData, updateInlineTestData } from '@aztec-labs/foundation/testing/files';

import { DelayedPublicMutableValues } from './delayed_public_mutable_values.js';
import { ScheduledDelayChange } from './scheduled_delay_change.js';
import { ScheduledValueChange } from './scheduled_value_change.js';

describe('DelayedPublicMutableValues', () => {
  it(`serializes to fields and back`, () => {
    let values = DelayedPublicMutableValues.empty(BlockNumber(1));
    expect(values).toEqual(DelayedPublicMutableValues.fromFields(values.toFields()));

    values = new DelayedPublicMutableValues(
      new ScheduledValueChange([new Fr(1)], [new Fr(2)], 27n),
      new ScheduledDelayChange(undefined, 2n, 1n),
    );
    expect(values).toEqual(DelayedPublicMutableValues.fromFields(values.toFields()));

    values = new DelayedPublicMutableValues(
      new ScheduledValueChange([new Fr(3)], [new Fr(4)], 28n),
      new ScheduledDelayChange(3n, undefined, 4n),
    );
    expect(values).toEqual(DelayedPublicMutableValues.fromFields(values.toFields()));

    values = new DelayedPublicMutableValues(
      new ScheduledValueChange([new Fr(5)], [new Fr(6)], 29n),
      new ScheduledDelayChange(5n, 7n, 6n),
    );
    expect(values).toEqual(DelayedPublicMutableValues.fromFields(values.toFields()));
  });

  it('packed delayed public mutable values match Noir', () => {
    const values = new DelayedPublicMutableValues(
      new ScheduledValueChange([new Fr(1), new Fr(2)], [new Fr(3), new Fr(4)], 50n),
      new ScheduledDelayChange(1n, 50n, 2n),
    );

    const packed = values.toFields();
    const packedStr = `[${packed.map(f => f.toString()).join(',')}]`;

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data
    updateInlineFndTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/delayed_public_mutable/delayed_public_mutable_values/test.nr',
      'packed_dpmv_from_typescript',
      packedStr,
    );
  });

  it('time horizons match Noir', () => {
    const anchor = 1000n;
    const delay = BigInt(DEFAULT_UPDATE_DELAY);

    const valueChange = (previous: number, post: number, timestampOfChange: bigint) =>
      new ScheduledValueChange([new Fr(previous)], [new Fr(post)], timestampOfChange);
    const delayChange = (post: bigint, timestampOfChange: bigint) =>
      new ScheduledDelayChange(delay, post, timestampOfChange);
    const unchangedValue = ScheduledValueChange.empty(1);
    const unchangedDelay = ScheduledDelayChange.empty();

    const scenarios: Record<string, DelayedPublicMutableValues> = {
      'never written': DelayedPublicMutableValues.empty(1),
      'value change already in effect': new DelayedPublicMutableValues(
        valueChange(1, 2, anchor - 100n),
        unchangedDelay,
      ),
      'value change at the anchor': new DelayedPublicMutableValues(valueChange(1, 2, anchor), unchangedDelay),
      'value change one second after the anchor': new DelayedPublicMutableValues(
        valueChange(1, 2, anchor + 1n),
        unchangedDelay,
      ),
      'value change sooner than the delay': new DelayedPublicMutableValues(
        valueChange(1, 2, anchor + 50n),
        unchangedDelay,
      ),
      'value change later than the delay': new DelayedPublicMutableValues(
        valueChange(1, 2, anchor + delay + 5000n),
        unchangedDelay,
      ),
      'pending change that keeps the value': new DelayedPublicMutableValues(
        valueChange(1, 1, anchor + 50n),
        unchangedDelay,
      ),
      'delay reduction already in effect': new DelayedPublicMutableValues(
        unchangedValue,
        delayChange(50n, anchor - 100n),
      ),
      'delay reduction at the anchor': new DelayedPublicMutableValues(unchangedValue, delayChange(50n, anchor)),
      'delay reduction one second after the anchor': new DelayedPublicMutableValues(
        unchangedValue,
        delayChange(50n, anchor + 1n),
      ),
      'pending delay reduction': new DelayedPublicMutableValues(unchangedValue, delayChange(50n, anchor + 30n)),
      'pending delay increase': new DelayedPublicMutableValues(unchangedValue, delayChange(2n * delay, anchor + 10n)),
      'pending value change and delay reduction': new DelayedPublicMutableValues(
        valueChange(1, 2, anchor + 60n),
        delayChange(50n, anchor + 30n),
      ),
    };

    const horizonOffsets = Object.fromEntries(
      Object.entries(scenarios).map(([name, values]) => [name, values.getTimeHorizon(anchor, delay) - anchor]),
    );
    expect(horizonOffsets).toMatchInlineSnapshot(`
     {
       "delay reduction already in effect": 49n,
       "delay reduction at the anchor": 49n,
       "delay reduction one second after the anchor": 50n,
       "never written": 86399n,
       "pending change that keeps the value": 86399n,
       "pending delay increase": 86399n,
       "pending delay reduction": 79n,
       "pending value change and delay reduction": 59n,
       "value change already in effect": 86399n,
       "value change at the anchor": 86399n,
       "value change later than the delay": 86399n,
       "value change one second after the anchor": 0n,
       "value change sooner than the delay": 49n,
     }
    `);

    const rows = Object.values(scenarios).map(
      values => `([${values.toFields().join(', ')}], ${anchor}, ${values.getTimeHorizon(anchor, delay)})`,
    );

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data
    updateInlineTestData(
      'noir-projects/aztec-nr/aztec/src/state_vars/delayed_public_mutable/test.nr',
      'time_horizons_from_ts',
      `[${rows.join(', ')}]`,
    );
  });
});
