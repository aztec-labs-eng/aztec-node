use crate::keys::post_quantum::mlkem768::{
    KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES, KemCiphertext, KemSharedSecret, PostQuantumPublicKey,
};
use crate::oracle::random::random;

#[oracle(aztec_utl_mlKemEncapsulate)]
unconstrained fn mlkem_encapsulate_oracle(
    public_key: PostQuantumPublicKey,
    seed: [u8; KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES],
) -> Option<(KemSharedSecret, KemCiphertext)> {}

/// Encapsulates a fresh [`KemSharedSecret`] to `public_key`.
///
/// Returns the secret together with the [`KemCiphertext`] the owner of `public_key` can use to recover it.
/// Every call yields a different secret and ciphertext.
///
/// Returns `None` if `public_key` is not a valid ML-KEM-768 public key.
pub(crate) unconstrained fn mlkem_encapsulate(
    public_key: PostQuantumPublicKey,
) -> Option<(KemSharedSecret, KemCiphertext)> {
    // The oracle draws no randomness of its own: the seed fully determines the encapsulation.
    mlkem_encapsulate_oracle(public_key, random_seed())
}

/// Draws the seed of an encapsulation at random.
unconstrained fn random_seed() -> [u8; KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES] {
    // The top bytes of a random field are not uniformly random, so each half of the seed comes from the low bytes of
    // a field of its own.
    let half = KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES / 2;
    let first: [u8; 32] = random().to_be_bytes();
    let second: [u8; 32] = random().to_be_bytes();

    let mut seed = [0; KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES];
    for i in 0..half {
        seed[i] = first[32 - half + i];
        seed[half + i] = second[32 - half + i];
    }
    seed
}
