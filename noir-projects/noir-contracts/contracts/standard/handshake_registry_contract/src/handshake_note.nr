use aztec::{
    keys::ecdh_shared_secret::compute_app_siloed_shared_secret_from_point,
    macros::notes::note,
    messages::delivery::handshake::AppSiloedHandshakeSecrets,
    protocol::{
        address::AztecAddress,
        constants::DOM_SEP__CONSTRAINED_MSG_SENDER_SECRET,
        hash::poseidon2_hash_with_separator,
        point::EmbeddedCurvePoint,
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};

/// A record of a handshake established by the note's owner (the sender).
///
/// Stored in [`crate::HandshakeRegistry`]'s `handshakes` state. The registry only hands out the app-siloed forms of its
/// secrets.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct HandshakeNote {
    /// The handshake's shared secret point, with the forgery protection applied (see
    /// [`protect_from_forgery`](aztec::messages::delivery::handshake::protect_from_forgery)).
    secret: EmbeddedCurvePoint,
    /// The random secret the [sender-only secret][AppSiloedHandshakeSecrets::sender_only] derives from, generated when
    /// the handshake is stored and never shared with the recipient.
    sender_secret: Field,
}

impl HandshakeNote {
    pub(crate) fn new(shared_secret: EmbeddedCurvePoint, sender_secret: Field) -> Self {
        Self { secret: shared_secret, sender_secret }
    }

    /// Returns the [app-siloed handshake secrets][AppSiloedHandshakeSecrets] for `caller`, so that each contract gets
    /// different values for the same note.
    pub(crate) fn app_siloed_secrets_for(self, caller: AztecAddress) -> AppSiloedHandshakeSecrets {
        AppSiloedHandshakeSecrets {
            shared: compute_app_siloed_shared_secret_from_point(self.secret, caller),
            sender_only: poseidon2_hash_with_separator(
                [self.sender_secret, caller.to_field()],
                DOM_SEP__CONSTRAINED_MSG_SENDER_SECRET,
            ),
        }
    }
}
