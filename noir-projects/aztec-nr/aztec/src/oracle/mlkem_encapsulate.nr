use crate::keys::post_quantum::mlkem768::{
    KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES, KemCiphertext, KemSharedSecret, PostQuantumPublicKey,
};
use crate::oracle::random::random_bytes;

/// What an ML-KEM-768 encapsulation yields.
#[derive(Eq)]
pub(crate) struct MlKemEncapsulationResult {
    /// The encapsulated secret.
    pub(crate) shared_secret: KemSharedSecret,
    /// The ciphertext the owner of the public key recovers [`MlKemEncapsulationResult::shared_secret`] from.
    pub(crate) ciphertext: KemCiphertext,
}

#[oracle(aztec_utl_mlKemEncapsulate)]
unconstrained fn mlkem_encapsulate_oracle(
    public_key: PostQuantumPublicKey,
    seed: [u8; KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES],
) -> Option<MlKemEncapsulationResult> {}

/// Encapsulates a fresh [`KemSharedSecret`] to `public_key`.
///
/// Returns the secret together with the [`KemCiphertext`] the owner of `public_key` can use to recover it. Every call
/// yields a different secret and ciphertext.
///
/// Returns `None` if `public_key` is not a valid ML-KEM-768 public key.
pub(crate) unconstrained fn mlkem_encapsulate(public_key: PostQuantumPublicKey) -> Option<MlKemEncapsulationResult> {
    // The oracle draws no randomness of its own: the seed fully determines the encapsulation.
    mlkem_encapsulate_oracle(public_key, random_bytes())
}
