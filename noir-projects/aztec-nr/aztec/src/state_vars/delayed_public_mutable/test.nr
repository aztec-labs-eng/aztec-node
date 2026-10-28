use crate::{
    context::{PrivateContext, PublicContext, UtilityContext},
    state_vars::{delayed_public_mutable::{DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY, DelayedPublicMutable}, StateVariable},
    test::{helpers::test_environment::TestEnvironment, mocks::MockStruct},
};
use crate::protocol::{
    constants::DEFAULT_UPDATE_DELAY,
    delayed_public_mutable::{compute_delayed_public_mutable_time_horizon, DelayedPublicMutableValues},
    traits::{Empty, Packable},
};

use std::mem::zeroed;

global new_value: MockStruct = MockStruct { a: 17, b: 42 };

global new_delay: u64 = 60 * 60 * 2;

global BELOW_MINIMUM_DELAY: u64 = DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY - 1;

global storage_slot: Field = 47;

global TEST_INITIAL_DELAY: u64 = 60 * 60 * 24;

unconstrained fn in_public(
    context: PublicContext,
) -> DelayedPublicMutable<MockStruct, TEST_INITIAL_DELAY, PublicContext> {
    DelayedPublicMutable::new(context, storage_slot)
}

unconstrained fn in_private(
    context: &mut PrivateContext,
) -> DelayedPublicMutable<MockStruct, TEST_INITIAL_DELAY, &mut PrivateContext> {
    DelayedPublicMutable::new(context, storage_slot)
}

unconstrained fn in_utility(
    context: UtilityContext,
) -> DelayedPublicMutable<MockStruct, TEST_INITIAL_DELAY, UtilityContext> {
    DelayedPublicMutable::new(context, storage_slot)
}

#[test]
unconstrained fn declaring_with_minimum_delay() {
    let _: DelayedPublicMutable<MockStruct, DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY, PublicContext> =
        DelayedPublicMutable::new(zeroed(), storage_slot);
}

#[test(should_fail_with = "DelayedPublicMutable delay must be at least")]
unconstrained fn declaring_with_delay_below_minimum() {
    let _: DelayedPublicMutable<MockStruct, BELOW_MINIMUM_DELAY, PublicContext> =
        DelayedPublicMutable::new(zeroed(), storage_slot);
}

#[test]
unconstrained fn get_current_value_in_public_initial() {
    let env = TestEnvironment::new();

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_value(), zeroed());
    });
}

#[test]
unconstrained fn get_scheduled_value_in_public() {
    let env = TestEnvironment::new();

    env.public_context(|context| {
        let state_var = in_public(context);

        // Since we haven't modified the delay, it's value should be the default value of TEST_INITIAL_DELAY.
        state_var.schedule_value_change(new_value);

        let (scheduled, timestamp_of_change) = state_var.get_scheduled_value();

        assert_eq(scheduled, new_value);
        assert_eq(timestamp_of_change, context.timestamp() + TEST_INITIAL_DELAY);
    });
}

#[test]
unconstrained fn get_current_value_in_public_before_scheduled_change() {
    let env = TestEnvironment::new();

    let (original_value, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        let (_, timestamp_of_change) = state_var.get_scheduled_value();

        let original_value = zeroed();

        // The current value has not changed
        assert_eq(state_var.get_current_value(), original_value);

        (original_value, timestamp_of_change)
    });

    env.set_next_block_timestamp(timestamp_of_change - 1);

    env.public_context(|context| {
        let state_var = in_public(context);
        // The current value still does not change right before the timestamp of change
        assert_eq(state_var.get_current_value(), original_value);
    });
}

#[test]
unconstrained fn get_current_value_in_public_at_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);
        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.set_next_block_timestamp(timestamp_of_change);

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_value(), new_value);
    });
}

#[test]
unconstrained fn get_current_value_in_public_after_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.set_next_block_timestamp(timestamp_of_change + 10);

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_value(), new_value);
    });
}

#[test]
unconstrained fn get_current_delay_in_public_initial() {
    let env = TestEnvironment::new();
    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_delay(), TEST_INITIAL_DELAY);
    });
}

#[test]
unconstrained fn get_scheduled_delay_in_public() {
    let env = TestEnvironment::new();

    env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_delay_change(new_delay);

        let (scheduled, timestamp_of_change) = state_var.get_scheduled_delay();
        assert_eq(scheduled, new_delay);
        // The new delay is smaller, therefore we need to wait for the difference between current and new
        assert_eq(timestamp_of_change, context.timestamp() + TEST_INITIAL_DELAY - new_delay);
    });
}

#[test]
unconstrained fn schedule_delay_change_to_minimum_delay() {
    let env = TestEnvironment::new();

    env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_delay_change(DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY);

        let (scheduled, _) = state_var.get_scheduled_delay();
        assert_eq(scheduled, DELAYED_PUBLIC_MUTABLE_MINIMUM_DELAY);
    });
}

#[test(should_fail_with = "DelayedPublicMutable delay must be at least")]
unconstrained fn schedule_delay_change_below_minimum_delay() {
    let env = TestEnvironment::new();

    env.public_context(|context| {
        let state_var = in_public(context);
        state_var.schedule_delay_change(BELOW_MINIMUM_DELAY);
    });
}

#[test]
unconstrained fn get_current_delay_in_public_before_scheduled_change() {
    let env = TestEnvironment::new();

    let (original_delay, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_delay_change(new_delay);

        let (_, timestamp_of_change) = state_var.get_scheduled_delay();

        let original_delay = TEST_INITIAL_DELAY;

        // The current delay has not changed
        assert_eq(state_var.get_current_delay(), original_delay);

        (original_delay, timestamp_of_change)
    });

    // The current delay still does not change right before the timestamp of change
    env.set_next_block_timestamp(timestamp_of_change - 1);

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_delay(), original_delay);
    });
}

#[test]
unconstrained fn get_current_delay_in_public_at_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_delay_change(new_delay);

        state_var.get_scheduled_delay()
    });

    env.set_next_block_timestamp(timestamp_of_change);

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_delay(), new_delay);
    });
}

#[test]
unconstrained fn get_current_delay_in_public_after_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_delay_change(new_delay);

        state_var.get_scheduled_delay()
    });

    env.set_next_block_timestamp(timestamp_of_change + 10);

    env.public_context(|context| {
        let state_var = in_public(context);
        assert_eq(state_var.get_current_delay(), new_delay);
    });
}

#[test]
unconstrained fn get_current_value_in_private_initial() {
    let env = TestEnvironment::new();

    env.private_context(|context| {
        let state_var = in_private(context);

        assert_eq(state_var.get_current_value(), zeroed());
        assert_eq(
            context.expiration_timestamp,
            context.get_anchor_block_header().timestamp() + TEST_INITIAL_DELAY - 1,
        );
    });
}

#[test]
unconstrained fn get_current_value_in_private_before_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.private_context(|context| {
        let state_var = in_private(context);

        assert_eq(state_var.get_current_value(), MockStruct::empty());
        assert_eq(context.expiration_timestamp, timestamp_of_change - 1);
    });
}

#[test]
unconstrained fn get_current_value_in_private_immediately_before_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change - 1);

    env.private_context(|context| {
        // Make sure we're at a block with the expected timestamp
        assert_eq(context.get_anchor_block_header().timestamp(), timestamp_of_change - 1);

        let state_var = in_private(context);

        // Note that this transaction could only be included in a block that shares the anchor block's timestamp, since
        // that is also its expiration_timestamp.
        assert_eq(state_var.get_current_value(), MockStruct::empty());
        assert_eq(context.expiration_timestamp, timestamp_of_change - 1);
    });
}

#[test]
unconstrained fn get_current_value_in_private_at_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change);

    env.private_context(|context| {
        // Make sure we're at a block with the expected timestamp
        assert_eq(context.get_anchor_block_header().timestamp(), timestamp_of_change);

        let state_var = in_private(context);

        assert_eq(state_var.get_current_value(), new_value);
        assert_eq(
            context.expiration_timestamp,
            context.get_anchor_block_header().timestamp() + TEST_INITIAL_DELAY - 1,
        );
    });
}

#[test]
unconstrained fn get_current_value_in_private_after_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change + 10);

    env.private_context(|context| {
        // Make sure we're at a block with the expected timestamp
        assert_eq(context.get_anchor_block_header().timestamp(), timestamp_of_change + 10);

        let state_var = in_private(context);

        assert_eq(state_var.get_current_value(), new_value);
        assert_eq(
            context.expiration_timestamp,
            context.get_anchor_block_header().timestamp() + TEST_INITIAL_DELAY - 1,
        );
    });
}

#[test]
unconstrained fn get_current_value_in_private_with_non_initial_delay() {
    let env = TestEnvironment::new();

    let ((_, value_timestamp_of_change), (_, delay_timestamp_of_change)) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);
        state_var.schedule_delay_change(new_delay);

        (state_var.get_scheduled_value(), state_var.get_scheduled_delay())
    });

    let anchor_block_timestamp = std::cmp::max(value_timestamp_of_change, delay_timestamp_of_change);
    env.mine_block_at(anchor_block_timestamp);

    env.private_context(|context| {
        // Make sure we're at a block with the expected timestamp
        assert_eq(context.get_anchor_block_header().timestamp(), anchor_block_timestamp);

        let state_var = in_private(context);

        assert_eq(state_var.get_current_value(), new_value);
        assert_eq(context.expiration_timestamp, anchor_block_timestamp + new_delay - 1);
    });
}

#[test]
unconstrained fn get_current_value_in_utility_initial() {
    let env = TestEnvironment::new();
    env.utility_context(|context| {
        let state_var = in_utility(context);
        assert_eq(state_var.get_current_value(), zeroed());
    });
}

#[test]
unconstrained fn get_current_value_in_utility_before_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change - 1);

    env.utility_context(|context| {
        let state_var = in_utility(context);
        assert_eq(state_var.get_current_value(), zeroed());
    });
}

#[test]
unconstrained fn get_current_value_in_utility_at_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change);

    env.utility_context(|context| {
        let state_var = in_utility(context);
        assert_eq(state_var.get_current_value(), new_value);
    });
}

#[test]
unconstrained fn get_current_value_in_utility_after_scheduled_change() {
    let env = TestEnvironment::new();

    let (_, timestamp_of_change) = env.public_context(|context| {
        let state_var = in_public(context);

        state_var.schedule_value_change(new_value);

        state_var.get_scheduled_value()
    });

    env.mine_block_at(timestamp_of_change + 10);

    env.utility_context(|context| {
        let state_var = in_utility(context);
        assert_eq(state_var.get_current_value(), new_value);
    });
}

#[test]
unconstrained fn time_horizons_match_typescript() {
    // The following value was generated by
    // `yarn-project/stdlib/src/delayed_public_mutable/delayed_public_mutable_values.test.ts`
    let time_horizons_from_ts = [
        (
            [
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 87399,
        ),
        (
            [
                0x0000000000000000000000000000000000000000000000000000000000000384,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 87399,
        ),
        (
            [
                0x00000000000000000000000000000000000000000000000000000000000003e8,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 87399,
        ),
        (
            [
                0x00000000000000000000000000000000000000000000000000000000000003e9,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 1000,
        ),
        (
            [
                0x000000000000000000000000000000000000000000000000000000000000041a,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 1049,
        ),
        (
            [
                0x00000000000000000000000000000000000000000000000000000000000168f0,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 87399,
        ),
        (
            [
                0x000000000000000000000000000000000000000000000000000000000000041a,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000001,
            ], 1000, 87399,
        ),
        (
            [
                0x0000000000000000000000000000000151800100000032010000038400000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 1049,
        ),
        (
            [
                0x000000000000000000000000000000015180010000003201000003e800000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 1049,
        ),
        (
            [
                0x000000000000000000000000000000015180010000003201000003e900000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 1050,
        ),
        (
            [
                0x0000000000000000000000000000000151800100000032010000040600000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 1079,
        ),
        (
            [
                0x000000000000000000000000000000015180010002a30001000003f200000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
                0x0000000000000000000000000000000000000000000000000000000000000000,
            ], 1000, 87399,
        ),
        (
            [
                0x0000000000000000000000000000000151800100000032010000040600000424,
                0x0000000000000000000000000000000000000000000000000000000000000001,
                0x0000000000000000000000000000000000000000000000000000000000000002,
            ], 1000, 1059,
        ),
    ];

    for i in 0..time_horizons_from_ts.len() {
        let (packed, anchor_block_timestamp, time_horizon) = time_horizons_from_ts[i];
        let values: DelayedPublicMutableValues<Field, DEFAULT_UPDATE_DELAY> = Packable::unpack(packed);
        assert_eq(
            compute_delayed_public_mutable_time_horizon(values, anchor_block_timestamp as u64),
            time_horizon as u64,
        );
    }
}
