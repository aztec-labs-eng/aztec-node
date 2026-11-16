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
    /// The handshake sender-only secret, folded into the constrained-delivery sequence nullifier. Only meaningful
    /// for handshake-backed kinds.
    sender_only: Field,
}

impl DeliveryMessagingSecret {
    /// Reuses the secrets of a handshake already registered for the pair (mode-agnostic).
    pub(crate) fn existing_handshake(secrets: AppSiloedHandshakeSecrets) -> Self {
        Self { kind: EXISTING_HANDSHAKE, secret: secrets.shared, sender_only: secrets.sender_only }
    }

    /// Establishes a fresh non-interactive handshake, publishing information about the recipient onchain.
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
        Self { kind: NEW_NON_INTERACTIVE_HANDSHAKE, secret: secrets.shared, sender_only: secrets.sender_only }
    }

    /// Establishes a fresh interactive handshake, publishing nothing about the recipient onchain.
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
        Self { kind: NEW_INTERACTIVE_HANDSHAKE, secret: secrets.shared, sender_only: secrets.sender_only }
    }

    /// A ready-to-use unconstrained secret the wallet resolved. Sound only for unconstrained delivery, which never
    /// anchors a sequence, so no sender-only secret is involved.
    pub(crate) fn unconstrained_secret(secret: Field) -> Self {
        Self { kind: UNCONSTRAINED_SECRET, secret, sender_only: 0 }
    }

    /// The recipient's messaging secret derived from their tagging key, which backs both delivery modes.
    ///
    /// Its constrained-delivery sequence nullifier contains no sender-only secret, as the recipient's `tsk` is expected
    /// to only be known by them, and as such a third party using the same tag stream and emitting the same nullifiers
    /// (possibly causing legitimate transactions to be dropped due to duplicate nullifiers) is not possible.
    pub(crate) fn recipient_tsk(secret: Field) -> Self {
        Self { kind: RECIPIENT_TSK, secret, sender_only: 0 }
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
        } else {
            let secrets = AppSiloedHandshakeSecrets::from(self);
            if self.kind == EXISTING_HANDSHAKE {
                constrain_preexisting_handshake_secrets(
                    context,
                    STANDARD_HANDSHAKE_REGISTRY_ADDRESS,
                    sender,
                    recipient,
                    secrets,
                    index,
                );
            } else if (self.kind == NEW_NON_INTERACTIVE_HANDSHAKE) | (self.kind == NEW_INTERACTIVE_HANDSHAKE) {
                // The secrets were already obtained in a constrained manner, so we only need to verify that the index
                // is 0.
                assert(index == 0, "freshly bootstrapped secret must start at index 0");
            } else {
                let kind = self.kind;
                panic(f"unknown delivery messaging secret kind: {kind}");
            }
            emit_handshake_sequence_nullifier(context, sender, recipient, secrets, index);
        }
    }
}

/// The handshake-secrets view of a delivery messaging secret, used by the constrained delivery of handshake-backed
/// kinds. For any other kind the sender-only secret is a filler zero.
impl From<DeliveryMessagingSecret> for AppSiloedHandshakeSecrets {
    fn from(delivery_messaging_secret: DeliveryMessagingSecret) -> Self {
        Self { shared: delivery_messaging_secret.secret, sender_only: delivery_messaging_secret.sender_only }
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
    unconstrained fn new_non_interactive_handshake_creates_and_constrains_the_bootstrapped_secrets() {
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
    unconstrained fn new_interactive_handshake_creates_and_constrains_the_bootstrapped_secrets() {
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

    // A freshly bootstrapped handshake secret is the source of truth, so its sequence must start at index 0.
    #[test(should_fail_with = "freshly bootstrapped secret must start at index 0")]
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

    #[test(should_fail_with = "freshly bootstrapped secret must start at index 0")]
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
