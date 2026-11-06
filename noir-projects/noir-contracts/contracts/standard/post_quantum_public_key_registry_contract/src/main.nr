use aztec::macros::aztec;
mod public_key_cache;
mod public_key_logs;
mod test;

/// Registry of accounts' post-quantum public keys.
///
/// An account registers its
/// [`PostQuantumPublicKey`](aztec::keys::post_quantum::mlkem768::PostQuantumPublicKey) once, with
/// [`PostQuantumPublicKeyRegistry::register`], and senders read it with
/// [`PostQuantumPublicKeyRegistry::get_post_quantum_public_key`] to encapsulate to it. A registered key cannot be
/// replaced.
///
/// ## Privacy
///
/// Registering is public by design: anyone who knows an account's address can find whether and when it registered a
/// key, the key itself, and the transaction that registered it.
#[aztec]
pub contract PostQuantumPublicKeyRegistry {
    use crate::{
        public_key_cache::{get_cached_public_key, record_cached_public_key},
        public_key_logs::{emit_public_key_logs, find_public_key},
    };
    use aztec::{
        keys::post_quantum::mlkem768::PostQuantumPublicKey,
        macros::{functions::external, storage::storage},
        protocol::address::AztecAddress,
        state_vars::{Owned, SingleUseClaim},
    };

    #[storage]
    struct Storage<Context> {
        /// Each account's right to register a key, exercised on registration so that the key cannot be replaced.
        registrations: Owned<SingleUseClaim<Context>, Context>,
    }

    /// Registers `public_key` as the post-quantum public key of the caller (`msg_sender()`).
    ///
    /// An account registers its own key by calling this from its account contract. Each account can only register their
    /// public key once.
    #[external("private")]
    fn register(public_key: PostQuantumPublicKey) {
        let account = self.msg_sender();
        self.storage.registrations.at(account).claim();

        // The key is published in logs rather than stored because only unconstrained code reads it, since we don't
        // currently prove encapsulation.
        // If we wanted to be able to prove it, which we'd need to in order to have post-quantum constrained delivery
        // via non-interactive handshakes, then we'd need to prove we're using the correct recipient key in a circuit,
        // which cannot be done with logs. The key would then have to be stored in a `PublicImmutable` instead, at a
        // higher DA cost (about double, since each public storage write costs 2 DA fields: one for the slot index and
        // one for the value stored).
        emit_public_key_logs(self.context, account, public_key);
    }

    /// Returns `account`'s post-quantum public key, or `None` if it had not registered one by the anchor block.
    ///
    /// The key is fetched from the node only on the first read, and cached locally after that.
    #[external("utility")]
    unconstrained fn get_post_quantum_public_key(account: AztecAddress) -> Option<PostQuantumPublicKey> {
        let contract_address = self.context.this_address();
        let anchor_block_number = self.context.block_header().block_number();

        get_cached_public_key(contract_address, account, anchor_block_number).or_else(|| {
            find_public_key(contract_address, account).map(|(public_key, origin_block)| {
                record_cached_public_key(contract_address, account, public_key, origin_block);
                public_key
            })
        })
    }
}
