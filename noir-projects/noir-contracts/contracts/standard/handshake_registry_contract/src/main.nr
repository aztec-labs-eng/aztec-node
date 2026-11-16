use aztec::macros::aztec;
mod handshake_note;
mod recipient_signature;
mod sync;
mod test;

use sync::handshake_registry_sync;

/// Registry for the message-delivery handshake protocol.
///
/// The registry establishes a shared secret point `S'` between a sender and a recipient (their ECDH secret with the
/// [forgery protection](aztec::messages::delivery::handshake::protect_from_forgery) applied), and stores one current
/// note for each `(recipient, sender)` pair. A handshake backs both delivery modes. `S'` never leaves the registry: app
/// contracts call [`HandshakeRegistry::non_interactive_handshake`] to receive the secret already siloed to the caller,
/// call [`HandshakeRegistry::get_app_siloed_secrets`] offchain for an existing handshake, and use
/// [`HandshakeRegistry::validate_handshake`] to check app-siloed secrets against the current stored handshake. All of
/// these functions silo the secrets they return or check to the calling contract (`msg_sender()`), so a contract can
/// only obtain or validate secrets siloed to itself. Re-handshaking does not revoke already-started
/// constrained-delivery sequences; it only replaces the registry note used for
/// [validation][`HandshakeRegistry::validate_handshake`].
///
/// A handshake can be established two ways: [`HandshakeRegistry::non_interactive_handshake`], where the sender acts
/// alone and emits the handshake in a log the recipient later discovers, and
/// [`HandshakeRegistry::interactive_handshake`], which instead has the recipient sign the handshake at establishment
/// time and emits no log for them (the recipient already learns `eph_pk` while signing). Both store the same note.
#[aztec(::aztec::macros::AztecConfig::new().custom_sync_state(crate::handshake_registry_sync))]
pub contract HandshakeRegistry {
    use crate::{
        handshake_note::HandshakeNote, recipient_signature::RecipientSignature,
        sync::discovered_handshakes::get_all_discovered_handshakes,
    };
    use aztec::{
        keys::{ecdh_shared_secret::derive_ecdh_shared_secret, ephemeral::generate_positive_ephemeral_key_pair},
        macros::{functions::{external, internal}, storage::storage},
        messages::{
            delivery::{
                handshake::{AppSiloedHandshakeSecrets, HandshakePage, MAX_HANDSHAKES_PER_PAGE, protect_from_forgery},
                MessageDelivery,
            },
            encryption::aes128,
        },
        oracle::{random::random, resolve_custom_request::resolve_custom_request},
        protocol::{
            address::AztecAddress,
            constants::DOM_SEP__NON_INTERACTIVE_HANDSHAKE_LOG_TAG,
            hash::{compute_log_tag, sha256_to_field},
            traits::{Deserialize, ToField},
        },
        state_vars::{Map, Owned, PrivateMutable},
    };
    use std::embedded_curve_ops::EmbeddedCurvePoint;

    /// Request kind the registry passes to
    /// [`resolve_custom_request`](aztec::oracle::resolve_custom_request::resolve_custom_request) to obtain a
    /// recipient's interactive-handshake signature.
    global INTERACTIVE_HANDSHAKE_REQUEST_KIND: Field = sha256_to_field(
        "HANDSHAKE_REGISTRY::INTERACTIVE_HANDSHAKE_REQUEST".as_bytes(),
    );

    #[storage]
    struct Storage<Context> {
        /// One current [`HandshakeNote`] per `(recipient, sender)` pair.
        handshakes: Map<AztecAddress, Owned<PrivateMutable<HandshakeNote, Context>, Context>, Context>,
    }

    /// Performs a non-interactive handshake from `sender` to `recipient`.
    ///
    /// Returns the [app-siloed handshake secrets][AppSiloedHandshakeSecrets] for the calling contract. The recipient
    /// does not participate: they discover the handshake later by scanning for the handshake log emitted here, whose
    /// tag is derived from their address alone. See aztec-nr's `via_non_interactive_handshake` delivery option for
    /// [what this reveals](aztec::messages::delivery::OnchainUnconstrainedDelivery::via_non_interactive_handshake), and
    /// [`HandshakeRegistry::interactive_handshake`] for the variant the recipient signs.
    ///
    /// # Panics
    /// If `recipient` is not a valid curve point.
    #[external("private")]
    fn non_interactive_handshake(sender: AztecAddress, recipient: AztecAddress) -> AppSiloedHandshakeSecrets {
        let (eph_pk, s_protected) = self.internal._generate_shared_secret(recipient);
        let secrets = self.internal._store(sender, recipient, s_protected);

        // Emit the handshake log: an encrypted private log under the recipient-keyed tag carrying `[eph_pk.x]`, so the
        // recipient can discover the handshake by scanning their tag and recover the forgery-protected secret `S'` by
        // protecting `eph_pk` before its own ECDH (see aztec-nr's `forgery_protected_eph_pk`).
        let log_tag = compute_log_tag(
            recipient.to_field(),
            DOM_SEP__NON_INTERACTIVE_HANDSHAKE_LOG_TAG,
        );
        let ciphertext = aes128::encrypt_with_ecdh_secret([eph_pk.x], recipient, self.context.this_address());
        self.context.emit_private_log_unsafe(log_tag, BoundedVec::from_array(ciphertext));

        secrets
    }

    /// Performs an interactive handshake from `sender` to `recipient`.
    ///
    /// Returns the [app-siloed handshake secrets][AppSiloedHandshakeSecrets] for the calling contract. Like
    /// [`HandshakeRegistry::non_interactive_handshake`], but the recipient must authorize the handshake by signing the
    /// freshly generated ephemeral key, without learning who initiated it. No handshake log is emitted, since the
    /// recipient already learns `eph_pk` while signing.
    ///
    /// # Panics
    /// If `recipient` is not a valid curve point, if the returned public keys do not derive `recipient`'s address, or
    /// if the signature does not verify.
    #[external("private")]
    fn interactive_handshake(sender: AztecAddress, recipient: AztecAddress) -> AppSiloedHandshakeSecrets {
        let (eph_pk, s_protected) = self.internal._generate_shared_secret(recipient);
        self.internal._request_and_verify_signature(recipient, eph_pk);
        self.internal._store(sender, recipient, s_protected)
    }

    /// Asserts that `secrets` match the stored handshake from `sender` to `recipient`, for the caller (`msg_sender()`).
    ///
    /// Apps that receive handshake secrets from an untrusted source call this once to validate those secrets
    /// against the registry's latest stored handshake.
    ///
    /// # Panics
    /// If no stored handshake for `(sender, recipient)` silos to the provided secrets under the calling contract's
    /// address.
    #[external("private")]
    fn validate_handshake(sender: AztecAddress, recipient: AztecAddress, secrets: AppSiloedHandshakeSecrets) {
        let replacement_note_message = self.storage.handshakes.at(recipient).at(sender).get_note();
        let note = replacement_note_message.get_note();

        assert(note.app_siloed_secrets_for(self.msg_sender()) == secrets, "no matching handshake");

        // `PrivateMutable::get_note` proves the current note by nullifying and recreating it. Deliver the
        // replacement to the sender so later validation calls can prove the same current handshake again. As in
        // `_store`, the tag derivation is fixed to address-derived so the registry does not reference its own address
        // when re-tagging its own note.
        replacement_note_message.deliver(MessageDelivery::onchain_unconstrained().via_address_derived_secret());
    }

    /// Returns the app-siloed secrets of the current handshake from `sender` to `recipient`, or `None` if there is
    /// none.
    ///
    /// As with every function here, the secrets are siloed to the caller. Contracts that need a constrained proof that
    /// some app-siloed secrets match the current handshake call [`HandshakeRegistry::validate_handshake`].
    #[external("utility")]
    unconstrained fn get_app_siloed_secrets(
        sender: AztecAddress,
        recipient: AztecAddress,
    ) -> Option<AppSiloedHandshakeSecrets> {
        let handshake = self.storage.handshakes.at(recipient).at(sender);

        if handshake.is_initialized() {
            let note = handshake.view_note();
            Option::some(note.app_siloed_secrets_for(self.msg_sender()))
        } else {
            Option::none()
        }
    }

    /// Returns a page of discovered non-interactive handshakes addressed to `recipient`.
    ///
    /// Only non-interactive handshakes appear here: they are the ones with a handshake log the recipient's sync scan
    /// discovers.
    ///
    /// `total_count` is the full list length, so callers can determine whether more pages remain.
    ///
    /// # Privacy
    /// PXE authorizes this read for any calling contract without consulting the wallet's `authorizeUtilityCall`
    /// hook, so any contract executing for `recipient` can see that account's discovered handshakes: their count and
    /// their ephemeral public keys. This does not weaken message secrecy, as deriving the shared secret from an
    /// ephemeral key requires the recipient's secret keys.
    #[external("utility")]
    unconstrained fn get_non_interactive_handshakes(recipient: AztecAddress, page_offset: u32) -> HandshakePage {
        let handshakes = get_all_discovered_handshakes(self.context.this_address(), recipient);
        let total_count = handshakes.len();
        let offset = std::cmp::min(page_offset, total_count);
        let page_len = std::cmp::min(MAX_HANDSHAKES_PER_PAGE, total_count - offset);

        let mut items = BoundedVec::new();
        for i in 0..page_len {
            items.push(handshakes.get(offset + i));
        }
        HandshakePage { items, total_count }
    }

    /// Generates the ephemeral key and shared secret for `recipient`.
    ///
    /// Returns `(eph_pk, s_protected)`: the ephemeral public key the recipient learns, and the ECDH shared secret
    /// `S = eph_sk * recipient_point` with the forgery protection applied (see [`protect_from_forgery`]).
    ///
    /// # Panics
    /// If `recipient` is not a valid curve point.
    #[internal("private")]
    fn _generate_shared_secret(recipient: AztecAddress) -> (EmbeddedCurvePoint, EmbeddedCurvePoint) {
        let recipient_point = recipient.to_address_point().expect(f"recipient address is not on the curve");

        let (eph_sk, eph_pk) = generate_positive_ephemeral_key_pair();
        let s_protected = protect_from_forgery(
            derive_ecdh_shared_secret(eph_sk, recipient_point.inner),
            eph_pk,
            recipient_point.inner,
        );
        (eph_pk, s_protected)
    }

    /// Inserts or replaces the current [`HandshakeNote`] owned by `sender` for `recipient` and returns the
    /// app-siloed secrets for the caller (`msg_sender()`).
    #[internal("private")]
    fn _store(
        sender: AztecAddress,
        recipient: AztecAddress,
        s_protected: EmbeddedCurvePoint,
    ) -> AppSiloedHandshakeSecrets {
        // Safety: an uncooperative sender could pick a non-random value, but the sender-only secret only protects the
        // sender's own ability to advance their sequence, so a bad value only harms themselves.
        let sender_secret = unsafe { random() };
        let note = HandshakeNote::new(s_protected, sender_secret);

        // We deliver onchain unconstrained rather than offchain so the note is discoverable via normal PXE sync. This
        // is a self-send (the note is owned by and delivered to `sender`), so an address-derived secret needs no
        // handshake. Pinning that derivation here at compile time, rather than leaving it to the wallet, keeps a
        // wallet that picks a handshake for this delivery from recursing into the registry. It also lets this
        // contract, the handshake registry itself, skip the default flow's runtime registry check, which would
        // otherwise embed the registry's own address in its bytecode and make its deploy address depend on itself.
        self.storage.handshakes.at(recipient).at(sender).initialize_or_replace(|_| note).deliver(
            MessageDelivery::onchain_unconstrained().with_sender(sender).via_address_derived_secret(),
        );

        note.app_siloed_secrets_for(self.msg_sender())
    }

    /// Requests and verifies the recipient's handshake authorization.
    ///
    /// Fetches the recipient's response through a
    /// [`resolve_custom_request`](aztec::oracle::resolve_custom_request::resolve_custom_request) oracle call. The
    /// request payload carries `recipient` plus the chain context and `eph_pk.x`; it never carries `sender`, so the
    /// recipient authorizes the handshake without learning who initiated it. The response deserializes into a
    /// [`RecipientSignature`], which contains all the data needed to verify the signature in-circuit.
    ///
    /// # Panics
    /// If the returned public keys do not derive `recipient`'s address, the signing key does not match, or the
    /// signature does not verify.
    #[internal("private")]
    fn _request_and_verify_signature(recipient: AztecAddress, eph_pk: EmbeddedCurvePoint) {
        let payload = [recipient.to_field(), self.context.chain_id(), self.context.version(), eph_pk.x];
        // Safety: the response is unconstrained, but `RecipientSignature::verify` fully constrains it below: it binds
        // the returned public keys to the recipient's address and verifies the signature over an in-circuit message.
        let response = RecipientSignature::deserialize(
            unsafe { resolve_custom_request(INTERACTIVE_HANDSHAKE_REQUEST_KIND, payload) },
        );
        response.verify(
            recipient,
            self.context.chain_id(),
            self.context.version(),
            self.context.this_address(),
            eph_pk.x,
        );
    }
}
