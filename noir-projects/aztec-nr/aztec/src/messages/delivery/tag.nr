//! Messaging secret resolution and discovery tag derivation for on-chain message delivery.
//!
//! Constrained derivation also emits the sequence nullifier; see [`super::constrained_delivery`].

use crate::context::PrivateContext;
use crate::messages::delivery::{
    delivery_messaging_secret::DeliveryMessagingSecret,
    messaging_secret_derivation::{existing_handshake_secrets_or_else, MessagingSecretDerivation},
    OnchainDeliveryMode,
};
use crate::oracle::notes::get_next_tagging_index;
use crate::oracle::resolve_messaging_secret_strategy::resolve_messaging_secret_strategy;
use crate::protocol::{
    address::AztecAddress,
    constants::{DOM_SEP__CONSTRAINED_MSG_LOG_TAG, DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG},
    hash::{compute_log_tag, poseidon2_hash},
};

/// Resolves the messaging secret an on-chain delivery tags and encrypts its message with.
///
/// `messaging_secret_derivation` is the contract's compile-time choice of messaging secret derivation, or `None` for
/// the wallet-resolved default. It must be a compile-time constant so unused derivations are eliminated.
pub(crate) fn resolve_delivery_messaging_secret(
    context: &mut PrivateContext,
    mode: OnchainDeliveryMode,
    sender: AztecAddress,
    recipient: AztecAddress,
    messaging_secret_derivation: Option<MessagingSecretDerivation>,
) -> DeliveryMessagingSecret {
    messaging_secret_derivation.map_or_else(
        || default_messaging_secret(context, sender, recipient, mode),
        |derivation| derivation.into_delivery_messaging_secret(context, sender, recipient),
    )
}

/// The wallet-resolved default: reuse a handshake already registered for the pair, otherwise let the wallet resolve
/// the messaging secret strategy.
fn default_messaging_secret(
    context: &mut PrivateContext,
    sender: AztecAddress,
    recipient: AztecAddress,
    mode: OnchainDeliveryMode,
) -> DeliveryMessagingSecret {
    existing_handshake_secrets_or_else(
        sender,
        recipient,
        || {
            // Safety: the strategy only selects the messaging secret's kind; each kind constrains (or rejects) its own
            // secret before a constrained tag is emitted, so an untrusted strategy can't produce a valid unbacked
            // constrained tag.
            let strategy = unsafe { resolve_messaging_secret_strategy(sender, recipient, mode) };
            strategy.into_delivery_messaging_secret(context, sender, recipient)
        },
    )
}

/// Derives the discovery log tag for an on-chain delivery from its messaging secret.
pub(crate) fn derive_log_tag(
    delivery_messaging_secret: DeliveryMessagingSecret,
    context: &mut PrivateContext,
    mode: OnchainDeliveryMode,
    sender: AztecAddress,
    recipient: AztecAddress,
) -> Field {
    let secret = delivery_messaging_secret.secret();

    // Safety: the index is untrusted. Constrained delivery constrains it below before emitting the tag; unconstrained
    // discovery tolerates gaps, so a wrong index only yields an undiscoverable tag.
    let index = unsafe { get_next_tagging_index(secret, mode) };

    if mode == OnchainDeliveryMode::onchain_constrained() {
        delivery_messaging_secret.constrain(context, sender, recipient, index);
    }

    // The discovery tag stays derived from the messaging secret only, so the recipient still finds every message.
    tag_from_secret_and_index(secret, index, mode)
}

fn tag_domain_separator(mode: OnchainDeliveryMode) -> u32 {
    if mode == OnchainDeliveryMode::onchain_constrained() {
        DOM_SEP__CONSTRAINED_MSG_LOG_TAG
    } else {
        DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG
    }
}

fn tag_from_secret_and_index(secret: Field, index: u32, mode: OnchainDeliveryMode) -> Field {
    compute_log_tag(
        poseidon2_hash([secret, index as Field]),
        tag_domain_separator(mode),
    )
}

mod test {
    use crate::context::PrivateContext;
    use crate::messages::delivery::constrained_delivery::compute_recipient_tsk_sequence_nullifier;
    use crate::messages::delivery::handshake::AppSiloedHandshakeSecrets;
    use crate::messages::delivery::{
        messaging_secret_derivation::MessagingSecretDerivation, ResolvedMessagingSecretStrategy,
    };
    use crate::protocol::{
        address::AztecAddress,
        constants::{DOM_SEP__CONSTRAINED_MSG_LOG_TAG, DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG},
        hash::{compute_log_tag, poseidon2_hash},
        traits::{FromField, Serialize},
    };
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::{derive_log_tag, OnchainDeliveryMode, resolve_delivery_messaging_secret, tag_from_secret_and_index};
    use std::test::OracleMock;

    global SENDER: AztecAddress = AztecAddress::from_field(1);
    global RECIPIENT: AztecAddress = AztecAddress::from_field(8);

    #[test]
    fn tag_from_secret_and_index_uses_mode_domain_separator() {
        let secret: Field = 1234;
        let index: u32 = 7;
        let raw_tag = poseidon2_hash([secret, index as Field]);

        assert_eq(
            tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_unconstrained()),
            compute_log_tag(raw_tag, DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG),
        );
        assert_eq(
            tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_constrained()),
            compute_log_tag(raw_tag, DOM_SEP__CONSTRAINED_MSG_LOG_TAG),
        );
    }

    #[test]
    unconstrained fn reuses_an_existing_handshake_secret() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        let index: u32 = 3;

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::some(
                AppSiloedHandshakeSecrets { shared: secret, sender_only: 99 },
            ));
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);
            let resolve_oracle = OracleMock::mock("aztec_prv_resolveMessagingSecretStrategy").returns(
                ResolvedMessagingSecretStrategy::non_interactive_handshake(),
            );

            assert_eq(
                resolve_and_derive_log_tag(
                    context,
                    OnchainDeliveryMode::onchain_unconstrained(),
                    Option::none(),
                ),
                tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_unconstrained()),
            );

            // An existing handshake is reused without consulting the wallet's messaging secret strategy oracle.
            assert_eq(resolve_oracle.times_called(), 0);
        });
    }

    #[test]
    unconstrained fn uses_the_resolved_unconstrained_secret_when_no_handshake_exists() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        let index: u32 = 3;

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::none());
            let _ = OracleMock::mock("aztec_prv_resolveMessagingSecretStrategy").returns(
                ResolvedMessagingSecretStrategy::unconstrained_secret(secret),
            );
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);

            assert_eq(
                resolve_and_derive_log_tag(
                    context,
                    OnchainDeliveryMode::onchain_unconstrained(),
                    Option::none(),
                ),
                tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_unconstrained()),
            );
        });
    }

    #[test(should_fail_with = "an unconstrained messaging secret cannot back constrained delivery")]
    unconstrained fn constrained_delivery_rejects_a_resolved_unconstrained_secret() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        let index: u32 = 0;

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::none());
            let _ = OracleMock::mock("aztec_prv_resolveMessagingSecretStrategy").returns(
                ResolvedMessagingSecretStrategy::unconstrained_secret(secret),
            );
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);

            let _ = resolve_and_derive_log_tag(
                context,
                OnchainDeliveryMode::onchain_constrained(),
                Option::none(),
            );
        });
    }

    #[test]
    unconstrained fn constrained_delivery_emits_the_sequence_nullifier_and_constrained_tag() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        // Index > 0 so the reused secret is anchored via the previous sequence nullifier, not a registry call.
        let index: u32 = 3;

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::some(
                AppSiloedHandshakeSecrets { shared: secret, sender_only: 99 },
            ));
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false);

            assert_eq(
                resolve_and_derive_log_tag(
                    context,
                    OnchainDeliveryMode::onchain_constrained(),
                    Option::none(),
                ),
                tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_constrained()),
            );

            // Constrained delivery emits the sequence nullifier for the (sender, recipient, secret) sequence.
            assert_eq(context.nullifiers.len(), 1);
        });
    }

    #[test]
    unconstrained fn constrained_delivery_emits_the_recipient_tsk_sequence_nullifier_for_a_resolved_recipient_tsk() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        // Index > 0 so the secret is anchored via the previous sequence nullifier, not a key validation request.
        let index: u32 = 3;

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::none());
            let _ = OracleMock::mock("aztec_prv_resolveMessagingSecretStrategy").returns(
                ResolvedMessagingSecretStrategy::recipient_tsk(secret),
            );
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false);

            assert_eq(
                resolve_and_derive_log_tag(
                    context,
                    OnchainDeliveryMode::onchain_constrained(),
                    Option::none(),
                ),
                tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_constrained()),
            );

            assert_eq(context.nullifiers.len(), 1);
            assert_eq(
                context.nullifiers.get(0).inner.value,
                compute_recipient_tsk_sequence_nullifier(RECIPIENT, secret, index),
            );
        });
    }

    #[test]
    unconstrained fn resolution_honors_the_messaging_secret_derivation_override() {
        let env = TestEnvironment::new();
        let secret: Field = 7;
        let index: u32 = 3;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_getAddressDerivedMessagingSecret").returns(Option::some(secret));
            let _ = OracleMock::mock("aztec_prv_getNextTaggingIndex").returns(index);
            // The wallet's default resolution would yield a different secret, which the override must bypass.
            let resolve_oracle = OracleMock::mock("aztec_prv_resolveMessagingSecretStrategy").returns(
                ResolvedMessagingSecretStrategy::unconstrained_secret(secret + 1),
            );

            // With a contract-fixed derivation, the tag comes from the override's secret, not the wallet's.
            assert_eq(
                resolve_and_derive_log_tag(
                    context,
                    OnchainDeliveryMode::onchain_unconstrained(),
                    Option::some(MessagingSecretDerivation::address_derived()),
                ),
                tag_from_secret_and_index(secret, index, OnchainDeliveryMode::onchain_unconstrained()),
            );

            // The override is honored: the wallet's default strategy resolution is never consulted.
            assert_eq(resolve_oracle.times_called(), 0);
        });
    }

    unconstrained fn mock_existing_handshake_secrets(maybe_secrets: Option<AppSiloedHandshakeSecrets>) {
        let _ = OracleMock::mock("aztec_utl_callUtilityFunction").returns(maybe_secrets.serialize());
    }

    /// Resolves the delivery's messaging secret and derives its tag, as on-chain delivery does.
    unconstrained fn resolve_and_derive_log_tag(
        context: &mut PrivateContext,
        mode: OnchainDeliveryMode,
        messaging_secret_derivation: Option<MessagingSecretDerivation>,
    ) -> Field {
        let delivery_messaging_secret = resolve_delivery_messaging_secret(
            context,
            mode,
            SENDER,
            RECIPIENT,
            messaging_secret_derivation,
        );
        derive_log_tag(delivery_messaging_secret, context, mode, SENDER, RECIPIENT)
    }
}
