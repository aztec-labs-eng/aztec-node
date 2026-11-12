mod builder;
mod mode;
mod resolved_messaging_secret_strategy;
mod tag;
pub(crate) mod messaging_secret_derivation;
pub(crate) mod delivery_messaging_secret;
pub(crate) mod constrained_delivery;

pub mod handshake;

use crate::{
    context::PrivateContext,
    messages::{encryption::aes128, offchain_messages::deliver_offchain_message},
    oracle::notes::get_sender_for_tags,
    utils::remove_constraints::remove_constraints_if,
};
use crate::protocol::address::AztecAddress;
use messaging_secret_derivation::MessagingSecretDerivation;
use mode::DeliveryMode;
use tag::{derive_log_tag, resolve_delivery_messaging_secret};

pub use builder::{
    MessageDelivery, MessageDeliveryBuilder, OffchainDelivery, OnchainConstrainedDelivery, OnchainUnconstrainedDelivery,
};
pub use mode::OnchainDeliveryMode;
pub use resolved_messaging_secret_strategy::ResolvedMessagingSecretStrategy;

/// Deprecated: use [`ResolvedMessagingSecretStrategy`].
pub type ResolvedTaggingStrategy = ResolvedMessagingSecretStrategy;

/// Performs private delivery of a message to `recipient` according to `delivery_mode`.
///
/// The message is encoded into plaintext and then encrypted for `recipient`. This function takes a _function_ that
/// returns the plaintext instead of taking the plaintext directly in order to not waste constraints encoding the
/// message in scenarios where the plaintext will be encrypted with unconstrained encryption.
///
/// `maybe_note_hash_counter` is only relevant for on-chain delivery modes (i.e. via protocol logs): if a newly created
/// note hash's side effect counter is passed and constrained tagging is not in use, then the log will be squashed
/// alongside the note should its nullifier be emitted in the current transaction.
///
/// ## Privacy
///
/// The emitted log always has the same length regardless of `MESSAGE_PLAINTEXT_LEN`, because all message ciphertexts
/// also have the same length. This prevents accidental privacy leakage via the log length.
pub fn do_private_message_delivery<Env, let MESSAGE_PLAINTEXT_LEN: u32, D>(
    context: &mut PrivateContext,
    encode_into_message_plaintext: fn[Env]() -> [Field; MESSAGE_PLAINTEXT_LEN],
    maybe_note_hash_counter: Option<u32>,
    recipient: AztecAddress,
    delivery_mode: D,
)
where
    D: MessageDeliveryBuilder,
{
    let delivery = delivery_mode.build_message_delivery();

    let mode = delivery.mode();

    // This function relies on `mode` being a constant in order to reduce circuit constraints when
    // unconstrained usage is requested. If it were a runtime value the compiler would be unable to perform
    // dead-code elimination.
    mode.assert_is_constant();

    let deliver_as_offchain_message = mode == DeliveryMode::offchain();
    assert_constant(deliver_as_offchain_message);

    let sender_override = delivery.sender_override();
    let messaging_secret_derivation = delivery.messaging_secret_derivation();

    if deliver_as_offchain_message {
        do_offchain_private_message_delivery(context, encode_into_message_plaintext, recipient);
    } else {
        do_onchain_private_message_delivery(
            context,
            encode_into_message_plaintext,
            maybe_note_hash_counter,
            recipient,
            mode,
            sender_override,
            messaging_secret_derivation,
        );
    }
}

fn do_offchain_private_message_delivery<Env, let MESSAGE_PLAINTEXT_LEN: u32>(
    context: &mut PrivateContext,
    encode_into_message_plaintext: fn[Env]() -> [Field; MESSAGE_PLAINTEXT_LEN],
    recipient: AztecAddress,
) {
    let contract_address = context.this_address();
    let ciphertext = remove_constraints_if(
        true,
        || aes128::encrypt_with_ecdh_secret(encode_into_message_plaintext(), recipient, contract_address),
    );

    deliver_offchain_message(ciphertext, recipient);
}

fn do_onchain_private_message_delivery<Env, let MESSAGE_PLAINTEXT_LEN: u32>(
    context: &mut PrivateContext,
    encode_into_message_plaintext: fn[Env]() -> [Field; MESSAGE_PLAINTEXT_LEN],
    maybe_note_hash_counter: Option<u32>,
    recipient: AztecAddress,
    mode: DeliveryMode,
    sender_override: Option<AztecAddress>,
    messaging_secret_derivation: Option<MessagingSecretDerivation>,
) {
    let is_constrained = mode == DeliveryMode::onchain_constrained();
    assert_constant(is_constrained);

    // The messaging secret derivation, both whether one is set and which variant it is, must be a compile-time
    // constant so unused derivations are eliminated.
    assert_constant(messaging_secret_derivation.is_some());
    if messaging_secret_derivation.is_some() {
        messaging_secret_derivation.unwrap_unchecked().assert_kind_is_constant();
    }

    let onchain_mode = to_onchain_delivery_mode(mode);
    let sender = resolve_sender(sender_override);

    let delivery_messaging_secret = resolve_delivery_messaging_secret(
        context,
        onchain_mode,
        sender,
        recipient,
        messaging_secret_derivation,
    );

    // The message is encrypted with the secret that tags it, which by definition is known to the recipient when they
    // find the log, and they can therefore decrypt it. Under constrained delivery the messaging secret is constrained
    // when deriving the tag below.
    let messaging_secret = delivery_messaging_secret.secret();
    let ciphertext = remove_constraints_if(
        !is_constrained,
        || aes128::encrypt_with_messaging_secret(encode_into_message_plaintext(), messaging_secret),
    );

    let log_tag = derive_log_tag(
        delivery_messaging_secret,
        context,
        onchain_mode,
        sender,
        recipient,
    );

    // This value must be constant to avoid predicating the context calls below, which might result in
    // the context's arrays having unknown compile time write indices and hence dramatically increasing constraints
    // when accessing them. In practice this restriction is not a problem as we always know at compile time whether
    // we're emitting a note or non-note message.
    assert_constant(maybe_note_hash_counter.is_some());

    // Constrained-tagged logs must not be squashed alongside the note: the recipient discovers them by scanning
    // the per-secret tag sequence, so removing a log would break the index sequence.
    let squashable_note_log = maybe_note_hash_counter.is_some() & !is_constrained;

    let log = BoundedVec::from_array(ciphertext);
    if squashable_note_log {
        // We associate the log with the note's side effect counter, so that if the note ends up being squashed in
        // the current transaction, the log will be removed as well.
        context.emit_raw_note_log_unsafe(log_tag, log, maybe_note_hash_counter.unwrap());
    } else {
        context.emit_private_log_unsafe(log_tag, log);
    }
}

fn resolve_sender(sender_override: Option<AztecAddress>) -> AztecAddress {
    // Safety: tag senders are unconstrained; the sender comes from the builder override or the wallet-provided
    // default tag sender, which must be an account the PXE controls so it can own and recover the resulting
    // tagging/handshake state.
    unsafe {
        sender_override.unwrap_or_else(|| {
            get_sender_for_tags().expect(
                f"Sender for tags is not set when emitting a private log and no override is set. Ensure the wallet provides a default sender.",
            )
        })
    }
}

fn to_onchain_delivery_mode(mode: DeliveryMode) -> OnchainDeliveryMode {
    if mode == DeliveryMode::onchain_constrained() {
        OnchainDeliveryMode::onchain_constrained()
    } else {
        OnchainDeliveryMode::onchain_unconstrained()
    }
}

mod test {
    use crate::protocol::{address::AztecAddress, traits::FromField};
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::resolve_sender;
    use std::test::OracleMock;

    #[test(should_fail_with = "Sender for tags is not set")]
    unconstrained fn sender_resolution_requires_wallet_default_sender() {
        let env = TestEnvironment::new();
        let _ = OracleMock::mock("aztec_prv_getSenderForTags").returns(Option::<AztecAddress>::none());

        env.private_context(|_context| { let _ = resolve_sender(Option::none()); });
    }

    #[test]
    unconstrained fn sender_resolution_uses_override() {
        let env = TestEnvironment::new();
        let sender = AztecAddress::from_field(1);

        env.private_context(|_context| { assert_eq(resolve_sender(Option::some(sender)), sender); });
    }

    #[test]
    unconstrained fn sender_resolution_uses_wallet_default_sender() {
        let env = TestEnvironment::new();
        let sender = AztecAddress::from_field(1);
        let _ = OracleMock::mock("aztec_prv_getSenderForTags").returns(Option::some(sender));

        env.private_context(|_context| { assert_eq(resolve_sender(Option::none()), sender); });
    }
}
