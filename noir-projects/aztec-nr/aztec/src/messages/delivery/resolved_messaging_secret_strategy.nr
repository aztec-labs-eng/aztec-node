use crate::context::PrivateContext;
use crate::protocol::{address::AztecAddress, traits::{Deserialize, Serialize}, utils::reader::Reader};
use super::delivery_messaging_secret::DeliveryMessagingSecret;

global NON_INTERACTIVE_HANDSHAKE: u8 = 1;
global UNCONSTRAINED_SECRET: u8 = 2;
global INTERACTIVE_HANDSHAKE: u8 = 3;

/// The outcome of the wallet's messaging secret strategy.
///
/// It is either a handshake for the contract to establish, or a messaging secret ready to use. Messaging secrets are
/// already app-siloed, so the contract derives the message tag from it directly and never sees raw key material.
#[derive(Eq, Serialize)]
pub struct ResolvedMessagingSecretStrategy {
    kind: u8,
    secret: Field,
}

impl ResolvedMessagingSecretStrategy {
    /// A non-interactive handshake: the recipient re-derives the secret from the onchain handshake registry.
    pub fn non_interactive_handshake() -> Self {
        Self { kind: NON_INTERACTIVE_HANDSHAKE, secret: 0 }
    }

    /// An app-siloed, recipient-directional secret, ready to use. Only sound for unconstrained delivery.
    pub fn unconstrained_secret(secret: Field) -> Self {
        Self { kind: UNCONSTRAINED_SECRET, secret }
    }

    /// An interactive handshake: the recipient learns the secret while signing its authorization.
    pub fn interactive_handshake() -> Self {
        Self { kind: INTERACTIVE_HANDSHAKE, secret: 0 }
    }

    pub fn is_unconstrained_secret(self) -> bool {
        self.kind == UNCONSTRAINED_SECRET
    }

    /// Resolves this strategy into the [`DeliveryMessagingSecret`] backing the message tag.
    pub(crate) fn into_delivery_messaging_secret(
        self,
        context: &mut PrivateContext,
        sender: AztecAddress,
        recipient: AztecAddress,
    ) -> DeliveryMessagingSecret {
        if self.kind == NON_INTERACTIVE_HANDSHAKE {
            DeliveryMessagingSecret::new_non_interactive_handshake(context, sender, recipient)
        } else if self.kind == INTERACTIVE_HANDSHAKE {
            DeliveryMessagingSecret::new_interactive_handshake(context, sender, recipient)
        } else {
            DeliveryMessagingSecret::unconstrained_secret(self.secret)
        }
    }

    /// Validates a raw discriminant, as deserialization must always reject unknown values.
    fn from_parts(kind: u8, secret: Field) -> Self {
        let resolved = Self { kind, secret };
        assert(
            (((kind == NON_INTERACTIVE_HANDSHAKE) | (kind == INTERACTIVE_HANDSHAKE)) & (secret == 0))
                | (kind == UNCONSTRAINED_SECRET),
            f"unrecognized resolved messaging secret strategy kind: {kind}",
        );
        resolved
    }
}

impl Deserialize for ResolvedMessagingSecretStrategy {
    let N: u32 = 2;

    fn deserialize(fields: [Field; Self::N]) -> Self {
        Self::from_parts(fields[0] as u8, fields[1])
    }

    fn stream_deserialize<let K: u32>(reader: &mut Reader<K>) -> Self {
        let kind = reader.read() as u8;
        let secret = reader.read();
        Self::from_parts(kind, secret)
    }
}

mod test {
    use crate::protocol::traits::{Deserialize, Serialize};
    use super::ResolvedMessagingSecretStrategy;

    #[test]
    fn resolved_roundtrips_through_serialization() {
        let non_interactive = ResolvedMessagingSecretStrategy::non_interactive_handshake();
        let unconstrained_secret = ResolvedMessagingSecretStrategy::unconstrained_secret(42);
        let interactive = ResolvedMessagingSecretStrategy::interactive_handshake();

        assert(ResolvedMessagingSecretStrategy::deserialize(non_interactive.serialize()) == non_interactive);
        assert(ResolvedMessagingSecretStrategy::deserialize(unconstrained_secret.serialize()) == unconstrained_secret);
        assert(ResolvedMessagingSecretStrategy::deserialize(interactive.serialize()) == interactive);
    }

    #[test(should_fail_with = "unrecognized resolved messaging secret strategy kind")]
    fn deserializing_invalid_kind_fails() {
        let _ = ResolvedMessagingSecretStrategy::deserialize([99, 0]);
    }

    #[test(should_fail_with = "unrecognized resolved messaging secret strategy kind")]
    fn deserializing_handshake_with_nonzero_secret_fails() {
        let _ = ResolvedMessagingSecretStrategy::deserialize([1, 123]);
    }

    #[test(should_fail_with = "unrecognized resolved messaging secret strategy kind")]
    fn deserializing_interactive_handshake_with_nonzero_secret_fails() {
        let _ = ResolvedMessagingSecretStrategy::deserialize([3, 123]);
    }
}
