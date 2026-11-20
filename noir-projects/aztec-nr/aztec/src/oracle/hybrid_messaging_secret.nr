use crate::keys::post_quantum::mlkem768::KemCiphertext;
use crate::protocol::{address::AztecAddress, point::EmbeddedCurvePoint};

#[oracle(aztec_utl_getHybridMessagingSecret)]
unconstrained fn get_hybrid_messaging_secret_oracle(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    kem_ciphertext: KemCiphertext,
    contract_address: AztecAddress,
) -> Option<Field> {}

/// Returns `address`'s hybrid messaging secret for `eph_pk` and `kem_ciphertext`.
///
/// The secret is shared with whoever created the
/// [`HybridSharedSecret`](crate::keys::hybrid_shared_secret::HybridSharedSecret) that `eph_pk` and `kem_ciphertext`
/// come from.
///
/// The returned Field is computed as:
///
/// ```text
/// S      = address_secret * eph_pk                               (raw ECDH point)
/// K      = decapsulate(post_quantum_secret_key, kem_ciphertext)  (KEM shared secret)
/// hybrid = h(DOM_SEP, K, S.x, S.y)                               (hybrid shared secret)
/// secret = h(DOM_SEP, hybrid, contract)                          (messaging secret)
/// ```
///
/// where `contract` is `contract_address`, which must be the address of the calling contract.
///
/// Returns `Option::none()` when the PXE does not hold `address`'s keys in scope, or when `eph_pk` or `kem_ciphertext`
/// are malformed, and therefore cannot derive the secret.
pub(crate) unconstrained fn get_hybrid_messaging_secret(
    address: AztecAddress,
    eph_pk: EmbeddedCurvePoint,
    kem_ciphertext: KemCiphertext,
    contract_address: AztecAddress,
) -> Option<Field> {
    get_hybrid_messaging_secret_oracle(address, eph_pk, kem_ciphertext, contract_address)
}
