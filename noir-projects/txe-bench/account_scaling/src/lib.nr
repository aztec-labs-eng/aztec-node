//! TXE benchmark: a fixed private workload run with a growing number of accounts in the test.
//!
//! Five traders mint and transfer a private token (15 private transactions), then read their private balances. Each
//! test adds idle accounts up to its total account count. The idle accounts take no part in the workload, so the
//! difference between the tests is what the TXE spends on accounts that do nothing.
//!
//! This package is in no workspace, so the regular test runs skip it. It is run by
//! `noir-projects/noir-contracts/scripts/bench_txe.sh`, and deploys the Token artifact that the `noir-contracts`
//! build produces.

use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use token::Token;

global TRADERS: u32 = 5;
global TRANSFER_ROUNDS: u32 = 2;
global MINT_AMOUNT: u128 = 1000;
global TRANSFER_AMOUNT: u128 = 10;

unconstrained fn run(total_accounts: u32) {
    let mut env = TestEnvironment::new();
    let mut traders: BoundedVec<AztecAddress, TRADERS> = BoundedVec::new();
    for _ in 0..TRADERS {
        traders.push(env.create_contract_account());
    }
    for _ in TRADERS..total_accounts {
        let _ = env.create_light_account();
    }
    let admin = traders.get(0);
    let token = env.deploy("../../noir-contracts@token_contract/Token").with_public_initializer(
        admin,
        Token::interface().constructor(
            admin,
            "BenchToken000000000000000000000",
            "BT00000000000000000000000000000",
            18,
        ),
    );

    for i in 0..TRADERS {
        env.call_private(admin, Token::at(token).mint_to_private(traders.get(i), MINT_AMOUNT));
    }
    for _ in 0..TRANSFER_ROUNDS {
        for i in 0..TRADERS {
            env.call_private(
                traders.get(i),
                Token::at(token).transfer(traders.get((i + 1) % TRADERS), TRANSFER_AMOUNT),
            );
        }
    }
    // Each trader sends and receives the same amount in every round, so every balance is back to the minted amount.
    for i in 0..TRADERS {
        assert_eq(
            env.execute_utility(Token::at(token).balance_of_private(traders.get(i))),
            MINT_AMOUNT,
        );
    }
}

#[test]
unconstrained fn accounts_05() {
    run(5);
}

#[test]
unconstrained fn accounts_20() {
    run(20);
}

#[test]
unconstrained fn accounts_40() {
    run(40);
}
