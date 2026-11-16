use crate::context::PrivateContext;
use crate::messages::delivery::{
    constrained_delivery::{
        constrain_preexisting_handshake_secrets, constrain_recipient_tsk_secret, emit_handshake_sequence_nullifier,
        emit_recipient_tsk_sequence_nullifier,
    },
    handshake::{AppSiloedHandshakeSecrets, create_interactive_handshake, create_non_interactive_handshake},
};
use crate::protocol::address::AztecAddress;
use crate::standard_addresses::STANDARD_HANDSHAKE_REGISTRY_ADDRESS;

global EXISTING_HANDSHAKE: u8 = 1;
global NEW_NON_INTERACTIVE_HANDSHAKE: u8 = 2;
global UNCONSTRAINED_SECRET: u8 = 3;
global NEW_INTERACTIVE_HANDSHAKE: u8 = 4;
global RECIPIENT_TSK: u8 = 5;

/// The messaging secret a delivery uses.
///
/// Records how the secret was obtained and, for constrained delivery, how it is constrained.
#[derive(Eq)]
pub(crate) struct DeliveryMessagingSecret {
    kind: u8,
    /// The secret the message's tag and encryption derive from. Every kind resolves to exactly one.
    secret: Field,
    /// The handshake's [sender-only secret][`AppSiloedHandshakeSecrets::sender_only`], for the kinds that are
    /// handshakes.
    sender_only: Option<Field>,
}

impl DeliveryMessagingSecret {
    /// Reuses the secrets of a handshake already registered for the pair.
    pub(crate) fn existing_handshake(secrets: AppSiloedHandshakeSecrets) -> Self {
        Self { kind: EXISTING_HANDSHAKE, secret: secrets.shared, sender_only: Option::some(secrets.sender_only) }
    }

    /// Establishes a fresh non-interactive handshake (see
    /// [`via_non_interactive_handshake`](super::OnchainUnconstrainedDelivery::via_non_interactive_handshake)).
    pub(crate) fn new_non_interactive_handshake(
        context: &mut PrivateContext,
        sender: AztecAddress,
        recipient: AztecAddress,
    ) -> Self {
        let secrets = create_non_interactive_handshake(
            context,
            STANDARD_HANDSHAKE_REGISTRY_ADDRESS,
            sender,
            recipient,
        );
        Self {
            kind: NEW_NON_INTERACTIVE_HANDSHAKE,
            secret: secrets.shared,
            sender_only: Option::some(secrets.sender_only),
        }
    }

    /// Establishes a fresh interactive handshake (see
    /// [`via_interactive_handshake`](super::OnchainUnconstrainedDelivery::via_interactive_handshake)).
    pub(crate) fn new_interactive_handshake(
        context: &mut PrivateContext,
        sender: AztecAddress,
        recipient: AztecAddress,
    ) -> Self {
        let secrets = create_interactive_handshake(
            context,
            STANDARD_HANDSHAKE_REGISTRY_ADDRESS,
            sender,
            recipient,
        );
        Self { kind: NEW_INTERACTIVE_HANDSHAKE, secret: secrets.shared, sender_only: Option::some(secrets.sender_only) }
    }

    /// A secret the contract cannot verify, which can only back unconstrained delivery (see
    /// [`unconstrained_secret`](super::ResolvedMessagingSecretStrategy::unconstrained_secret)).
    pub(crate) fn unconstrained_secret(secret: Field) -> Self {
        Self { kind: UNCONSTRAINED_SECRET, secret, sender_only: Option::none() }
    }

    /// The recipient's messaging secret derived from their tagging key (see
    /// [`via_recipient_tsk_secret`](super::OnchainUnconstrainedDelivery::via_recipient_tsk_secret)).
    pub(crate) fn recipient_tsk(secret: Field) -> Self {
        Self { kind: RECIPIENT_TSK, secret, sender_only: Option::none() }
    }

    /// The secret the message's tag and encryption derive from.
    pub(crate) fn secret(self) -> Field {
        self.secret
    }

    /// Constrains `(messaging secret, index)` for constrained delivery and emits the sequence nullifier, each kind
    /// proving its secrets its own way. A kind that cannot back constrained delivery rejects it here. Only called
    /// for constrained delivery.
    pub(crate) fn constrain(
        self,
        context: &mut PrivateContext,
        sender: AztecAddress,
        recipient: AztecAddress,
        index: u32,
    ) {
        if self.kind == RECIPIENT_TSK {
            constrain_recipient_tsk_secret(context, recipient, self.secret, index);
            emit_recipient_tsk_sequence_nullifier(context, recipient, self.secret, index);
        } else if self.kind == UNCONSTRAINED_SECRET {
            panic(
                "an unconstrained messaging secret cannot back constrained delivery",
            );
        } else if (self.kind == EXISTING_HANDSHAKE)
            | (self.kind == NEW_NON_INTERACTIVE_HANDSHAKE)
            | (self.kind == NEW_INTERACTIVE_HANDSHAKE) {
            let secrets = self.handshake_secrets();
            if self.kind == EXISTING_HANDSHAKE {
                constrain_preexisting_handshake_secrets(
                    context,
                    STANDARD_HANDSHAKE_REGISTRY_ADDRESS,
                    sender,
                    recipient,
                    secrets,
                    index,
                );
            } else {
                // The secrets were already obtained in a constrained manner, so we only need to verify that the index
                // is 0.
                assert(index == 0, "newly established handshake secret must start at index 0");
            }
            emit_handshake_sequence_nullifier(context, sender, recipient, secrets, index);
        } else {
            let kind = self.kind;
            panic(f"unknown delivery messaging secret kind: {kind}");
        }
    }

    /// The secrets of a kind that is a handshake.
    fn handshake_secrets(self) -> AppSiloedHandshakeSecrets {
        let kind = self.kind;
        AppSiloedHandshakeSecrets {
            shared: self.secret,
            sender_only: self.sender_only.expect(f"delivery messaging secret kind {kind} is not a handshake"),
        }
    }
}

mod test {
    use crate::context::PrivateContext;
    use crate::hash::hash_args;
    use crate::messages::delivery::constrained_delivery::{
        compute_handshake_sequence_nullifier, compute_recipient_tsk_sequence_nullifier,
    };
    use crate::messages::delivery::handshake::AppSiloedHandshakeSecrets;
    use crate::oracle::execution_cache;
    use crate::protocol::{address::AztecAddress, traits::{FromField, Serialize}};
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::DeliveryMessagingSecret;
    use std::test::OracleMock;

    global SENDER: AztecAddress = AztecAddress::from_field(1);
    global RECIPIENT: AztecAddress = AztecAddress::from_field(8);

    #[test]
    unconstrained fn existing_handshake_holds_and_constrains_its_secrets() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 42, sender_only: 7 };
        let index: u32 = 3;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false).times(1);

            let delivery_messaging_secret = DeliveryMessagingSecret::existing_handshake(secrets);
            assert_eq(delivery_messaging_secret.secret(), secrets.shared);

            delivery_messaging_secret.constrain(context, SENDER, RECIPIENT, index);
            assert_emitted_sequence_nullifier(context, secrets, index);
        });
    }

    #[test]
    unconstrained fn unconstrained_secret_holds_its_secret() {
        assert_eq(DeliveryMessagingSecret::unconstrained_secret(42).secret(), 42);
    }

    #[test]
    unconstrained fn recipient_tsk_holds_and_constrains_its_secret() {
        let env = TestEnvironment::new();
        let secret = 42;
        let index: u32 = 3;

        env.private_context(|context| {
            let _ = OracleMock::mock("aztec_prv_isNullifierPending").returns(false).times(1);

            let delivery_messaging_secret = DeliveryMessagingSecret::recipient_tsk(secret);
            assert_eq(delivery_messaging_secret.secret(), secret);

            delivery_messaging_secret.constrain(context, SENDER, RECIPIENT, index);

            // The sequence nullifier binds no sender, so every sender to the recipient extends the same sequence.
            assert_eq(context.nullifiers.len(), 1);
            assert_eq(
                context.nullifiers.get(0).inner.value,
                compute_recipient_tsk_sequence_nullifier(RECIPIENT, secret, index),
            );
        });
    }

    #[test]
    unconstrained fn new_non_interactive_handshake_creates_and_constrains_the_newly_established_secrets() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 7, sender_only: 9 };

        env.private_context(|context| {
            mock_handshake_creation(context, secrets);

            let delivery_messaging_secret =
                DeliveryMessagingSecret::new_non_interactive_handshake(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret.secret(), secrets.shared);

            delivery_messaging_secret.constrain(context, SENDER, RECIPIENT, 0);
            assert_emitted_sequence_nullifier(context, secrets, 0);
        });
    }

    #[test]
    unconstrained fn new_interactive_handshake_creates_and_constrains_the_newly_established_secrets() {
        let env = TestEnvironment::new();
        let secrets = AppSiloedHandshakeSecrets { shared: 12, sender_only: 34 };

        env.private_context(|context| {
            mock_handshake_creation(context, secrets);

            let delivery_messaging_secret =
                DeliveryMessagingSecret::new_interactive_handshake(context, SENDER, RECIPIENT);
            assert_eq(delivery_messaging_secret.secret(), secrets.shared);

            delivery_messaging_secret.constrain(context, SENDER, RECIPIENT, 0);
            assert_emitted_sequence_nullifier(context, secrets, 0);
        });
    }

    // A newly established handshake secret is the source of truth, so its sequence must start at index 0.
    #[test(should_fail_with = "newly established handshake secret must start at index 0")]
    unconstrained fn fresh_handshake_secret_must_start_at_index_zero() {
        let env = TestEnvironment::new();
        env.private_context(|context| {
            mock_handshake_creation(
                context,
                AppSiloedHandshakeSecrets { shared: 0, sender_only: 0 },
            );

            DeliveryMessagingSecret::new_non_interactive_handshake(context, SENDER, RECIPIENT).constrain(
                context,
                SENDER,
                RECIPIENT,
                1,
            );
        });
    }

    #[test(should_fail_with = "newly established handshake secret must start at index 0")]
    unconstrained fn fresh_interactive_handshake_secret_must_start_at_index_zero() {
        let env = TestEnvironment::new();
        env.private_context(|context| {
            mock_handshake_creation(
                context,
                AppSiloedHandshakeSecrets { shared: 0, sender_only: 0 },
            );

            DeliveryMessagingSecret::new_interactive_handshake(context, SENDER, RECIPIENT).constrain(
                context,
                SENDER,
                RECIPIENT,
                1,
            );
        });
    }

    #[test(should_fail_with = "an unconstrained messaging secret cannot back constrained delivery")]
    unconstrained fn unconstrained_secret_cannot_back_constrained_delivery() {
        let env = TestEnvironment::new();
        env.private_context(|context| {
            DeliveryMessagingSecret::unconstrained_secret(7).constrain(
                context,
                AztecAddress::zero(),
                AztecAddress::zero(),
                0,
            );
        });
    }

    unconstrained fn assert_emitted_sequence_nullifier(
        context: &mut PrivateContext,
        secrets: AppSiloedHandshakeSecrets,
        index: u32,
    ) {
        assert_eq(context.nullifiers.len(), 1);
        assert_eq(
            context.nullifiers.get(0).inner.value,
            compute_handshake_sequence_nullifier(SENDER, RECIPIENT, secrets, index),
        );
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
