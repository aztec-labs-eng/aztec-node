use crate::keys::post_quantum::mlkem768::KemCiphertext;
use crate::protocol::{address::AztecAddress, point::EmbeddedCurvePoint};

#[oracle(aztec_utl_getHybridMessagingSecret)]
unconstrained fn get_hybrid_messaging_secret_oracle(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    kem_ciphertext: KemCiphertext,
    contract_address: AztecAddress,
) -> Option<Field> {}

/// Returns the messaging secret `contract_address` gets from a hybrid shared secret created with `address`.
///
/// `eph_pk` and `kem_ciphertext` are the ones of the
/// [`CreatedHybridSharedSecret`](crate::keys::hybrid_shared_secret::CreatedHybridSharedSecret), and the result is what
/// [`compute_hybrid_messaging_secret`](crate::keys::hybrid_shared_secret::compute_hybrid_messaging_secret) returns for
/// its secret. Only the messaging secret is returned, as the hybrid shared secret would let a contract compute those of
/// every other contract.
///
/// `contract_address` must be the address of the calling contract.
///
/// Returns `None` when the PXE does not hold `address`'s keys, or when `eph_pk` or `kem_ciphertext` are malformed: in
/// neither case can the secret be derived.
pub(crate) unconstrained fn get_hybrid_messaging_secret(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    kem_ciphertext: KemCiphertext,
    contract_address: AztecAddress,
) -> Option<Field> {
    get_hybrid_messaging_secret_oracle(address, eph_pk, kem_ciphertext, contract_address)
}
