use aztec::{
    facts::{deserialize_payload, Fact, FactScope, get_fact_collection, record_retractable_fact, serialize_payload},
    keys::post_quantum::mlkem768::PostQuantumPublicKey,
    oracle::block_reference::BlockReference,
    protocol::{address::AztecAddress, hash::sha256_to_field, traits::ToField},
};

/// Fact-collection type ID of the post-quantum public key caches.
///
/// Each account has its own collection, identified by the account's address, which caches the account's key so that
/// later reads need no node roundtrip.
///
/// ## Lifecycle
///
/// A collection is in one of two states:
///
/// - **Empty**: the account's key has not been found on this device.
/// - **Cached**: the collection holds a single `POST_QUANTUM_PUBLIC_KEY_READ` fact with the key.
///
/// The first read that finds the key takes the collection from **Empty** to **Cached**, with the block the key was
/// published in as the fact's origin. It only goes back to **Empty** if that block is re-orged out, which retracts the
/// fact. Reads never record a second fact, and collections are never deleted: a registered key never changes, so a
/// cached key never becomes stale (outside of reorgs).
///
/// ## Scope
///
/// Collections are in the [public scope](aztec::facts::FactScope::public), because a key is not tied to the account
/// reading it and is public anyway. All accounts therefore share the cached key. This only reveals to them that the
/// key has been read on this device before, not which account nor contract read it, and other contracts cannot access
/// the collection directly.
global POST_QUANTUM_PUBLIC_KEY_CACHE_TYPE_ID: Field = sha256_to_field(
    "POST_QUANTUM_PUBLIC_KEY_REGISTRY::POST_QUANTUM_PUBLIC_KEY_CACHE".as_bytes(),
);

/// Fact type ID of a key found on the node. Its payload is the key's fields.
global POST_QUANTUM_PUBLIC_KEY_READ: Field = sha256_to_field(
    "POST_QUANTUM_PUBLIC_KEY_REGISTRY::POST_QUANTUM_PUBLIC_KEY_READ".as_bytes(),
);

/// Returns `account`'s cached key, if it was cached and had been published by `anchor_block_number`.
pub(crate) unconstrained fn get_cached_public_key(
    contract_address: AztecAddress,
    account: AztecAddress,
    anchor_block_number: u32,
) -> Option<PostQuantumPublicKey> {
    get_fact_collection(
        contract_address,
        FactScope::public(),
        POST_QUANTUM_PUBLIC_KEY_CACHE_TYPE_ID,
        account.to_field(),
    )
        .and_then(|collection| collection.facts.find(|fact: Fact| fact.fact_type_id == POST_QUANTUM_PUBLIC_KEY_READ))
        // A key published after the anchor block had not been registered as of it, so the cache cannot answer.
        .filter(|fact: Fact| fact.origin_block.unwrap().block_number <= anchor_block_number)
        .map(|fact: Fact| deserialize_payload(fact.payload))
}

/// Caches `account`'s key, published in `origin_block`.
pub(crate) unconstrained fn record_cached_public_key(
    contract_address: AztecAddress,
    account: AztecAddress,
    public_key: PostQuantumPublicKey,
    origin_block: BlockReference,
) {
    record_retractable_fact(
        contract_address,
        FactScope::public(),
        POST_QUANTUM_PUBLIC_KEY_CACHE_TYPE_ID,
        account.to_field(),
        POST_QUANTUM_PUBLIC_KEY_READ,
        serialize_payload(public_key),
        origin_block,
    );
}
