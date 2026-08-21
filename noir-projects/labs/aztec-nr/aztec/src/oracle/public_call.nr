use crate::macros::oracle_declaration::prv_oracle;

/// Validates public calldata by checking that the preimage exists and the cumulative size is within limits.
///
/// The check is unconstrained and the only purpose of it is to fail early in case of calldata overflow or a bug in
/// calldata hashing.
pub(crate) fn assert_valid_public_call_data(calldata_hash: Field) {
    // Safety: This oracle call returns nothing: we only call it for its side effects (validating the calldata).
    // It is therefore always safe to call.
    unsafe {
        assert_valid_public_calldata(calldata_hash)
    }
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
#[prv_oracle]
unconstrained fn assert_valid_public_calldata(calldata_hash: Field) {
    assert_valid_public_calldata_oracle(calldata_hash)
}
