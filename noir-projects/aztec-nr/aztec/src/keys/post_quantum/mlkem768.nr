use crate::{protocol::traits::{Deserialize, Serialize}, utils::math::div_ceil};

/// Size of a [`PostQuantumPublicKey`] in bytes, which is that of an ML-KEM-768 public key.
global POST_QUANTUM_PUBLIC_KEY_SIZE_IN_BYTES: u32 = 1184;

/// Size of a [`PostQuantumPublicKey`] in fields: one per 31-byte chunk of the key, since 31 bytes is the most a field
/// holds whole.
pub global POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS: u32 = div_ceil(POST_QUANTUM_PUBLIC_KEY_SIZE_IN_BYTES, 31);

/// An account's post-quantum public key.
///
/// It is an ML-KEM-768 public key, which senders encapsulate to in order to establish a KEM shared secret with the
/// account. Read an account's key with
/// [`get_post_quantum_public_key`](crate::keys::post_quantum::registry::get_post_quantum_public_key).
///
/// The fields hold the key's bytes in 31-byte chunks.
#[derive(Deserialize, Eq, Serialize)]
pub struct PostQuantumPublicKey {
    pub fields: [Field; POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS],
}

/// Size of a [`KemSharedSecret`] in bytes, which is that of an ML-KEM-768 shared secret.
global KEM_SHARED_SECRET_SIZE_IN_BYTES: u32 = 32;

/// Size of a [`KemSharedSecret`] in fields: one per 31-byte chunk of the secret.
global KEM_SHARED_SECRET_SIZE_IN_FIELDS: u32 = div_ceil(KEM_SHARED_SECRET_SIZE_IN_BYTES, 31);

/// The secret an ML-KEM-768 encapsulation establishes.
///
/// Only whoever encapsulated to a [`PostQuantumPublicKey`], and the account the key belongs to, know it. The account
/// recovers it from the encapsulation's [`KemCiphertext`].
///
/// The fields hold the secret's bytes in 31-byte chunks.
#[derive(Eq)]
pub(crate) struct KemSharedSecret {
    pub(crate) fields: [Field; KEM_SHARED_SECRET_SIZE_IN_FIELDS],
}

/// Size in bytes of the seed of an encapsulation, which is all the randomness an ML-KEM-768 encapsulation draws on.
pub(crate) global KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES: u32 = 32;

/// Size of a [`KemCiphertext`] in bytes, which is that of an ML-KEM-768 ciphertext.
global KEM_CIPHERTEXT_SIZE_IN_BYTES: u32 = 1088;

/// Size of a [`KemCiphertext`] in fields: one per 31-byte chunk of the ciphertext.
global KEM_CIPHERTEXT_SIZE_IN_FIELDS: u32 = div_ceil(KEM_CIPHERTEXT_SIZE_IN_BYTES, 31);

/// The ciphertext of an ML-KEM-768 encapsulation.
///
/// It is what whoever encapsulated to a [`PostQuantumPublicKey`] hands the account the key belongs to, for them to
/// recover the encapsulation's [`KemSharedSecret`]. It reveals nothing about the secret to anyone else.
///
/// The fields hold the ciphertext's bytes in 31-byte chunks.
#[derive(Eq)]
pub(crate) struct KemCiphertext {
    pub(crate) fields: [Field; KEM_CIPHERTEXT_SIZE_IN_FIELDS],
}
