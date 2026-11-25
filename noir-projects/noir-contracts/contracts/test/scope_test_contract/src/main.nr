use aztec::macros::aztec;

/// A simple contract for testing scope isolation on TXE.
/// Uses PrivateImmutable to store a single note per owner. Only owners should be
/// able to initialize their own notes, since their nsk are needed to do so
#[aztec]
pub contract ScopeTest {
    use aztec::{
        keys::getters::{get_public_keys, KeyType, try_get_sk_app},
        macros::{functions::{external, initializer, view}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Owned, PrivateImmutable},
    };

    use field_note::FieldNote;

    #[storage]
    struct Storage<Context> {
        note: Owned<PrivateImmutable<FieldNote, Context>, Context>,
    }

    #[initializer]
    #[external("private")]
    fn constructor() {}

    /// Creates a note with the given value for the specified owner.
    /// The note is delivered to the owner so they can discover it.
    #[external("private")]
    fn create_note(owner: AztecAddress, value: Field) {
        let note = FieldNote { value };
        self.storage.note.at(owner).initialize(note).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Creates a note for `owner`, delivered to `recipient` instead.
    #[external("private")]
    fn create_note_delivered_to(owner: AztecAddress, recipient: AztecAddress, value: Field) {
        let note = FieldNote { value };
        self.storage.note.at(owner).initialize(note).deliver_to(recipient, MessageDelivery::onchain_unconstrained());
    }

    /// Reads the note owned by the specified owner and returns its value.
    /// We are not making this a `view` function on purpose, so that we can test scoping a non-static call
    #[external("private")]
    fn read_note(owner: AztecAddress) -> Field {
        let note = self.storage.note.at(owner).get_note();
        note.value
    }

    /// Reads the note owned by the specified owner (view function).
    #[external("private")]
    #[view]
    fn view_note(owner: AztecAddress) -> Field {
        let note = self.storage.note.at(owner).get_note();
        note.value
    }

    /// Requests the nullifier hiding key for the given owner.
    /// Will fail if the caller is not authorized to access the owner's keys.
    #[external("private")]
    fn get_nhk(owner: AztecAddress) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        self.context.request_nhk_app(owner_npk_m_hash)
    }

    /// Reads the note owned by the specified owner via a utility function.
    #[external("utility")]
    unconstrained fn read_note_utility(owner: AztecAddress) -> Field {
        let note = self.storage.note.at(owner).view_note();
        note.value
    }

    /// Requests the nullifier hiding key for the given owner via a utility function.
    /// Will fail if the caller is not authorized to access the owner's keys.
    #[external("utility")]
    unconstrained fn get_nhk_utility(owner: AztecAddress) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        try_get_sk_app(owner_npk_m_hash, KeyType::nullifier_hiding()).expect(
            f"Key validation request denied: no scoped account has the nullifier hiding key of {owner}",
        )
    }

    mod test {
        use crate::ScopeTest;
        use aztec::{
            protocol::address::AztecAddress,
            test::helpers::test_environment::{CallPrivateOptions, TestEnvironment, ViewPrivateOptions},
        };

        unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
            let mut env = TestEnvironment::new();
            let deployer = env.create_light_account();

            // Deploy the contract
            let contract_address =
                env.deploy("ScopeTest").with_private_initializer(deployer, ScopeTest::interface().constructor());

            (env, contract_address)
        }

        #[test]
        unconstrained fn owner_can_read_own_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let value: Field = 42;

            // Alice creates a note for herself (delivered encrypted to her)
            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            // Alice can read her own note
            let read_value = env.call_private(alice, ScopeTest::at(contract_address).read_note(alice));
            assert_eq(read_value, value);
        }

        #[test(should_fail_with = "Key validation request denied")]
        unconstrained fn bob_cannot_access_alice_nullifier_hiding_key() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();

            let _ = env.call_private(bob, ScopeTest::at(contract_address).get_nhk(alice));
        }

        #[test(should_fail_with = "Failed to get a note")]
        unconstrained fn bob_cannot_read_alice_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            let _read_value = env.call_private(bob, ScopeTest::at(contract_address).read_note(alice));
        }

        #[test]
        unconstrained fn bob_can_read_own_notes_after_receiving_alice_note() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let alice_value: Field = 42;
            let bob_value: Field = 7;

            env.call_private(bob, ScopeTest::at(contract_address).create_note(bob, bob_value));

            // Bob can't compute the nullifier of Alice's note, since her nullifier hiding key is outside his scope, so
            // his sync must skip it instead of failing.
            env.call_private(alice, ScopeTest::at(contract_address).create_note_delivered_to(alice, bob, alice_value));

            let read_value = env.call_private(bob, ScopeTest::at(contract_address).read_note(bob));
            assert_eq(read_value, bob_value);
        }

        #[test]
        unconstrained fn bob_can_read_alice_notes_with_additional_scopes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            let read_value = env.call_private_opts(
                bob,
                CallPrivateOptions::new().with_additional_scopes([alice]),
                ScopeTest::at(contract_address).read_note(alice),
            );
            assert_eq(read_value, value);
        }

        #[test]
        unconstrained fn owner_can_view_own_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let value: Field = 42;

            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            let read_value = env.view_private(alice, ScopeTest::at(contract_address).view_note(alice));
            assert_eq(read_value, value);
        }

        #[test(should_fail_with = "Failed to get a note")]
        unconstrained fn bob_cannot_view_alice_notes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            let _read_value = env.view_private(bob, ScopeTest::at(contract_address).view_note(alice));
        }

        #[test]
        unconstrained fn bob_can_view_alice_notes_with_additional_scopes() {
            let (mut env, contract_address) = setup();

            let alice = env.create_light_account();
            let bob = env.create_light_account();
            let value: Field = 42;

            env.call_private(alice, ScopeTest::at(contract_address).create_note(alice, value));

            let read_value = env.view_private_opts(
                bob,
                ViewPrivateOptions::new().with_additional_scopes([alice]),
                ScopeTest::at(contract_address).view_note(alice),
            );
            assert_eq(read_value, value);
        }
    }
}
