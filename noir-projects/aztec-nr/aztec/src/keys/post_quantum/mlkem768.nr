use crate::{protocol::traits::{Deserialize, Serialize}, utils::math::div_ceil};

/// Size of a [`PostQuantumPublicKey`] in bytes, which is that of an ML-KEM-768 public key.
global POST_QUANTUM_PUBLIC_KEY_SIZE_IN_BYTES: u32 = 1184;

/// Size of a [`PostQuantumPublicKey`] in fields: one per 31-byte chunk of the key, since 31 bytes is the most a field
/// holds whole.
pub global POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS: u32 = div_ceil(POST_QUANTUM_PUBLIC_KEY_SIZE_IN_BYTES, 31);

/// An account's post-quantum public key.
///
/// It is an ML-KEM-768 public key, which senders encapsulate to in order to establish a post-quantum shared secret
/// with the account. Read an account's key with
/// [`get_post_quantum_public_key`](crate::keys::post_quantum::registry::get_post_quantum_public_key).
///
/// The fields hold the key's bytes in 31-byte chunks.
#[derive(Deserialize, Eq, Serialize)]
pub struct PostQuantumPublicKey {
    pub fields: [Field; POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS],
}
