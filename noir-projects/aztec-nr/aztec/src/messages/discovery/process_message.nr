use crate::messages::{
    discovery::{
        ComputeNoteHash, ComputeNoteNullifier, CustomMessageHandler, private_events::process_private_event_msg,
        private_notes::process_private_note_msg,
    },
    encoding::{decode_message, MESSAGE_CIPHERTEXT_LEN, MESSAGE_PLAINTEXT_LEN},
    encryption::aes128,
    msg_type::{
        MIN_CUSTOM_MSG_TYPE_ID, PARTIAL_NOTE_PRIVATE_MSG_TYPE_ID, PRIVATE_EVENT_MSG_TYPE_ID, PRIVATE_NOTE_MSG_TYPE_ID,
    },
    processing::ResolvedTx,
};

use crate::logging::{aztecnr_debug_log, aztecnr_warn_log_format};
use crate::partial_notes::process_partial_note_private_msg;
use crate::protocol::address::AztecAddress;

/// Processes a message that can contain notes, partial notes, or events.
///
/// Notes result in nonce discovery being performed prior to delivery, which requires knowledge of the transaction hash
/// in which the notes would've been created (typically the same transaction in which the log was emitted), along with
/// the list of unique note hashes in said transaction and the `compute_note_hash` and `compute_note_nullifier`
/// functions. Once discovered, the notes are enqueued for validation.
///
/// Partial notes result in a pending partial note entry being stored in a PXE capsule, which will later be retrieved
/// to search for the note's completion public log.
///
/// Events are processed by computing an event commitment from the serialized event data and its randomness field, then
/// enqueueing the event data and commitment for validation.
///
/// `messaging_secret` is the secret whose tag found the message, for messages delivered onchain, and `None` for
/// messages delivered offchain.
pub unconstrained fn process_message_ciphertext(
    contract_address: AztecAddress,
    compute_note_hash: ComputeNoteHash,
    compute_note_nullifier: ComputeNoteNullifier,
    process_custom_message: Option<CustomMessageHandler>,
    message_ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    messaging_secret: Option<Field>,
    resolved_tx: ResolvedTx,
    recipient: AztecAddress,
) {
    let message_plaintext_option = decrypt_message_ciphertext(
        message_ciphertext,
        messaging_secret,
        recipient,
        contract_address,
    );

    if message_plaintext_option.is_some() {
        process_message_plaintext(
            contract_address,
            compute_note_hash,
            compute_note_nullifier,
            process_custom_message,
            message_plaintext_option.unwrap(),
            resolved_tx,
            recipient,
        );
    } else {
        aztecnr_warn_log_format!("Could not decrypt message ciphertext from tx {0}, ignoring")([resolved_tx.tx_hash]);
    }
}

/// Decrypts a message with its messaging secret or address keys.
unconstrained fn decrypt_message_ciphertext(
    message_ciphertext: BoundedVec<Field, MESSAGE_CIPHERTEXT_LEN>,
    messaging_secret: Option<Field>,
    recipient: AztecAddress,
    contract_address: AztecAddress,
) -> Option<BoundedVec<Field, MESSAGE_PLAINTEXT_LEN>> {
    messaging_secret.and_then(|secret| aes128::decrypt_with_messaging_secret(message_ciphertext, secret)).or_else(|| {
        // In most cases, we'd attempt decryption with the address keys only if the messaging secret is not present.
        // There are some rare scenarios however in which we _do_ have a messaging secret, but decryption using it fails
        // and so we fall back to this mechanism. These include contracts that are upgraded from a version that did not
        // encrypt with messaging secrets to one that does, and therefore would need to process older messages.
        //
        // However, this opens the door for an annoying situation: a message encrypted with no messaging secret might
        // still be successfully decrypted into garbage data which nonetheless has the right shape for a message. Its
        // processing would later fail (e.g. because it references a note that doesn't actually exist), but we'd be
        // skipping decryption with the address keys, which is the one path that would've yielded the correct result.
        //
        // We consider this risk to be acceptable because a) the number of these messages that a contract would need to
        // process is finite and bounded (as e.g. it'd not emit any more after the upgrade), and b) decrypting with the
        // wrong messaging secret fails except with probability around 2^-112, which is how often a wrongly decrypted
        // header has the exact length of a valid one.
        aes128::decrypt_with_ecdh_secret(message_ciphertext, recipient, contract_address)
    })
}

pub(crate) unconstrained fn process_message_plaintext(
    contract_address: AztecAddress,
    compute_note_hash: ComputeNoteHash,
    compute_note_nullifier: ComputeNoteNullifier,
    process_custom_message: Option<CustomMessageHandler>,
    message_plaintext: BoundedVec<Field, MESSAGE_PLAINTEXT_LEN>,
    resolved_tx: ResolvedTx,
    recipient: AztecAddress,
) {
    // The first thing to do after decrypting the message is to determine what type of message we're processing. We
    // have 3 message types: private notes, partial notes and events.

    // We decode the message to obtain the message type id, metadata and content.
    let decoded = decode_message(message_plaintext);

    if decoded.is_some() {
        let (msg_type_id, msg_metadata, msg_content) = decoded.unwrap();

        if msg_type_id == PRIVATE_NOTE_MSG_TYPE_ID {
            aztecnr_debug_log!("Processing private note msg");

            process_private_note_msg(
                contract_address,
                resolved_tx.tx_hash,
                resolved_tx.unique_note_hashes_in_tx,
                resolved_tx.first_nullifier_in_tx,
                compute_note_hash,
                compute_note_nullifier,
                msg_metadata,
                msg_content,
            );
        } else if msg_type_id == PARTIAL_NOTE_PRIVATE_MSG_TYPE_ID {
            aztecnr_debug_log!("Processing partial note private msg");

            process_partial_note_private_msg(
                contract_address,
                msg_metadata,
                msg_content,
                resolved_tx,
                recipient,
            );
        } else if msg_type_id == PRIVATE_EVENT_MSG_TYPE_ID {
            aztecnr_debug_log!("Processing private event msg");

            process_private_event_msg(
                contract_address,
                msg_metadata,
                msg_content,
                resolved_tx.tx_hash,
            );
        } else if msg_type_id < MIN_CUSTOM_MSG_TYPE_ID {
            // The message type ID falls in the range reserved for aztec.nr built-in types but wasn't matched above.
            // This most likely means the message is malformed or a custom message was incorrectly assigned a reserved
            // ID. Custom message types must use IDs allocated via `custom_msg_type_id`.
            aztecnr_warn_log_format!(
                "Message type ID {0} is in the reserved range but is not recognized, ignoring. See https://docs.aztec.network/errors/3",
            )(
                [msg_type_id as Field],
            );
        } else if process_custom_message.is_some() {
            process_custom_message.unwrap()(
                contract_address,
                msg_type_id,
                msg_metadata,
                msg_content,
                resolved_tx,
                recipient,
            );
        } else {
            // A custom message was received but no handler is configured. This likely means the contract emits custom
            // messages but forgot to register a handler via `AztecConfig::custom_message_handler`.
            aztecnr_warn_log_format!(
                "Received custom message with type id {0} but no handler is configured, ignoring. See https://docs.aztec.network/errors/2",
            )(
                [msg_type_id as Field],
            );
        }
    } else {
        aztecnr_warn_log_format!("Could not decode message plaintext from tx {0}, ignoring")([resolved_tx.tx_hash]);
    }
}

mod test {
    use crate::messages::encryption::aes128;
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::decrypt_message_ciphertext;

    global PLAINTEXT: [Field; 3] = [1, 2, 3];
    global MESSAGING_SECRET: Field = 42;

    #[test]
    unconstrained fn decrypts_with_the_messaging_secret() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        env.private_context(|context| {
            let ciphertext = aes128::encrypt_with_messaging_secret(PLAINTEXT, MESSAGING_SECRET);

            assert_eq(
                decrypt_message_ciphertext(
                    BoundedVec::from_array(ciphertext),
                    Option::some(MESSAGING_SECRET),
                    recipient,
                    context.this_address(),
                )
                    .unwrap(),
                BoundedVec::from_array(PLAINTEXT),
            );
        });
    }

    #[test]
    unconstrained fn falls_back_to_the_address_keys_when_the_messaging_secret_fails() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        env.private_context(|context| {
            let contract_address = context.this_address();
            let ciphertext = aes128::encrypt_with_ecdh_secret(PLAINTEXT, recipient, contract_address);

            assert_eq(
                decrypt_message_ciphertext(
                    BoundedVec::from_array(ciphertext),
                    Option::some(MESSAGING_SECRET),
                    recipient,
                    contract_address,
                )
                    .unwrap(),
                BoundedVec::from_array(PLAINTEXT),
            );
        });
    }

    #[test]
    unconstrained fn decrypts_with_the_address_keys_without_a_messaging_secret() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        env.private_context(|context| {
            let contract_address = context.this_address();
            let ciphertext = aes128::encrypt_with_ecdh_secret(PLAINTEXT, recipient, contract_address);

            assert_eq(
                decrypt_message_ciphertext(
                    BoundedVec::from_array(ciphertext),
                    Option::none(),
                    recipient,
                    contract_address,
                )
                    .unwrap(),
                BoundedVec::from_array(PLAINTEXT),
            );
        });
    }

    #[test]
    unconstrained fn fails_when_neither_the_messaging_secret_nor_the_address_keys_decrypt() {
        let mut env = TestEnvironment::new();
        let recipient = env.create_light_account();

        env.private_context(|context| {
            let ciphertext = aes128::encrypt_with_messaging_secret(PLAINTEXT, MESSAGING_SECRET);

            assert(decrypt_message_ciphertext(
                BoundedVec::from_array(ciphertext),
                Option::some(MESSAGING_SECRET + 1),
                recipient,
                context.this_address(),
            )
                .is_none());
        });
    }
}
