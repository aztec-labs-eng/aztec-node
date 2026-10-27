use crate::TxEffectOracleTest;
use aztec::test::helpers::{test_environment::TestEnvironment, txe_oracles};

#[test]
unconstrained fn tx_effects_agree_across_oracles_and_carry_their_block() {
    let mut env = TestEnvironment::new();

    let contract_address = env.deploy("TxEffectOracleTest").without_initializer();
    let first_tx_hash = txe_oracles::get_last_tx_effects().tx_hash;
    let first_block = env.last_block_number();

    let _ = env.deploy("TxEffectOracleTest").without_initializer();
    let second_tx_hash = txe_oracles::get_last_tx_effects().tx_hash;
    let second_block = env.last_block_number();

    let singular = [
        env.execute_utility(TxEffectOracleTest::at(contract_address).get_tx_effect_hash(first_tx_hash)),
        env.execute_utility(TxEffectOracleTest::at(contract_address).get_tx_effect_hash(second_tx_hash)),
    ];

    let batch = env.execute_utility(TxEffectOracleTest::at(contract_address).get_tx_effects_hashes([
        first_tx_hash,
        second_tx_hash,
    ]));

    let batch_with_block = env.execute_utility(TxEffectOracleTest::at(contract_address).get_tx_effect_with_block_hashes(
        [first_tx_hash, second_tx_hash],
    ));

    // All three oracles return the same effect for a given tx, in request order.
    assert_eq(batch, singular);
    assert_eq(batch_with_block, singular);

    let blocks = env.execute_utility(TxEffectOracleTest::at(contract_address).get_tx_effect_blocks([
        first_tx_hash,
        second_tx_hash,
    ]));

    assert_eq(blocks[0].block_number, first_block);
    assert_eq(blocks[1].block_number, second_block);
}

#[test]
unconstrained fn get_tx_effect_returns_none_for_unknown_tx() {
    let mut env = TestEnvironment::new();
    let contract_address = env.deploy("TxEffectOracleTest").without_initializer();

    env.execute_utility(TxEffectOracleTest::at(contract_address).assert_is_none(0x1234));
}
