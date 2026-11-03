use crate::keys::ecdh_shared_secret::compute_app_siloed_shared_secret_from_point;
use crate::protocol::{
    address::AztecAddress,
    hash::poseidon2_hash,
    point::EmbeddedCurvePoint,
    traits::{Deserialize, Serialize, ToField},
    utils::reader::Reader,
};

global NON_INTERACTIVE_HANDSHAKE: u8 = 1;
global ARBITRARY_SECRET: u8 = 2;
global ADDRESS_DERIVED: u8 = 3;
global INTERACTIVE_HANDSHAKE: u8 = 4;
global RECIPIENT_TSK: u8 = 5;

/// How a message's messaging secret is chosen: the wallet's strategy.
///
/// This type only exists for tests: a Noir test sets it via `with_default_messaging_secret_strategy` on
/// [`TestEnvironmentOptions`](crate::test::helpers::test_environment::TestEnvironmentOptions).
/// Production wallets express the strategy in PXE; the Noir path only consumes the resolved
/// [`ResolvedMessagingSecretStrategy`](crate::messages::delivery::ResolvedMessagingSecretStrategy).
#[derive(Eq, Serialize)]
pub struct MessagingSecretStrategy {
    kind: u8,
    secret: EmbeddedCurvePoint,
}

impl MessagingSecretStrategy {
    /// A secret established through a non-interactive handshake.
    pub fn non_interactive_handshake() -> Self {
        Self { kind: NON_INTERACTIVE_HANDSHAKE, secret: EmbeddedCurvePoint { x: 0, y: 0 } }
    }

    /// A secret established through an interactive handshake.
    pub fn interactive_handshake() -> Self {
        Self { kind: INTERACTIVE_HANDSHAKE, secret: EmbeddedCurvePoint { x: 0, y: 0 } }
    }

    /// A secret derived from the sender's and recipient's address keys via Diffie-Hellman.
    ///
    /// The PXE performs the key exchange, so the wallet supplies no material.
    pub fn address_derived() -> Self {
        Self { kind: ADDRESS_DERIVED, secret: EmbeddedCurvePoint { x: 0, y: 0 } }
    }

    /// A secret derived from the recipient's tagging secret key.
    pub fn recipient_tsk() -> Self {
        Self { kind: RECIPIENT_TSK, secret: EmbeddedCurvePoint { x: 0, y: 0 } }
    }

    /// A raw shared secret point the two parties already share offchain, supplied by the wallet.
    ///
    /// The PXE app-silos the point before use.
    pub fn arbitrary_secret(secret: EmbeddedCurvePoint) -> Self {
        Self { kind: ARBITRARY_SECRET, secret }
    }

    /// Validates a raw discriminant and its secret, rejecting values no constructor produces.
    fn from_parts(kind: u8, secret: EmbeddedCurvePoint) -> Self {
        let is_no_payload_strategy = (kind == NON_INTERACTIVE_HANDSHAKE)
            | (kind == INTERACTIVE_HANDSHAKE)
            | (kind == ADDRESS_DERIVED)
            | (kind == RECIPIENT_TSK);
        assert(
            is_no_payload_strategy | (kind == ARBITRARY_SECRET),
            f"unrecognized messaging secret strategy kind: {kind}",
        );
        assert(
            !is_no_payload_strategy | secret.is_infinite(),
            f"messaging secret strategy kind {kind} takes no secret, got {secret}",
        );
        Self { kind, secret }
    }
}

/// Computes the directional messaging secret PXE derives from an arbitrary shared secret point: the point is app-siloed
/// and the recipient is folded in for direction. Mirrors `MessagingSecret.computeFromArbitrarySecret` on the PXE
/// side; tests use it to derive the secret they expect an
/// [`arbitrary_secret`](MessagingSecretStrategy::arbitrary_secret) strategy to produce.
pub fn compute_directional_app_secret(secret: EmbeddedCurvePoint, app: AztecAddress, recipient: AztecAddress) -> Field {
    poseidon2_hash(
        [compute_app_siloed_shared_secret_from_point(secret, app), recipient.to_field()],
    )
}

impl Deserialize for MessagingSecretStrategy {
    let N: u32 = 3;

    fn deserialize(fields: [Field; Self::N]) -> Self {
        Self::from_parts(
            fields[0] as u8,
            EmbeddedCurvePoint::deserialize([fields[1], fields[2]]),
        )
    }

    fn stream_deserialize<let K: u32>(reader: &mut Reader<K>) -> Self {
        let kind = reader.read() as u8;
        let secret = EmbeddedCurvePoint::deserialize([reader.read(), reader.read()]);
        Self::from_parts(kind, secret)
    }
}

mod test {
    use crate::protocol::{point::EmbeddedCurvePoint, traits::{Deserialize, Serialize}};
    use super::MessagingSecretStrategy;

    #[test]
    fn strategy_roundtrips_through_serialization() {
        let non_interactive = MessagingSecretStrategy::non_interactive_handshake();
        let interactive = MessagingSecretStrategy::interactive_handshake();
        let address = MessagingSecretStrategy::address_derived();
        let recipient_tsk = MessagingSecretStrategy::recipient_tsk();
        let provided = MessagingSecretStrategy::arbitrary_secret(EmbeddedCurvePoint { x: 7, y: 11 });

        assert(MessagingSecretStrategy::deserialize(non_interactive.serialize()) == non_interactive);
        assert(MessagingSecretStrategy::deserialize(interactive.serialize()) == interactive);
        assert(MessagingSecretStrategy::deserialize(address.serialize()) == address);
        assert(MessagingSecretStrategy::deserialize(recipient_tsk.serialize()) == recipient_tsk);
        assert(MessagingSecretStrategy::deserialize(provided.serialize()) == provided);
    }

    #[test(should_fail_with = "unrecognized messaging secret strategy kind")]
    fn deserializing_invalid_kind_fails() {
        let _ = MessagingSecretStrategy::deserialize([99, 0, 0]);
    }

    #[test(should_fail_with = "takes no secret")]
    fn deserializing_handshake_with_noninfinite_point_fails() {
        let _ = MessagingSecretStrategy::deserialize([
            MessagingSecretStrategy::non_interactive_handshake().kind as Field,
            7,
            11,
        ]);
    }

    #[test(should_fail_with = "takes no secret")]
    fn deserializing_address_derived_with_noninfinite_point_fails() {
        let _ = MessagingSecretStrategy::deserialize(
            [MessagingSecretStrategy::address_derived().kind as Field, 7, 11],
        );
    }

    #[test(should_fail_with = "takes no secret")]
    fn deserializing_recipient_tsk_with_noninfinite_point_fails() {
        let _ = MessagingSecretStrategy::deserialize(
            [MessagingSecretStrategy::recipient_tsk().kind as Field, 7, 11],
        );
    }

    #[test(should_fail_with = "takes no secret")]
    fn deserializing_interactive_handshake_with_noninfinite_point_fails() {
        let _ = MessagingSecretStrategy::deserialize([
            MessagingSecretStrategy::interactive_handshake().kind as Field,
            7,
            11,
        ]);
    }
}
