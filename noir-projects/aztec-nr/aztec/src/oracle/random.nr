/// Returns an unconstrained random value. Note that it is not possible to constrain this value to prove that it is
/// truly random: we assume that the oracle is cooperating and returning random values. In some applications this
/// behavior might not be acceptable and other techniques might be more suitable, such as producing pseudo-random
/// values by hashing values outside of user control (like block hashes) or secrets.
pub unconstrained fn random() -> Field {
    rand_oracle()
}

#[oracle(aztec_misc_getRandomField)]
unconstrained fn rand_oracle() -> Field {}

/// Number of bytes [`random_bytes`] takes from each random field: the low ones, since the top bytes of a random field
/// are not uniformly random.
global RANDOM_BYTES_PER_FIELD: u32 = 16;

/// Variant of [`random`] that returns `N` random bytes.
pub(crate) unconstrained fn random_bytes<let N: u32>() -> [u8; N] {
    let mut bytes = [0; N];
    let mut start = 0;
    while start < N {
        let field_bytes: [u8; 32] = random().to_be_bytes();
        for j in 0..RANDOM_BYTES_PER_FIELD {
            if start + j < N {
                bytes[start + j] = field_bytes[32 - RANDOM_BYTES_PER_FIELD + j];
            }
        }
        start += RANDOM_BYTES_PER_FIELD;
    }
    bytes
}

mod test {
    use super::random_bytes;
    use std::test::OracleMock;

    #[test]
    unconstrained fn random_bytes_takes_the_low_16_bytes_of_each_random_field() {
        let _ = OracleMock::mock("aztec_misc_getRandomField")
            .returns(0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f)
            .times(1);
        let _ = OracleMock::mock("aztec_misc_getRandomField")
            .returns(0x202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f)
            .times(1);

        // 20 bytes take all 16 low bytes of the first field and the first 4 low bytes of the second.
        assert_eq(
            random_bytes::<20>(),
            [
                0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x30,
                0x31, 0x32, 0x33,
            ],
        );
    }
}
