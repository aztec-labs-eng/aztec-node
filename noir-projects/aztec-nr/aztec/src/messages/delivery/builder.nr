use crate::protocol::address::AztecAddress;
use super::messaging_secret_derivation::MessagingSecretDerivation;
use super::mode::{DeliveryMode, OnchainDeliveryMode};

/// Specifies how to deliver a message to a recipient.
///
/// All messages are delivered encrypted for their recipient, so no other account will be able to read their contents.
/// This struct instead configures which **guarantees** exist regarding delivery.
///
/// There are two aspects to delivery guarantees:
/// - the medium on which the message is sent (off-chain or on-chain)
/// - whether the contract constrains the message to be constructed correctly
///
/// For scenarios where the sender is incentivized to deliver the message correctly, use [`MessageDelivery::offchain`]
/// (the cheapest delivery option, but requiring that sender and recipient can communicate off-chain) or
/// [`MessageDelivery::onchain_unconstrained`]. If the sender cannot be trusted to send the message to the recipient,
/// use [`MessageDelivery::onchain_constrained`].
///
/// ## Construction
///
/// The fields are private and there is no public constructor: a `MessageDelivery` can only be produced by a
/// [`MessageDeliveryBuilder`].
pub struct MessageDelivery {
    mode: DeliveryMode,
    sender_override: Option<AztecAddress>,
    messaging_secret_derivation: Option<MessagingSecretDerivation>,
}

impl MessageDelivery {
    pub(crate) fn mode(self) -> DeliveryMode {
        self.mode
    }

    pub(crate) fn sender_override(self) -> Option<AztecAddress> {
        self.sender_override
    }

    pub(crate) fn messaging_secret_derivation(self) -> Option<MessagingSecretDerivation> {
        self.messaging_secret_derivation
    }

    /// Delivers the message fully off-chain, with no guarantees whatsoever.
    ///
    /// ## Use Cases
    ///
    /// This delivery method is suitable when the sender is required to send the message to the recipient because of
    /// some external reason, and where the sender is able to directly contact the recipient off-chain. In these
    /// cases, it might be unnecessary to force the sender to spend proving time guaranteeing message correctness, or
    /// to pay transaction fees in order to use the chain as a medium.
    ///
    /// For example, if performing a payment in exchange for some good or service, the recipient will only accept the
    /// payment once they receive note and event messages, allowing them to observe the balance increase. The sender
    /// has no reason not to deliver the message correctly to the recipient, and in all likelihood has a way to send
    /// it to them.
    ///
    /// Similarly, in games and other applications that might rely on some server processing state, players might be
    /// required to update the server with their current state.
    ///
    /// Finally, any messages for which the recipient is a local account (e.g.: the message for the change note in a
    /// token transfer) work well with this delivery option, since the sender would only be harming themselves by not
    /// delivering correctly.
    ///
    /// ## Guarantees
    ///
    /// The sender of the message is free to both not deliver the message to the recipient at all (since no delivery
    /// occurs on-chain), and to alter the message contents (possibly resulting in an undecryptable message, or one
    /// with incorrect content).
    ///
    /// An undecryptable or otherwise invalid note or event message will however simply be ignored by the recipient,
    /// who can always validate the existence of the note or event on-chain.
    ///
    /// Because the message is not stored on-chain, it is the sender's (and eventually recipient's) responsibility to
    /// back it up and make sure it is not lost.
    ///
    /// ## Costs
    ///
    /// Because no data is emitted on-chain, this delivery option is the cheapest one in terms of transaction fees:
    /// these are zero.
    ///
    /// Additionally, no circuit gates are introduced when the message is encrypted, since its provenance cannot be
    /// authenticated anyway. Therefore, off-chain messages do not affect proving time at all.
    ///
    /// ## Privacy
    ///
    /// No information is revealed on-chain about sender, recipient, or the message contents. The message itself
    /// reveals no information about the sender or recipient, and requires knowledge of the recipient's private address
    /// keys in order to obtain the plaintext.
    pub fn offchain() -> OffchainDelivery {
        OffchainDelivery {}
    }

    /// Delivers the message on-chain, but with no guarantees on the content.
    ///
    /// ## Use Cases
    ///
    /// This delivery method is suitable when the sender is required to send the message to the recipient because of
    /// some external reason, but might not have a way to contact them off-chain, or does not wish to bear the
    /// responsability of keeping backups. In these cases, it might be unnecessary to force the sender to spend proving
    /// time guaranteeing message correctness.
    ///
    /// For example, when depositing funds into an escrow or sale contract the sender may not have an off-chain channel
    /// through which they could send the recipient a message. But since the recipient will not acknowledge receipt and
    /// proceed with the exchange unless they obtain the message, the sender has no reason not to deliver the message
    /// correctly.
    ///
    /// ## Guarantees
    ///
    /// The message will be stored on-chain in a private log, as part of the transaction's effects, and will be
    /// retrievable in the future without requiring any backups. However, the sender is free to alter the message
    /// contents (possibly resulting in an undecryptable message, or one with incorrect content), including making it
    /// so that the recipient cannot find it.
    ///
    /// An undecryptable or otherwise invalid note or event message will however simply be ignored by the recipient,
    /// who can always validate the existence of the note or event on-chain.
    ///
    /// These guarantees make this delivery mechanism be quite similar to [`MessageDelivery::offchain`], except the
    /// sender does not need to establish an off-chain communication channel with the recipient, and neither party
    /// needs to worry about backups.
    ///
    /// ## Costs
    ///
    /// Because the encrypted message is emitted on-chain as transaction private logs, this delivery option results in
    /// transaction fees associated with DA gas. The length of the original message is irrelevant to this cost, since
    /// all private logs are padded to the same length with random data to enhance privacy.
    ///
    /// However, no circuit gates are introduced when the message is encrypted. Therefore, on-chain unconstrained
    /// messages do not affect proving time at all.
    ///
    /// ## Privacy
    ///
    /// The message itself reveals no information on-chain about sender, recipient, or contents: both obtaining the
    /// plaintext and recognizing that a log was sent between a given sender and recipient require their shared
    /// messaging secret. What deriving that secret reveals, and to whom, depends on the derivation: see the `via_*`
    /// methods of [`OnchainUnconstrainedDelivery`].
    ///
    /// Delivering the message does produce on-chain information in the form of private logs, so transactions that
    /// deliver many messages this way might be identifiable by the large number of logs.
    pub fn onchain_unconstrained() -> OnchainUnconstrainedDelivery {
        OnchainUnconstrainedDelivery::new()
    }

    /// Delivers the message on-chain, guaranteeing the recipient will receive the correct content.
    ///
    /// ## Use Cases
    ///
    /// This delivery method is suitable for all use cases, since it always works as expected. It is however the most
    /// costly method, and there are multiple scenarios where alternatives such as [`MessageDelivery::offchain`] or
    /// [`MessageDelivery::onchain_unconstrained`] will suffice.
    ///
    /// If the sender cannot be relied on to correctly send the message to the recipient (e.g. because they have no
    /// incentive to do so, such as when paying a fee to a protocol, creating the change note after spending a third
    /// party's tokens, or updating the configuration of a shared system like a multisig) then this is the only
    /// suitable delivery option.
    ///
    /// ## Guarantees
    ///
    /// The message will be stored on-chain in a private log, as part of the transaction's effects, and will be
    /// retrievable in the future without requiring any backups. The ciphertext will be decryptable by the recipient
    /// using the messaging secret that tags it, and the log will be tagged so that the recipient can efficiently find
    /// it.
    ///
    /// ## Sequences
    ///
    /// So that the recipient finds every message, the messages delivered to a recipient with the same messaging secret
    /// form a sequence: each one takes the next index, and its delivery proves that the previous one was delivered. The
    /// recipient scans a sequence's tags in order.
    ///
    /// Transactions that deliver on the same sequence must therefore land one after another, as concurrent ones can
    /// fail, while transactions that deliver to different recipients do not affect each other. Several messages on one
    /// sequence can share a transaction, provided that the handshake behind it, if any, landed in an earlier
    /// transaction.
    ///
    /// Third parties cannot interfere with a sequence to make these transactions fail: only the sequence's senders can
    /// extend it.
    ///
    /// ## Costs
    ///
    /// Because the encrypted message is emitted on-chain as transaction private logs, this delivery option results in
    /// transaction fees associated with DA gas. The length of the original message is irrelevant to this cost, since
    /// all private logs are padded to the same length with random data to enhance privacy.
    ///
    /// Additionally, the constraining of the log's tag results in additional DA usage and hence transaction fees due
    /// to the emission of nullifiers.
    ///
    /// Proving time is also increased as circuit gates are introduced to guarantee both the correct encryption of
    /// the message, and selection of log tag.
    ///
    /// ## Privacy
    ///
    /// The same as for [`MessageDelivery::onchain_unconstrained`], except that delivery also emits nullifiers, so
    /// transactions that deliver many messages this way might be identifiable by the large number of logs and
    /// nullifiers.
    pub fn onchain_constrained() -> OnchainConstrainedDelivery {
        OnchainConstrainedDelivery::new()
    }
}

/// Builds the [`MessageDelivery`] configuration consumed by the message delivery APIs (e.g. `NoteMessage::deliver` and
/// `EventMessage::deliver`). Implemented by the builder types returned from the [`MessageDelivery`] constructors.
pub trait MessageDeliveryBuilder {
    fn build_message_delivery(self) -> MessageDelivery;
}

/// Off-chain delivery. Returned by [`MessageDelivery::offchain`].
pub struct OffchainDelivery {}

impl MessageDeliveryBuilder for OffchainDelivery {
    fn build_message_delivery(self) -> MessageDelivery {
        MessageDelivery {
            mode: DeliveryMode::offchain(),
            sender_override: Option::none(),
            messaging_secret_derivation: Option::none(),
        }
    }
}

/// On-chain unconstrained delivery. Returned by [`MessageDelivery::onchain_unconstrained`].
///
/// ## Messaging secret
///
/// The message is tagged and encrypted with a messaging secret that the sender and the recipient share. By default,
/// delivery uses the handshake the sender has already registered with the recipient, if any, and otherwise lets the
/// wallet choose how to derive the secret. PXE's default is the
/// [recipient's tagging key][`OnchainUnconstrainedDelivery::via_recipient_tsk_secret`] when it can use the recipient's
/// keys, as it can for the sender itself, and a
/// [non-interactive handshake][`OnchainUnconstrainedDelivery::via_non_interactive_handshake`] otherwise.
///
/// The `via_*` methods choose the derivation instead, overriding the wallet. Each one describes what it reveals and
/// what it requires.
pub struct OnchainUnconstrainedDelivery {
    sender_override: Option<AztecAddress>,
    messaging_secret_derivation: Option<MessagingSecretDerivation>,
}

impl OnchainUnconstrainedDelivery {
    fn new() -> Self {
        Self { sender_override: Option::none(), messaging_secret_derivation: Option::none() }
    }

    /// Overrides the sender that the messaging secret is chosen for.
    ///
    /// By default, the sender is the wallet-supplied address (typically the account that initiated the transaction),
    /// but some contracts need to override it so that recipients can discover the notes correctly. This is the case for
    /// account contracts in their constructor: the deployer is the one that initiated the transaction, but any notes
    /// generated during deployment should be sent by the account contract itself. See [`OnchainUnconstrainedDelivery`]
    /// for how the messaging secret is chosen.
    ///
    /// ## Examples
    ///
    /// ```noir
    /// MessageDelivery::onchain_unconstrained().with_sender(self.address)
    /// ```
    pub fn with_sender(&mut self, sender: AztecAddress) -> Self {
        self.sender_override = Option::some(sender);
        *self
    }

    /// Derives the messaging secret from a handshake with the recipient, establishing a non-interactive one if none is
    /// registered.
    ///
    /// Establishing the handshake reveals to anyone who knows the recipient's address that someone performed a
    /// handshake with them, though not who. As the handshake is established in the transaction that delivers the first
    /// message, it also reveals that this transaction likely carries a message for them, though nothing about the
    /// contents of that or any later message. An interactive handshake
    /// ([`OnchainUnconstrainedDelivery::via_interactive_handshake`]) reveals nothing, but requires the recipient's
    /// cooperation.
    pub fn via_non_interactive_handshake(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::non_interactive_handshake());
        *self
    }

    /// Derives the messaging secret from a handshake with the recipient, establishing an interactive one if none is
    /// registered.
    ///
    /// Establishing the handshake reveals nothing about the sender or the recipient, unlike a non-interactive handshake
    /// ([`OnchainUnconstrainedDelivery::via_non_interactive_handshake`]). It does however require the recipient's
    /// cooperation: they must sign it, so the send fails if they cannot be reached.
    pub fn via_interactive_handshake(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::interactive_handshake());
        *self
    }

    /// Derives the messaging secret from the sender's and the recipient's address keys, via Diffie-Hellman.
    ///
    /// Reveals nothing about the sender or the recipient, and needs no handshake. Anyone able to break either party's
    /// address key, for example with a quantum computer, can however compute the secret, unlike that of
    /// [`OnchainUnconstrainedDelivery::via_recipient_tsk_secret`].
    ///
    /// The recipient only finds the message if their wallet looks for messages from the sender, which it does for the
    /// recipient's own accounts and for the senders the recipient registers: the recipient must know to expect messages
    /// from the sender.
    pub fn via_address_derived_secret(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::address_derived());
        *self
    }

    /// Derives the messaging secret from the recipient's tagging key, regardless of the sender.
    ///
    /// Reveals nothing about the sender or the recipient, even to someone able to break the recipient's address key,
    /// for example with a quantum computer, as the tagging key is independent of it.
    ///
    /// The send fails unless the sender's PXE holds the recipient's keys and the recipient is in the execution's
    /// scopes, both of which are typically true when delivering to the sender itself.
    pub fn via_recipient_tsk_secret(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::recipient_tsk());
        *self
    }
}

impl MessageDeliveryBuilder for OnchainUnconstrainedDelivery {
    fn build_message_delivery(self) -> MessageDelivery {
        MessageDelivery {
            mode: DeliveryMode::onchain_unconstrained(),
            sender_override: self.sender_override,
            messaging_secret_derivation: self.messaging_secret_derivation,
        }
    }
}

impl From<OnchainUnconstrainedDelivery> for OnchainDeliveryMode {
    fn from(_delivery: OnchainUnconstrainedDelivery) -> OnchainDeliveryMode {
        OnchainDeliveryMode::onchain_unconstrained()
    }
}

/// On-chain constrained delivery. Returned by [`MessageDelivery::onchain_constrained`].
///
/// The messaging secret is chosen as for [`OnchainUnconstrainedDelivery`], except that not all derivations can be
/// constrained: delivery fails if the wallet resolves one that cannot.
pub struct OnchainConstrainedDelivery {
    sender_override: Option<AztecAddress>,
    messaging_secret_derivation: Option<MessagingSecretDerivation>,
}

impl OnchainConstrainedDelivery {
    fn new() -> Self {
        Self { sender_override: Option::none(), messaging_secret_derivation: Option::none() }
    }

    /// Overrides the sender that the messaging secret is chosen for.
    ///
    /// See [`OnchainUnconstrainedDelivery::with_sender`] for details.
    ///
    /// ## Examples
    ///
    /// ```noir
    /// MessageDelivery::onchain_constrained().with_sender(self.address)
    /// ```
    pub fn with_sender(&mut self, sender: AztecAddress) -> Self {
        self.sender_override = Option::some(sender);
        *self
    }

    /// Derives the messaging secret from a handshake with the recipient, establishing a non-interactive one if none is
    /// registered.
    ///
    /// See [`OnchainUnconstrainedDelivery::via_non_interactive_handshake`] for details.
    pub fn via_non_interactive_handshake(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::non_interactive_handshake());
        *self
    }

    /// Derives the messaging secret from a handshake with the recipient, establishing an interactive one if none is
    /// registered.
    ///
    /// See [`OnchainUnconstrainedDelivery::via_interactive_handshake`] for details.
    pub fn via_interactive_handshake(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::interactive_handshake());
        *self
    }

    /// Derives the messaging secret from the recipient's tagging key, regardless of the sender.
    ///
    /// See [`OnchainUnconstrainedDelivery::via_recipient_tsk_secret`] for details.
    pub fn via_recipient_tsk_secret(&mut self) -> Self {
        self.messaging_secret_derivation = Option::some(MessagingSecretDerivation::recipient_tsk());
        *self
    }
}

impl MessageDeliveryBuilder for OnchainConstrainedDelivery {
    fn build_message_delivery(self) -> MessageDelivery {
        MessageDelivery {
            mode: DeliveryMode::onchain_constrained(),
            sender_override: self.sender_override,
            messaging_secret_derivation: self.messaging_secret_derivation,
        }
    }
}

impl From<OnchainConstrainedDelivery> for OnchainDeliveryMode {
    fn from(_delivery: OnchainConstrainedDelivery) -> OnchainDeliveryMode {
        OnchainDeliveryMode::onchain_constrained()
    }
}

mod test {
    use crate::protocol::address::AztecAddress;
    use crate::protocol::traits::FromField;
    use super::{DeliveryMode, MessageDelivery, MessageDeliveryBuilder, MessagingSecretDerivation, OnchainDeliveryMode};

    #[test]
    fn onchain_deliveries_default_to_no_sender() {
        let unconstrained_delivery = MessageDelivery::onchain_unconstrained().build_message_delivery();
        let constrained_delivery = MessageDelivery::onchain_constrained().build_message_delivery();

        assert(unconstrained_delivery.sender_override().is_none());
        assert(constrained_delivery.sender_override().is_none());
    }

    #[test]
    fn with_sender_populates_the_config() {
        let sender = AztecAddress::from_field(7);

        let unconstrained_delivery =
            MessageDelivery::onchain_unconstrained().with_sender(sender).build_message_delivery();
        let constrained_delivery = MessageDelivery::onchain_constrained().with_sender(sender).build_message_delivery();

        assert(unconstrained_delivery.sender_override().unwrap() == sender);
        assert(constrained_delivery.sender_override().unwrap() == sender);
    }

    #[test]
    fn builders_convert_to_expected_onchain_modes() {
        let unconstrained_mode: OnchainDeliveryMode = MessageDelivery::onchain_unconstrained().into();
        let constrained_mode: OnchainDeliveryMode = MessageDelivery::onchain_constrained().into();

        assert(unconstrained_mode == OnchainDeliveryMode::onchain_unconstrained());
        assert(constrained_mode == OnchainDeliveryMode::onchain_constrained());
    }

    #[test]
    fn built_delivery_mode_matches_the_mode() {
        assert(MessageDelivery::offchain().build_message_delivery().mode() == DeliveryMode::offchain());
        assert(
            MessageDelivery::onchain_unconstrained().build_message_delivery().mode()
                == DeliveryMode::onchain_unconstrained(),
        );
        assert(
            MessageDelivery::onchain_constrained().build_message_delivery().mode()
                == DeliveryMode::onchain_constrained(),
        );
    }

    #[test]
    fn messaging_secret_derivation_defaults_to_none_and_via_methods_populate_it() {
        let default_unconstrained = MessageDelivery::onchain_unconstrained().build_message_delivery();
        let default_constrained = MessageDelivery::onchain_constrained().build_message_delivery();
        assert(default_unconstrained.messaging_secret_derivation().is_none());
        assert(default_constrained.messaging_secret_derivation().is_none());

        let unconstrained_delivery =
            MessageDelivery::onchain_unconstrained().via_address_derived_secret().build_message_delivery();
        assert_eq(
            unconstrained_delivery.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::address_derived()),
        );

        let constrained_delivery =
            MessageDelivery::onchain_constrained().via_non_interactive_handshake().build_message_delivery();
        assert_eq(
            constrained_delivery.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::non_interactive_handshake()),
        );

        let unconstrained_interactive =
            MessageDelivery::onchain_unconstrained().via_interactive_handshake().build_message_delivery();
        assert_eq(
            unconstrained_interactive.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::interactive_handshake()),
        );

        let constrained_interactive =
            MessageDelivery::onchain_constrained().via_interactive_handshake().build_message_delivery();
        assert_eq(
            constrained_interactive.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::interactive_handshake()),
        );

        let unconstrained_recipient_tsk =
            MessageDelivery::onchain_unconstrained().via_recipient_tsk_secret().build_message_delivery();
        assert_eq(
            unconstrained_recipient_tsk.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::recipient_tsk()),
        );

        let constrained_recipient_tsk =
            MessageDelivery::onchain_constrained().via_recipient_tsk_secret().build_message_delivery();
        assert_eq(
            constrained_recipient_tsk.messaging_secret_derivation(),
            Option::some(MessagingSecretDerivation::recipient_tsk()),
        );
    }
}
