use crate::context::PrivateContext;
use crate::messages::delivery::{
    delivery_messaging_secret::DeliveryMessagingSecret, handshake::get_existing_app_siloed_handshake_secrets,
};
use crate::oracle::notes::get_address_derived_messaging_secret;
use crate::oracle::random::random;
use crate::protocol::address::AztecAddress;
use crate::standard_addresses::STANDARD_HANDSHAKE_REGISTRY_ADDRESS;

global NON_INTERACTIVE_HANDSHAKE: u8 = 1;
global ADDRESS_DERIVED: u8 = 2;
global INTERACTIVE_HANDSHAKE: u8 = 3;

/// Domain separator for the messaging secret derived from a recipient's app-siloed tagging key.
pub(crate) global DOM_SEP__RECIPIENT_TSK_SECRET: u32 = 1256167324;

/// A contract's choice of messaging-secret derivation.
///
/// Selected through the on-chain delivery builder's `via_*` methods. On-chain delivery tags every message from a
/// secret shared between the sender and the recipient, and there is
/// [more than one way][`crate::messages::delivery::ResolvedMessagingSecretStrategy`] to establish it.
/// Selecting a derivation instead lets the contract fix it, and its choice is honored over the wallet-resolved
/// strategy.
#[derive(Eq)]
pub(crate) struct MessagingSecretDerivation {
    kind: u8,
}

impl MessagingSecretDerivation {
    /// Reuses an existing handshake for the pair, creating a fresh non-interactive one only when none exists.
    pub(crate) fn non_interactive_handshake() -> Self {
        Self { kind: NON_INTERACTIVE_HANDSHAKE }
    }

    /// Reuses an existing handshake for the pair, creating a fresh interactive one only when none exists.
    pub(crate) fn interactive_handshake() -> Self {
        Self { kind: INTERACTIVE_HANDSHAKE }
    }

    /// Derives the tag from the address-derived secret for the `(sender, recipient)` pair (a Diffie-Hellman exchange
    /// between their addresses).
    pub(crate) fn address_derived() -> Self {
        Self { kind: ADDRESS_DERIVED }
    }

    /// Asserts this choice's `kind` is a compile-time constant.
    pub(crate) fn assert_kind_is_constant(self) {
        assert_constant(self.kind as Field);
    }

    /// Resolves this choice into the [`DeliveryMessagingSecret`] backing the message tag.
    pub(crate) fn into_delivery_messaging_secret(
        self,
        context: &mut PrivateContext,
        sender: AztecAddress,
        recipient: AztecAddress,
    ) -> DeliveryMessagingSecret {
        if self.kind == NON_INTERACTIVE_HANDSHAKE {
            existing_handshake_secrets_or_else(
                sender,
                recipient,
                || DeliveryMessagingSecret::new_non_interactive_handshake(context, sender, recipient),
            )
        } else if self.kind == INTERACTIVE_HANDSHAKE {
            existing_handshake_secrets_or_else(
                sender,
                recipient,
                || DeliveryMessagingSecret::new_interactive_handshake(context, sender, recipient),
            )
        } else if self.kind == ADDRESS_DERIVED {
            // Safety: the secret is untrusted, but address-derived tagging is unconstrained-only, where a wrong
            // secret only yields an undiscoverable tag. An invalid recipient has no shared secret, so we fall back
            // to a random (undiscoverable) secret rather than failing the send.
            let secret = unsafe { get_address_derived_messaging_secret(sender, recipient).unwrap_or_else(|| random()) };
            DeliveryMessagingSecret::unconstrained_secret(secret)
        } else {
            let kind = self.kind;
            panic(f"unknown messaging secret derivation kind: {kind}")
        }
    }
}

/// Resolves to the secrets of a handshake already registered for `(sender, recipient)` (handshakes of either type
/// back both delivery modes), or to `fallback()` when none exists yet.
pub(crate) fn existing_handshake_secrets_or_else<Env>(
    sender: AztecAddress,
    recipient: AztecAddress,
    fallback: fn[Env]() -> DeliveryMessagingSecret,
) -> DeliveryMessagingSecret {
    // Safety: this only selects which messaging secret backs the tag. A reused handshake's secrets are constrained
    // against the registry before a constrained tag is emitted; the fallback constrains (or rejects) its own secret
    // the same way.
    let existing =
        unsafe { get_existing_app_siloed_handshake_secrets(STANDARD_HANDSHAKE_REGISTRY_ADDRESS, sender, recipient) };
    existing.map_or_else(fallback, |secrets| DeliveryMessagingSecret::existing_handshake(secrets))
}

mod test {
    use crate::context::PrivateContext;
    use crate::hash::hash_args;
    use crate::messages::delivery::delivery_messaging_secret::DeliveryMessagingSecret;
    use crate::messages::delivery::handshake::AppSiloedHandshakeSecrets;
    use crate::oracle::execution_cache;
    use crate::protocol::{address::AztecAddress, traits::{FromField, Serialize}};
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::MessagingSecretDerivation;
    use std::test::OracleMock;

    global SENDER: AztecAddress = AztecAddress::from_field(1);
    global RECIPIENT: AztecAddress = AztecAddress::from_field(8);

    #[test]
    unconstrained fn address_derived_uses_the_address_derived_secret() {
        let env = TestEnvironment::new();
        let secret: Field = 7;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_getAddressDerivedMessagingSecret").returns(Option::some(secret));

            let delivery_messaging_secret = MessagingSecretDerivation::address_derived()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret, DeliveryMessagingSecret::unconstrained_secret(secret));
        });
    }

    #[test]
    unconstrained fn address_derived_falls_back_to_a_random_secret_for_an_invalid_recipient() {
        let env = TestEnvironment::new();
        let random_secret: Field = 999;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_getAddressDerivedMessagingSecret").returns(Option::<Field>::none());
            let _ = OracleMock::mock("aztec_misc_getRandomField").returns(random_secret);

            let delivery_messaging_secret = MessagingSecretDerivation::address_derived()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret, DeliveryMessagingSecret::unconstrained_secret(random_secret));
        });
    }

    #[test]
    unconstrained fn non_interactive_handshake_reuses_an_existing_handshake() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 7, sender_only: 99 };

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::some(secrets));

            let delivery_messaging_secret = MessagingSecretDerivation::non_interactive_handshake()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret, DeliveryMessagingSecret::existing_handshake(secrets));
        });
    }

    #[test]
    unconstrained fn non_interactive_handshake_creates_a_fresh_one_when_none_exists() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 7, sender_only: 99 };

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::none());
            mock_handshake_creation(context, secrets);

            let delivery_messaging_secret = MessagingSecretDerivation::non_interactive_handshake()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret.secret(), secrets.shared);
        });
    }

    #[test]
    unconstrained fn interactive_handshake_reuses_an_existing_handshake() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 7, sender_only: 99 };

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::some(secrets));

            let delivery_messaging_secret = MessagingSecretDerivation::interactive_handshake()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret, DeliveryMessagingSecret::existing_handshake(secrets));
        });
    }

    #[test]
    unconstrained fn interactive_handshake_creates_a_fresh_one_when_none_exists() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 7, sender_only: 99 };

        env.private_context(|context| {
            mock_existing_handshake_secrets(Option::none());
            mock_handshake_creation(context, secrets);

            let delivery_messaging_secret = MessagingSecretDerivation::interactive_handshake()
                .into_delivery_messaging_secret(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret.secret(), secrets.shared);
        });
    }

    unconstrained fn mock_existing_handshake_secrets(maybe_secrets: Option<AppSiloedHandshakeSecrets>) {
        let _ = OracleMock::mock("aztec_utl_callUtilityFunction").returns(maybe_secrets.serialize());
    }

    // The registry's handshake creation call returns the app-siloed secrets via the returns cache.
    unconstrained fn mock_handshake_creation(context: &mut PrivateContext, secrets: AppSiloedHandshakeSecrets) {
        let returns = secrets.serialize();
        let returns_hash = hash_args(returns);
        execution_cache::store(returns, returns_hash);
        let child_call_end_counter = context.get_side_effect_counter() + 1;
        let _ =
            OracleMock::mock("aztec_prv_callPrivateFunction").returns((child_call_end_counter, returns_hash)).times(1);
    }
}
