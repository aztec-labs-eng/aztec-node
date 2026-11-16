//! Math utilities.

/// Returns `numerator / denominator` rounded up.
pub comptime fn div_ceil(numerator: u32, denominator: u32) -> u32 {
    let quotient = numerator / denominator;
    if numerator % denominator == 0 {
        quotient
    } else {
        quotient + 1
    }
}

/// Returns `numerator / denominator` rounded down.
pub comptime fn div_floor(numerator: u32, denominator: u32) -> u32 {
    numerator / denominator
}

mod test {
    use super::{div_ceil, div_floor};

    #[test]
    unconstrained fn div_ceil_of_a_multiple_is_exact() {
        assert_eq(comptime { div_ceil(0, 31) }, 0);
        assert_eq(comptime { div_ceil(62, 31) }, 2);
    }

    #[test]
    unconstrained fn div_ceil_rounds_a_remainder_up() {
        assert_eq(comptime { div_ceil(1, 31) }, 1);
        assert_eq(comptime { div_ceil(63, 31) }, 3);
        assert_eq(comptime { div_ceil(61, 31) }, 2);
    }

    #[test]
    unconstrained fn div_ceil_does_not_overflow_at_the_maximum_numerator() {
        assert_eq(comptime { div_ceil(4294967295, 2) }, 2147483648);
    }

    #[test]
    unconstrained fn div_ceil_by_one_is_the_numerator() {
        assert_eq(comptime { div_ceil(7, 1) }, 7);
    }

    #[test]
    unconstrained fn div_floor_of_a_multiple_is_exact() {
        assert_eq(comptime { div_floor(0, 31) }, 0);
        assert_eq(comptime { div_floor(62, 31) }, 2);
    }

    #[test]
    unconstrained fn div_floor_drops_a_remainder() {
        assert_eq(comptime { div_floor(1, 31) }, 0);
        assert_eq(comptime { div_floor(63, 31) }, 2);
        assert_eq(comptime { div_floor(61, 31) }, 1);
    }
}
