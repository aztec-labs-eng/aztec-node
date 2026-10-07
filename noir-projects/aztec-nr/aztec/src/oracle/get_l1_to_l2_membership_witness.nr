use crate::protocol::{address::AztecAddress, constants::L1_TO_L2_MSG_TREE_HEIGHT};

/// An unsiloed L1 to L2 message nullifier.
pub struct UnsiloedNullifier {
    pub contract_address: AztecAddress,
    pub nullifier: Field,
}

/// Returns the leaf index and sibling path of an entry in the L1 to L2 messaging tree, which can then be used to prove
/// its existence.
///
/// When `nullifier` is `Some`, the returned witness is guaranteed to be for a message that has not yet been consumed:
/// PXE checks it is not present in the nullifier tree. Pass `None` to retrieve the witness regardless of whether the
/// message has been consumed.
pub unconstrained fn get_l1_to_l2_membership_witness(
    message_hash: Field,
    nullifier: Option<UnsiloedNullifier>,
) -> (Field, [Field; L1_TO_L2_MSG_TREE_HEIGHT]) {
    get_l1_to_l2_membership_witness_oracle(message_hash, nullifier)
}

/// Returns the leaf index and sibling path of an entry in the L1 to L2 messaging tree, or `None` if there is no such
/// entry.
///
/// When `nullifier` is `Some`, `None` is also returned if the message has already been consumed. Pass `None` to
/// retrieve the witness regardless of whether the message has been consumed.
pub unconstrained fn try_get_l1_to_l2_membership_witness(
    message_hash: Field,
    nullifier: Option<UnsiloedNullifier>,
) -> Option<(Field, [Field; L1_TO_L2_MSG_TREE_HEIGHT])> {
    try_get_l1_to_l2_membership_witness_oracle(message_hash, nullifier)
}

// Obtains membership witness (index and sibling path) for a message in the L1 to L2 message tree.
#[oracle(aztec_utl_getL1ToL2MembershipWitnessV2)]
unconstrained fn get_l1_to_l2_membership_witness_oracle(
    _message_hash: Field,
    _nullifier: Option<UnsiloedNullifier>,
) -> (Field, [Field; L1_TO_L2_MSG_TREE_HEIGHT]) {}

#[oracle(aztec_utl_tryGetL1ToL2MembershipWitness)]
unconstrained fn try_get_l1_to_l2_membership_witness_oracle(
    _message_hash: Field,
    _nullifier: Option<UnsiloedNullifier>,
) -> Option<(Field, [Field; L1_TO_L2_MSG_TREE_HEIGHT])> {}

mod test {
    use crate::hash::{compute_l1_to_l2_message_hash, compute_l1_to_l2_message_nullifier, compute_secret_hash};
    use crate::protocol::{
        address::{AztecAddress, EthAddress},
        merkle_tree::root::root_from_sibling_path,
        traits::FromField,
    };
    use crate::test::helpers::test_environment::TestEnvironment;
    use super::{try_get_l1_to_l2_membership_witness, UnsiloedNullifier};

    global CONTENT: Field = 0x0a0b0c;
    global SECRET: Field = 0x1234;

    #[test]
    unconstrained fn try_get_returns_witness_for_existing_message() {
        let env = TestEnvironment::new();
        let (_, _, leaf_index, message_hash) = send_message(env);

        env.utility_context(|context| {
            let (witness_leaf_index, sibling_path) =
                try_get_l1_to_l2_membership_witness(message_hash, Option::none()).unwrap();

            assert_eq(witness_leaf_index, leaf_index);
            assert_eq(
                root_from_sibling_path(message_hash, leaf_index, sibling_path),
                context.block_header().state.l1_to_l2_message_tree.root,
            );
        });
    }

    #[test]
    unconstrained fn try_get_returns_none_for_missing_message() {
        let env = TestEnvironment::new();
        let (_, _, _, message_hash) = send_message(env);

        env.utility_context(|_| {
            assert(try_get_l1_to_l2_membership_witness(message_hash + 1, Option::none()).is_none());
        });
    }

    #[test]
    unconstrained fn try_get_returns_none_for_consumed_message_when_given_its_nullifier() {
        let env = TestEnvironment::new();
        let (sender, recipient, leaf_index, message_hash) = send_message(env);
        let nullifier = UnsiloedNullifier {
            contract_address: recipient,
            nullifier: compute_l1_to_l2_message_nullifier(message_hash, [SECRET]),
        };

        env.utility_context(|_| {
            assert(try_get_l1_to_l2_membership_witness(message_hash, Option::some(nullifier)).is_some());
        });

        env.private_context_at(recipient, |context| {
            context.consume_l1_to_l2_message(CONTENT, [SECRET], sender, leaf_index);
        });
        env.utility_context(|_| {
            assert(try_get_l1_to_l2_membership_witness(message_hash, Option::some(nullifier)).is_none());
            assert(try_get_l1_to_l2_membership_witness(message_hash, Option::none()).is_some());
        });
    }

    unconstrained fn send_message(env: TestEnvironment) -> (EthAddress, AztecAddress, Field, Field) {
        let sender = EthAddress::from_field(0xdead);
        let recipient = AztecAddress::from_field(17);
        let leaf_index = env.send_l1_to_l2_message(CONTENT, SECRET, sender, recipient);
        let message_hash = env.utility_context(|context| {
            compute_l1_to_l2_message_hash(
                sender,
                context.chain_id(),
                recipient,
                context.version(),
                CONTENT,
                compute_secret_hash([SECRET]),
                leaf_index,
            )
        });
        (sender, recipient, leaf_index, message_hash)
    }
}
