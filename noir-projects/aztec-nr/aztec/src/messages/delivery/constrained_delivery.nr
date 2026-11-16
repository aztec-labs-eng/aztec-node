//! Sender-side helpers for constrained message delivery.
//!
//! [`MessageDelivery::onchain_constrained`](super::MessageDelivery::onchain_constrained) describes the sequences that
//! constrained messages form, and what they mean for the transactions that deliver them. This explains how they are
//! enforced.
//!
//! ## Sequences
//!
//! The send at index 0 anchors the sequence's messaging secret, proving that the recipient can derive it. Every send
//! emits a sequence nullifier for its index, and every later send proves that its predecessor's exists. There are two
//! kinds of sequences:
//!
//! - per `(sender, recipient, handshake secrets)`, anchored to the handshake registry by
//!   [`constrain_preexisting_handshake_secrets`], or by the registry call that creates the handshake.
//! - per `(recipient, recipient-tsk messaging secret)`, anchored to the recipient's tagging key by
//!   [`constrain_recipient_tsk_secret`]. Every sender to the recipient extends the same sequence.
//!
//! Concurrent sends on one sequence collide on its nullifiers or fail the predecessor check. Concurrent first sends on
//! different sequences can collide too: anchoring an existing handshake calls the registry's `validate_handshake`,
//! which nullifies and recreates the handshake's note, so first sends for the same `(sender, recipient)` from different
//! contracts collide on that note. Batching onto a handshake sequence needs a committed handshake, as a send only finds
//! handshakes from earlier transactions (see
//! [`get_existing_app_siloed_handshake_secrets`](super::handshake::get_existing_app_siloed_handshake_secrets)).
//!
//! ## Protection from third parties
//!
//! Anyone who could emit a sequence's next nullifier first would make the legitimate send fail as a duplicate, and
//! could keep doing so on every retry. Each sequence nullifier therefore includes a secret that only the sequence's
//! senders know: the handshake's sender-only secret for a handshake sequence (see
//! [`compute_handshake_sequence_nullifier`]), and the messaging secret itself for a recipient-tsk sequence (see
//! [`compute_recipient_tsk_sequence_nullifier`]).
//!
//! The handshake registry also keeps a recipient from forging a second handshake with the same messaging secret (see
//! [`protect_from_forgery`](crate::messages::delivery::handshake::protect_from_forgery)).

use crate::context::PrivateContext;
use crate::keys::getters::get_public_keys;
use crate::messages::delivery::handshake::{AppSiloedHandshakeSecrets, VALIDATE_HANDSHAKE_SELECTOR};
use crate::messages::delivery::messaging_secret_derivation::compute_recipient_tsk_messaging_secret;
use crate::nullifier::utils::compute_nullifier_existence_request;

use crate::protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField};

/// Domain separator for the sequence nullifiers of constrained delivery with a handshake from the registry.
///
/// Without backwards compatibility it would be named `DOM_SEP__HANDSHAKE_SEQUENCE_NULLIFIER`, after
/// [`compute_handshake_sequence_nullifier`]. Its value is derived from its name, so renaming it would change the
/// nullifiers of every existing handshake sequence, and the next send on each would fail its predecessor check.
// TODO(F-961): rename to `DOM_SEP__HANDSHAKE_SEQUENCE_NULLIFIER`.
pub(crate) global DOM_SEP__CONSTRAINED_MSG_NULLIFIER: u32 = 3723577546;

/// Domain separator for the sequence nullifiers of constrained delivery with a recipient-tsk messaging secret.
pub(crate) global DOM_SEP__RECIPIENT_TSK_SEQUENCE_NULLIFIER: u32 = 3135815231;

/// Anchors a pre-existing handshake's untrusted `(secrets, index)` to the registry before its constrained tag is
/// emitted.
///
/// - at index 0: `validate_handshake` binds the oracle-supplied secrets to the stored handshake.
/// - at index > 0: the prior sequence nullifier must exist, anchoring back to the index-0 check.
pub(crate) fn constrain_preexisting_handshake_secrets(
    context: &mut PrivateContext,
    registry: AztecAddress,
    sender: AztecAddress,
    recipient: AztecAddress,
    secrets: AppSiloedHandshakeSecrets,
    index: u32,
) {
    if index == 0 {
        let _ = context.call_private_function(
            registry,
            VALIDATE_HANDSHAKE_SELECTOR,
            [sender.to_field(), recipient.to_field(), secrets.shared, secrets.sender_only],
        );
    } else {
        let prev_nullifier = compute_handshake_sequence_nullifier(sender, recipient, secrets, index - 1);
        let caller = context.this_address();
        context.assert_nullifier_exists(compute_nullifier_existence_request(prev_nullifier, caller));
    }
}

/// Emits a constrained send's sequence nullifier, so the next send under the same `(sender, recipient, secrets)`
/// sequence can prove its predecessor exists.
pub(crate) fn emit_handshake_sequence_nullifier(
    context: &mut PrivateContext,
    sender: AztecAddress,
    recipient: AztecAddress,
    secrets: AppSiloedHandshakeSecrets,
    index: u32,
) {
    context.push_nullifier_unsafe(compute_handshake_sequence_nullifier(sender, recipient, secrets, index));
}

/// Computes a handshake sequence's nullifier at `index`.
///
/// The shared secret binds the sequence to its tag stream, and the sender-only secret is the one only the sender knows
/// (see [`AppSiloedHandshakeSecrets::sender_only`] and this module's documentation).
pub(crate) fn compute_handshake_sequence_nullifier(
    sender: AztecAddress,
    recipient: AztecAddress,
    secrets: AppSiloedHandshakeSecrets,
    index: u32,
) -> Field {
    poseidon2_hash_with_separator(
        [sender.to_field(), recipient.to_field(), secrets.shared, secrets.sender_only, index as Field],
        DOM_SEP__CONSTRAINED_MSG_NULLIFIER,
    )
}

/// Anchors an untrusted recipient-tsk `(secret, index)` before its constrained tag is emitted.
///
/// - at index 0: the secret must be the one derived from `recipient`'s app-siloed tagging key, which the kernel
///   validates against the tagging public key in `recipient`'s address preimage.
/// - at index > 0: the prior sequence nullifier for `recipient` must exist, anchoring back to the index-0 check for
///   that same recipient.
pub(crate) fn constrain_recipient_tsk_secret(
    context: &mut PrivateContext,
    recipient: AztecAddress,
    secret: Field,
    index: u32,
) {
    if index == 0 {
        let tsk_app = context.request_tsk_app(get_public_keys(recipient).tpk_m_hash);
        assert_eq(
            secret,
            compute_recipient_tsk_messaging_secret(tsk_app, recipient),
            "messaging secret does not derive from the recipient's tagging key",
        );
    } else {
        let prev_nullifier = compute_recipient_tsk_sequence_nullifier(recipient, secret, index - 1);
        let caller = context.this_address();
        context.assert_nullifier_exists(compute_nullifier_existence_request(prev_nullifier, caller));
    }
}

/// Emits a constrained recipient-tsk send's sequence nullifier, so the next send under the same `(recipient, secret)`
/// can prove its predecessor exists.
pub(crate) fn emit_recipient_tsk_sequence_nullifier(
    context: &mut PrivateContext,
    recipient: AztecAddress,
    secret: Field,
    index: u32,
) {
    context.push_nullifier_unsafe(compute_recipient_tsk_sequence_nullifier(recipient, secret, index));
}

/// Computes a recipient-tsk sequence's nullifier at `index`.
///
/// The messaging secret is the one only the sequence's senders know (see this module's documentation), as deriving it
/// takes the recipient's tagging key. It binds no sender, so every sender to the recipient extends one sequence. It
/// does bind the recipient, as nothing checks the secret against the recipient after index 0: without it, a sender
/// could continue the sequence of another account whose keys it holds, tagging the message for that account so that the
/// recipient never discovers it.
pub(crate) fn compute_recipient_tsk_sequence_nullifier(recipient: AztecAddress, secret: Field, index: u32) -> Field {
    poseidon2_hash_with_separator(
        [recipient.to_field(), secret, index as Field],
        DOM_SEP__RECIPIENT_TSK_SEQUENCE_NULLIFIER,
    )
}

mod test {
    use crate::hash::hash_args;
    use crate::history::nullifier::assert_nullifier_existed_by;
    use crate::keys::getters::get_public_keys;
    use crate::messages::delivery::handshake::{AppSiloedHandshakeSecrets, VALIDATE_HANDSHAKE_SELECTOR};
    use crate::messages::delivery::messaging_secret_derivation::get_recipient_tsk_messaging_secret;
    use crate::protocol::{address::AztecAddress, hash::compute_siloed_nullifier, traits::{FromField, ToField}};
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::{
        compute_handshake_sequence_nullifier, compute_recipient_tsk_sequence_nullifier,
        constrain_preexisting_handshake_secrets, constrain_recipient_tsk_secret, emit_handshake_sequence_nullifier,
        emit_recipient_tsk_sequence_nullifier,
    };
    use std::test::OracleMock;

    #[test]
    unconstrained fn emit_handshake_sequence_nullifier_pushes_the_sequence_nullifier() {
        let env = TestEnvironment::new();
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };
        let index: u32 = 0;

        env.private_context(|context| {
            emit_handshake_sequence_nullifier(context, sender, recipient, secrets, index);

            assert_eq(context.nullifiers.len(), 1);
            assert_eq(
                context.nullifiers.get(0).inner.value,
                compute_handshake_sequence_nullifier(sender, recipient, secrets, index),
            );
            assert_eq(context.private_call_requests.len(), 0);
            assert_eq(context.nullifier_read_requests.len(), 0);
        });
    }

    #[test]
    unconstrained fn reused_secret_at_index_zero_validates_against_the_registry() {
        let env = TestEnvironment::new();
        let registry = AztecAddress::from_field(1);
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };

        env.private_context(|context| {
            // The real registry call is covered by integration tests; this unit test only needs a coherent child
            // call result so `PrivateContext` records the request.
            let child_call_end_counter = context.get_side_effect_counter() + 1;
            let empty_returns_hash: Field = 0;
            let _ = OracleMock::mock("aztec_prv_callPrivateFunction")
                .returns((child_call_end_counter, empty_returns_hash))
                .times(1);

            constrain_preexisting_handshake_secrets(context, registry, sender, recipient, secrets, 0);

            assert_eq(context.nullifier_read_requests.len(), 0);
            assert_eq(context.private_call_requests.len(), 1);

            let request = context.private_call_requests.get(0);
            assert_eq(request.call_context.msg_sender, context.this_address());
            assert_eq(request.call_context.contract_address, registry);
            assert_eq(request.call_context.function_selector, VALIDATE_HANDSHAKE_SELECTOR);
            assert(!request.call_context.is_static_call);
            assert_eq(
                request.args_hash,
                hash_args(
                    [sender.to_field(), recipient.to_field(), secrets.shared, secrets.sender_only],
                ),
            );
        });
    }

    #[test]
    unconstrained fn reused_secret_above_index_zero_reads_the_previous_nullifier() {
        let env = TestEnvironment::new();
        let registry = AztecAddress::from_field(1);
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };
        let index: u32 = 3;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false).times(1);

            constrain_preexisting_handshake_secrets(context, registry, sender, recipient, secrets, index);

            assert_eq(context.private_call_requests.len(), 0);
            assert_eq(context.nullifier_read_requests.len(), 1);

            let read_request = context.nullifier_read_requests.get(0);
            assert_eq(read_request.contract_address, AztecAddress::zero());
            assert_eq(
                read_request.inner.inner,
                compute_siloed_nullifier(
                    context.this_address(),
                    compute_handshake_sequence_nullifier(sender, recipient, secrets, index - 1),
                ),
            );
        });
    }

    // The shared secret must bind to the sender's chain: without it, a prover holding a fixed `sender_only` could
    // extend a sequence at index > 0 using another valid sequence's predecessor but a different (malicious) shared
    // secret, which then derives the log tag, so the recipient scans the wrong tag and never finds the note.
    #[test]
    fn shared_secret_changes_sequence_nullifier() {
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets_a = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };
        let secrets_b = AppSiloedHandshakeSecrets { shared: 8765, sender_only: secrets_a.sender_only };

        assert(
            compute_handshake_sequence_nullifier(sender, recipient, secrets_a, 0)
                != compute_handshake_sequence_nullifier(sender, recipient, secrets_b, 0),
        );
    }

    // The sender-only secret is what keeps the recipient, who knows the shared secret, from emitting the sequence's
    // nullifiers.
    #[test]
    fn sender_only_secret_changes_sequence_nullifier() {
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets_a = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };
        let secrets_b = AppSiloedHandshakeSecrets { shared: secrets_a.shared, sender_only: 9012 };

        assert(
            compute_handshake_sequence_nullifier(sender, recipient, secrets_a, 0)
                != compute_handshake_sequence_nullifier(sender, recipient, secrets_b, 0),
        );
    }

    // Each sequence position must hash to a distinct nullifier: a collision across indices would let a send at one
    // position satisfy its predecessor check against another position's nullifier, breaking the strict ordering.
    #[test]
    fn index_changes_sequence_nullifier() {
        let sender = AztecAddress::from_field(2);
        let recipient = AztecAddress::from_field(4);
        let secrets = AppSiloedHandshakeSecrets { shared: 1234, sender_only: 5678 };

        assert(
            compute_handshake_sequence_nullifier(sender, recipient, secrets, 0)
                != compute_handshake_sequence_nullifier(sender, recipient, secrets, 1),
        );
    }

    #[test]
    unconstrained fn recipient_tsk_secret_at_index_zero_validates_the_recipient_tagging_key() {
        let mut env = TestEnvironment::new();
        let app = env.create_contract_account();
        let recipient = env.create_light_account();

        env.private_context_at(app, |context| {
            let secret = get_recipient_tsk_messaging_secret(recipient);

            constrain_recipient_tsk_secret(context, recipient, secret, 0);

            assert_eq(context.nullifier_read_requests.len(), 0);
            assert_eq(context.key_validation_requests_and_separators.len(), 1);
            assert_eq(
                context.key_validation_requests_and_separators.get(0).request.pk_m_hash,
                get_public_keys(recipient).tpk_m_hash,
            );
        });
    }

    #[test(should_fail_with = "messaging secret does not derive from the recipient's tagging key")]
    unconstrained fn recipient_tsk_secret_at_index_zero_rejects_a_secret_not_derived_from_the_tagging_key() {
        let mut env = TestEnvironment::new();
        let app = env.create_contract_account();
        let recipient = env.create_light_account();

        env.private_context_at(app, |context| {
            let secret = get_recipient_tsk_messaging_secret(recipient) + 1;

            constrain_recipient_tsk_secret(context, recipient, secret, 0);
        });
    }

    #[test(should_fail_with = "messaging secret does not derive from the recipient's tagging key")]
    unconstrained fn recipient_tsk_secret_at_index_zero_rejects_another_account_secret() {
        let mut env = TestEnvironment::new();
        let app = env.create_contract_account();
        let recipient = env.create_light_account();
        let other_account = env.create_light_account();

        env.private_context_at(app, |context| {
            let secret = get_recipient_tsk_messaging_secret(other_account);

            constrain_recipient_tsk_secret(context, recipient, secret, 0);
        });
    }

    #[test]
    unconstrained fn recipient_tsk_secret_above_index_zero_reads_the_previous_nullifier() {
        let env = TestEnvironment::new();
        let recipient = AztecAddress::from_field(4);
        let secret = 1234;
        let index: u32 = 3;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false).times(1);

            constrain_recipient_tsk_secret(context, recipient, secret, index);

            assert_eq(context.key_validation_requests_and_separators.len(), 0);
            assert_eq(context.nullifier_read_requests.len(), 1);

            let read_request = context.nullifier_read_requests.get(0);
            assert_eq(read_request.contract_address, AztecAddress::zero());
            assert_eq(
                read_request.inner.inner,
                compute_siloed_nullifier(
                    context.this_address(),
                    compute_recipient_tsk_sequence_nullifier(recipient, secret, index - 1),
                ),
            );
        });
    }

    // A sender holding another account's keys can hint that account's anchored secret for a different recipient. The
    // message would then be tagged for that account, and the recipient would never discover it.
    #[test(should_fail_with = "Nullifier membership witness not found")]
    unconstrained fn recipient_tsk_secret_above_index_zero_rejects_a_sequence_anchored_for_another_recipient() {
        let mut env = TestEnvironment::new();
        let app = env.create_contract_account();
        let recipient = env.create_light_account();
        let other_recipient = env.create_light_account();

        let anchored_secret = env.private_context_at(app, |context| {
            let secret = get_recipient_tsk_messaging_secret(other_recipient);
            constrain_recipient_tsk_secret(context, other_recipient, secret, 0);
            emit_recipient_tsk_sequence_nullifier(context, other_recipient, secret, 0);
            secret
        });

        env.private_context_at(app, |context| {
            constrain_recipient_tsk_secret(context, recipient, anchored_secret, 1);

            // The kernel accepts the predecessor read only if the nullifier it names exists.
            let predecessor_read = context.nullifier_read_requests.get(0);
            assert_nullifier_existed_by(
                context.get_anchor_block_header(),
                predecessor_read.inner.inner,
            );
        });
    }

    #[test]
    unconstrained fn emit_recipient_tsk_sequence_nullifier_pushes_the_sequence_nullifier() {
        let env = TestEnvironment::new();
        let recipient = AztecAddress::from_field(4);
        let secret = 1234;
        let index: u32 = 0;

        env.private_context(|context| {
            emit_recipient_tsk_sequence_nullifier(context, recipient, secret, index);

            assert_eq(context.nullifiers.len(), 1);
            assert_eq(
                context.nullifiers.get(0).inner.value,
                compute_recipient_tsk_sequence_nullifier(recipient, secret, index),
            );
        });
    }

    // The secret binds the sequence to the tag stream it discovers.
    #[test]
    fn secret_changes_recipient_tsk_sequence_nullifier() {
        let recipient = AztecAddress::from_field(4);

        assert(
            compute_recipient_tsk_sequence_nullifier(recipient, 1234, 0)
                != compute_recipient_tsk_sequence_nullifier(recipient, 8765, 0),
        );
    }

    #[test]
    fn index_changes_recipient_tsk_sequence_nullifier() {
        let recipient = AztecAddress::from_field(4);

        assert(
            compute_recipient_tsk_sequence_nullifier(recipient, 1234, 0)
                != compute_recipient_tsk_sequence_nullifier(recipient, 1234, 1),
        );
    }
}
