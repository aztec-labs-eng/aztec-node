use aztec::{
    context::PrivateContext,
    ephemeral::EphemeralArray,
    keys::post_quantum::{
        mlkem768::{POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS, PostQuantumPublicKey},
        registry::DOM_SEP__POST_QUANTUM_PUBLIC_KEY_REGISTRY_LOG_TAG,
    },
    messages::processing::{
        log_retrieval_request::{LogRetrievalRequest, LogSource},
        log_retrieval_response::LogRetrievalResponse,
    },
    oracle::{block_reference::BlockReference, message_processing::get_logs_by_tag},
    protocol::{
        address::AztecAddress, constants::PRIVATE_LOG_CIPHERTEXT_LEN, hash::poseidon2_hash_with_separator,
        traits::ToField,
    },
    utils::math::div_ceil,
};

/// Number of chunks a key is split into, each published in its own private log, since a log carries at most
/// `PRIVATE_LOG_CIPHERTEXT_LEN` fields besides its tag.
pub(crate) global PUBLIC_KEY_CHUNK_COUNT: u32 = div_ceil(
    POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS,
    PRIVATE_LOG_CIPHERTEXT_LEN,
);

/// Publishes `account`'s key in [`PUBLIC_KEY_CHUNK_COUNT`] private logs, the `i`-th holding chunk `i` of the key under
/// [`public_key_log_tag`]`(account, i)`.
///
/// Chunk `i` is the `PRIVATE_LOG_CIPHERTEXT_LEN` fields of the key from field `i * PRIVATE_LOG_CIPHERTEXT_LEN` on,
/// except for the last chunk, which only holds the fields that remain and has no padding.
pub(crate) fn emit_public_key_logs(
    context: &mut PrivateContext,
    account: AztecAddress,
    public_key: PostQuantumPublicKey,
) {
    // The key is published in private logs because account contracts typically run in private, so registering needs
    // no public execution, which makes it cheaper. This makes neither the registration nor the key private: anyone who
    // knows the account's address can find the logs, and they hold the key in the clear.
    for chunk_index in 0..PUBLIC_KEY_CHUNK_COUNT {
        let offset = chunk_index * PRIVATE_LOG_CIPHERTEXT_LEN;
        let mut chunk = BoundedVec::new();
        for i in 0..chunk_len(chunk_index) {
            chunk.push(public_key.fields[offset + i]);
        }

        // Each chunk has its own tag, so that a reader that knows the account can fetch all the chunks in one go, and
        // tell which chunk each log holds.
        context.emit_private_log_unsafe(public_key_log_tag(account, chunk_index), chunk);
    }
}

/// Returns `account`'s key and the block it was published in, or `None` if it had not been published by the anchor
/// block.
pub(crate) unconstrained fn find_public_key(
    contract_address: AztecAddress,
    account: AztecAddress,
) -> Option<(PostQuantumPublicKey, BlockReference)> {
    let requests = EphemeralArray::empty();
    for chunk_index in 0..PUBLIC_KEY_CHUNK_COUNT {
        requests.push(
            LogRetrievalRequest {
                contract_address,
                unsiloed_tag: public_key_log_tag(account, chunk_index),
                source: LogSource.PRIVATE,
                from_block: Option::none(),
                to_block: Option::none(),
            },
        );
    }
    // Chunk tags are unique per account, and an account registers only once, in a single transaction. So each chunk
    // has exactly one log, and either all chunks are found or none are.
    let logs_per_chunk = get_logs_by_tag(requests);

    if logs_per_chunk.all(|logs: EphemeralArray<LogRetrievalResponse>| logs.len() == 0) {
        Option::none()
    } else {
        let first_log = single_log(logs_per_chunk, account, 0);

        let mut fields = [0; POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS];
        for chunk_index in 0..PUBLIC_KEY_CHUNK_COUNT {
            let log = single_log(logs_per_chunk, account, chunk_index);
            let tx_hash = log.tx_hash;
            let first_tx_hash = first_log.tx_hash;
            assert(
                tx_hash == first_tx_hash,
                f"Chunk {chunk_index} of the post-quantum public key of {account} was published in tx {tx_hash}, but chunk 0 in tx {first_tx_hash}",
            );

            let offset = chunk_index * PRIVATE_LOG_CIPHERTEXT_LEN;
            let expected_len = chunk_len(chunk_index);
            let len = log.log_payload.len();
            assert(
                len == expected_len,
                f"Chunk {chunk_index} of the post-quantum public key of {account} has {len} fields, expected {expected_len}",
            );
            for i in 0..len {
                fields[offset + i] = log.log_payload.get(i);
            }
        }

        Option::some((
            PostQuantumPublicKey { fields },
            BlockReference { block_number: first_log.block_number, block_hash: first_log.block_hash },
        ))
    }
}

/// Returns the only log found for chunk `chunk_index` of `account`'s key.
unconstrained fn single_log(
    logs_per_chunk: EphemeralArray<EphemeralArray<LogRetrievalResponse>>,
    account: AztecAddress,
    chunk_index: u32,
) -> LogRetrievalResponse {
    let logs = logs_per_chunk.get(chunk_index);
    let count = logs.len();
    assert(
        count == 1,
        f"Found {count} logs for chunk {chunk_index} of the post-quantum public key of {account}, expected 1",
    );
    logs.get(0)
}

/// Number of fields of the key in chunk `chunk_index`.
fn chunk_len(chunk_index: u32) -> u32 {
    std::cmp::min(
        PRIVATE_LOG_CIPHERTEXT_LEN,
        POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS - chunk_index * PRIVATE_LOG_CIPHERTEXT_LEN,
    )
}

/// Tag of the log holding chunk `chunk_index` of `account`'s key.
pub(crate) fn public_key_log_tag(account: AztecAddress, chunk_index: u32) -> Field {
    poseidon2_hash_with_separator(
        [account.to_field(), chunk_index as Field],
        DOM_SEP__POST_QUANTUM_PUBLIC_KEY_REGISTRY_LOG_TAG,
    )
}
