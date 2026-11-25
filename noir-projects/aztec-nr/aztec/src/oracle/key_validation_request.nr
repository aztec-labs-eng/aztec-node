use crate::protocol::abis::validation_requests::KeyValidationRequest;

#[oracle(aztec_utl_getKeyValidationRequestV2)]
unconstrained fn get_key_validation_request_oracle(
    _pk_m_hash: Field,
    _key_index: Field,
) -> Option<KeyValidationRequest> {}

/// Fails if no account in scope has the key.
#[deprecated("use aztec::keys::getters::try_get_sk_app")]
pub unconstrained fn get_key_validation_request(pk_m_hash: Field, key_index: Field) -> KeyValidationRequest {
    try_get_key_validation_request(pk_m_hash, key_index).expect(
        f"Key validation request denied: no scoped account has a key with hash {pk_m_hash}",
    )
}

/// Returns `None` if no account in scope has the key.
pub(crate) unconstrained fn try_get_key_validation_request(
    pk_m_hash: Field,
    key_index: Field,
) -> Option<KeyValidationRequest> {
    get_key_validation_request_oracle(pk_m_hash, key_index)
}
