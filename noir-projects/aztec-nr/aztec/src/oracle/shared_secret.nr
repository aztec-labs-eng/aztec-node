use crate::ephemeral::EphemeralArray;
use crate::oracle::ecdh_messaging_secret::{get_ecdh_messaging_secret, get_ecdh_messaging_secrets};
use crate::protocol::{address::AztecAddress, point::EmbeddedCurvePoint};

#[deprecated("use get_ecdh_messaging_secret from ecdh_messaging_secret")]
pub unconstrained fn get_shared_secret(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    contract_address: AztecAddress,
) -> Option<Field> {
    get_ecdh_messaging_secret(address, eph_pk, contract_address)
}

#[deprecated("use get_ecdh_messaging_secrets from ecdh_messaging_secret")]
pub unconstrained fn get_shared_secrets(
    address: AztecAddress,
    eph_pks: EphemeralArray<EmbeddedCurvePoint>,
    contract_address: AztecAddress,
) -> EphemeralArray<Field> {
    get_ecdh_messaging_secrets(address, eph_pks, contract_address)
}
