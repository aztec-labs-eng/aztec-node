use crate::macros::oracle_declaration::misc_oracle;

/// Returns an unconstrained random value. Note that it is not possible to constrain this value to prove that it is
/// truly random: we assume that the oracle is cooperating and returning random values. In some applications this
/// behavior might not be acceptable and other techniques might be more suitable, such as producing pseudo-random
/// values by hashing values outside of user control (like block hashes) or secrets.
pub unconstrained fn random() -> Field {
    get_random_field()
}

#[misc_oracle]
unconstrained fn get_random_field() -> Field {
    get_random_field_oracle()
}
