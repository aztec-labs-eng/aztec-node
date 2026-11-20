use aztec::protocol::abis::gas_settings::GasSettings;

pub(crate) fn safe_cast_to_u128(field: Field) -> u128 {
    field.assert_max_bit_size::<128>();
    field as u128
}

/// Asserts that `max_fee` covers the tx fee limit, which bounds the fee the protocol can charge the fee payer. The FPC
/// pays the tx fee even when teardown reverts, so accepting less would let a user have the FPC pay a fee the user never
/// funded.
pub(crate) fn assert_max_fee_covers_fee_limit(max_fee: u128, gas_settings: GasSettings) {
    // TODO(#10805): Convert `max_fee` to fee juice with a real exchange rate. Currently the rate is fixed 1:1.
    let fee_limit = safe_cast_to_u128(
        gas_settings.gas_limits.compute_fee(gas_settings.max_fees_per_gas),
    );
    assert(max_fee >= fee_limit, "max fee not enough to cover tx fee");
}
