use crate::{PostQuantumPublicKeyRegistry, public_key_cache::get_cached_public_key};

use aztec::{
    keys::post_quantum::{
        mlkem768::{POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS, PostQuantumPublicKey},
        registry::{get_post_quantum_public_key, GET_POST_QUANTUM_PUBLIC_KEY_SELECTOR},
    },
    protocol::{address::AztecAddress, traits::FromField},
    standard_addresses::STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS,
    test::helpers::test_environment::{DeployOptions, TestEnvironment},
};

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let account = env.create_light_account();
    let other_account = env.create_light_account();

    let registry_address = env
        .deploy_opts(DeployOptions::new().with_salt(1).with_secret(0), "PostQuantumPublicKeyRegistry")
        .without_initializer();
    assert_eq(registry_address, STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS);

    (env, registry_address, account, other_account)
}

/// A key with no repeated fields, and no fields in common with keys made from other seeds. A registry that read back a
/// chunk in the wrong place, or one from another account's key, would therefore return a different key.
unconstrained fn make_public_key(seed: Field) -> PostQuantumPublicKey {
    PostQuantumPublicKey { fields: [0; POST_QUANTUM_PUBLIC_KEY_SIZE_IN_FIELDS].mapi(|i, _| seed * 1000 + i as Field) }
}

// aztec-nr's registry helpers cannot import this contract because the contract depends on aztec-nr. Assert their
// selector constant matches this contract's macro-generated interface so a signature change on either side fails here
// instead of silently drifting.
#[test]
unconstrained fn selector_matches_the_aztec_nr_helpers() {
    let registry = PostQuantumPublicKeyRegistry::at(AztecAddress::from_field(1));

    assert_eq(
        registry.get_post_quantum_public_key(AztecAddress::from_field(2)).selector,
        GET_POST_QUANTUM_PUBLIC_KEY_SELECTOR,
    );
}

// Doesn't use `setup`: TXE provides the standard registry, so tests that use the helper don't deploy it.
#[test]
unconstrained fn aztec_nr_helper_reads_the_key_from_the_standard_registry() {
    let mut env = TestEnvironment::new();
    let account = env.create_light_account();
    let public_key = make_public_key(1);

    env.utility_context(|_| assert(get_post_quantum_public_key(account).is_none()));

    env.call_private(
        account,
        PostQuantumPublicKeyRegistry::at(STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS).register(public_key),
    );

    env.utility_context(|_| assert_eq(get_post_quantum_public_key(account), Option::some(public_key)));
}

#[test]
unconstrained fn returns_none_for_an_account_that_has_not_registered() {
    let (env, registry_address, account, _) = setup();
    let registry = PostQuantumPublicKeyRegistry::at(registry_address);

    assert(env.execute_utility(registry.get_post_quantum_public_key(account)).is_none());
}

#[test]
unconstrained fn returns_the_registered_key() {
    let (env, registry_address, account, _) = setup();
    let registry = PostQuantumPublicKeyRegistry::at(registry_address);
    let public_key = make_public_key(1);

    env.call_private(account, registry.register(public_key));

    assert_eq(env.execute_utility(registry.get_post_quantum_public_key(account)), Option::some(public_key));
}

#[test]
unconstrained fn returns_each_account_its_own_key() {
    let (env, registry_address, account, other_account) = setup();
    let registry = PostQuantumPublicKeyRegistry::at(registry_address);
    let public_key = make_public_key(1);
    let other_public_key = make_public_key(2);

    env.call_private(account, registry.register(public_key));
    assert(env.execute_utility(registry.get_post_quantum_public_key(other_account)).is_none());

    env.call_private(other_account, registry.register(other_public_key));
    assert_eq(env.execute_utility(registry.get_post_quantum_public_key(account)), Option::some(public_key));
    assert_eq(env.execute_utility(registry.get_post_quantum_public_key(other_account)), Option::some(other_public_key));
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn registering_a_second_key_fails() {
    let (env, registry_address, account, _) = setup();
    let registry = PostQuantumPublicKeyRegistry::at(registry_address);

    env.call_private(account, registry.register(make_public_key(1)));
    env.call_private(account, registry.register(make_public_key(2)));
}

#[test]
unconstrained fn caches_the_key_from_the_block_it_was_registered_in() {
    let (env, registry_address, account, _) = setup();
    let registry = PostQuantumPublicKeyRegistry::at(registry_address);
    let public_key = make_public_key(1);

    env.call_private(account, registry.register(public_key));
    let registration_block = env.last_block_number();
    let _ = env.execute_utility(registry.get_post_quantum_public_key(account));

    env.utility_context_at(registry_address, |_| {
        assert_eq(get_cached_public_key(registry_address, account, registration_block), Option::some(public_key));
        // As of an earlier anchor the key had not been registered yet.
        assert(get_cached_public_key(registry_address, account, registration_block - 1).is_none());
    });
}
