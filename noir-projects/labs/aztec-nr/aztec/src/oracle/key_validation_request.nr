use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::abis::validation_requests::KeyValidationRequest;

#[utl_oracle]
pub unconstrained fn get_key_validation_request(pk_m_hash: Field, key_index: Field) -> KeyValidationRequest {
    get_key_validation_request_oracle(pk_m_hash, key_index)
}
