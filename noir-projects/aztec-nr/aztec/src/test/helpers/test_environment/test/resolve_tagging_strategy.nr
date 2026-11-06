use crate::{
    keys::{constants::TAGGING_INDEX, getters::try_get_public_keys},
    messages::delivery::{
        MessageDelivery, OnchainDeliveryMode, ResolvedTaggingStrategy, tag_derivation::DOM_SEP__RECIPIENT_TSK_SECRET,
    },
    oracle::{key_validation_request::get_key_validation_request, resolve_tagging_strategy::resolve_tagging_strategy},
    protocol::{
        address::AztecAddress,
        hash::poseidon2_hash_with_separator,
        point::EmbeddedCurvePoint,
        traits::{FromField, ToField},
    },
    test::helpers::{
        tagging_secret_strategy::{compute_directional_app_secret, TaggingSecretStrategy},
        test_environment::{TestEnvironment, TestEnvironmentOptions},
    },
};

#[test]
unconstrained fn an_unset_constrained_mode_falls_back_to_the_default_strategy() {
    // Only the unconstrained mode is configured: the constrained mode falls back to the default non-interactive
    // handshake strategy.
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_unconstrained(),
        TaggingSecretStrategy::arbitrary_secret(EmbeddedCurvePoint { x: 7, y: 11 }),
    ));
    let app = env.create_contract_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_constrained(),
        );
        assert_eq(resolved, ResolvedTaggingStrategy::non_interactive_handshake());
    });
}

#[test]
unconstrained fn an_unset_unconstrained_mode_falls_back_to_the_default_strategy() {
    // Only the constrained mode is configured: the unconstrained mode falls back to the default non-interactive
    // handshake strategy for an external recipient.
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_constrained(),
        TaggingSecretStrategy::interactive_handshake(),
    ));
    let app = env.create_contract_account();
    let sender = env.create_light_account();
    let recipient = AztecAddress::from_field(8);

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            sender,
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );
        assert_eq(resolved, ResolvedTaggingStrategy::non_interactive_handshake());
    });
}

#[test]
unconstrained fn defaults_an_unconstrained_self_send_to_the_recipient_tsk() {
    let mut env = TestEnvironment::new();
    let app = env.create_contract_account();
    let sender = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(sender, sender, OnchainDeliveryMode::onchain_unconstrained());

        assert_eq(resolved, ResolvedTaggingStrategy::unconstrained_secret(recipient_tsk_secret(sender)));
    });
}

#[test]
unconstrained fn defaults_an_unconstrained_send_to_another_own_account_to_the_recipient_tsk() {
    let mut env = TestEnvironment::new();
    let app = env.create_contract_account();
    let sender = env.create_light_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            sender,
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );

        // The recipient's tsk is known and that account is in scope in this call - the sender is irrelevant.
        assert_eq(resolved, ResolvedTaggingStrategy::unconstrained_secret(recipient_tsk_secret(recipient)));
    });
}

#[test]
unconstrained fn defaults_an_unconstrained_external_send_to_a_non_interactive_handshake() {
    let mut env = TestEnvironment::new();
    let app = env.create_contract_account();
    let sender = env.create_light_account();
    // A valid address point the environment does not control (never created as an account), i.e. an external recipient.
    let recipient = AztecAddress::from_field(8);

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            sender,
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );

        // An unconstrained send to an external recipient defaults to a non-interactive handshake, since no
        // address-derived secret would be discoverable by a recipient that has not registered the sender.
        assert_eq(resolved, ResolvedTaggingStrategy::non_interactive_handshake());
    });
}

#[test]
unconstrained fn defaults_constrained_delivery_to_a_non_interactive_handshake() {
    let mut env = TestEnvironment::new();
    let app = env.create_contract_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_constrained(),
        );

        assert_eq(resolved, ResolvedTaggingStrategy::non_interactive_handshake());
    });
}

#[test]
unconstrained fn constrained_delivery_succeeds_with_a_configured_strategy() {
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy_all_modes(
        TaggingSecretStrategy::non_interactive_handshake(),
    ));
    let app = env.create_contract_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_constrained(),
        );
        assert_eq(resolved, ResolvedTaggingStrategy::non_interactive_handshake());
    });
}

#[test]
unconstrained fn applies_a_configured_interactive_handshake_strategy() {
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_constrained(),
        TaggingSecretStrategy::interactive_handshake(),
    ));
    let app = env.create_contract_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_constrained(),
        );
        assert_eq(resolved, ResolvedTaggingStrategy::interactive_handshake());
    });
}

#[test]
unconstrained fn applies_a_configured_recipient_tsk_strategy() {
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_unconstrained(),
        TaggingSecretStrategy::recipient_tsk(),
    ));
    let app = env.create_contract_account();
    let recipient = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );

        assert_eq(resolved, ResolvedTaggingStrategy::unconstrained_secret(recipient_tsk_secret(recipient)));
    });
}

#[test]
unconstrained fn applies_the_strategy_set_in_the_options() {
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_unconstrained(),
        TaggingSecretStrategy::arbitrary_secret(EmbeddedCurvePoint { x: 7, y: 11 }),
    ));
    let app = env.create_contract_account();
    let recipient = AztecAddress::from_field(8);

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );
        assert(resolved.is_unconstrained_secret());
    });
}

#[test]
unconstrained fn app_silos_an_arbitrary_secret_point() {
    // Both delivery modes resolve the configured arbitrary secret to the same app-siloed point. Mode-blindness
    // is deliberate: PXE's tagging-strategy hook resolves whatever the wallet configured regardless of mode, and
    // the TXE oracle must match that behavior. Constrained delivery rejects unsound secrets later, not here.
    let point = EmbeddedCurvePoint { x: 7, y: 11 };
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy_all_modes(
        TaggingSecretStrategy::arbitrary_secret(point),
    ));
    let app = env.create_contract_account();
    let recipient = AztecAddress::from_field(8);

    env.private_context_at(app, |_| {
        let expected_secret = compute_directional_app_secret(point, app, recipient);

        let resolved_unconstrained = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_unconstrained(),
        );
        assert_eq(resolved_unconstrained, ResolvedTaggingStrategy::unconstrained_secret(expected_secret));

        let resolved_constrained = resolve_tagging_strategy(
            AztecAddress::from_field(1),
            recipient,
            OnchainDeliveryMode::onchain_constrained(),
        );
        assert_eq(resolved_constrained, ResolvedTaggingStrategy::unconstrained_secret(expected_secret));
    });
}

#[test]
unconstrained fn applies_a_configured_arbitrary_secret_to_an_unconstrained_self_send() {
    let point = EmbeddedCurvePoint { x: 7, y: 11 };
    let mut env = TestEnvironment::new_opts(TestEnvironmentOptions::new().with_default_tag_secret_strategy(
        MessageDelivery::onchain_unconstrained(),
        TaggingSecretStrategy::arbitrary_secret(point),
    ));
    let app = env.create_contract_account();
    let sender = env.create_light_account();

    env.private_context_at(app, |_| {
        let resolved = resolve_tagging_strategy(sender, sender, OnchainDeliveryMode::onchain_unconstrained());

        let arbitrary_secret = compute_directional_app_secret(point, app, sender);
        assert_eq(resolved, ResolvedTaggingStrategy::unconstrained_secret(arbitrary_secret));
    });
}

/// The tagging secret of `account` for the executing contract, built from the app-siloed key the kernel validates.
// TODO(F-948): use aztec-nr's own derivation of this secret once it has one, e.g. once delivery can constrain it.
unconstrained fn recipient_tsk_secret(account: AztecAddress) -> Field {
    let tpk_m_hash = try_get_public_keys(account).unwrap().tpk_m_hash;
    let tsk_app = get_key_validation_request(tpk_m_hash, TAGGING_INDEX).sk_app;
    poseidon2_hash_with_separator([tsk_app, account.to_field()], DOM_SEP__RECIPIENT_TSK_SECRET)
}
