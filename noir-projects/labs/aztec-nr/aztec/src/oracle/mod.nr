//! Standard PXE oracles.

use crate::macros::oracle_testing::generate_oracle_tests;

#[generate_oracle_tests]
pub mod avm;
#[generate_oracle_tests]
pub mod aes128_decrypt;
#[generate_oracle_tests]
pub mod auth_witness;
#[generate_oracle_tests]
pub mod block_header;
#[generate_oracle_tests]
pub mod call_private_function;
#[generate_oracle_tests]
pub mod call_utility_function;
#[generate_oracle_tests]
pub mod capsules;
#[generate_oracle_tests]
pub(crate) mod ephemeral_oracles;
#[generate_oracle_tests]
pub(crate) mod transient_oracles;
#[generate_oracle_tests]
pub mod contract_sync;
#[generate_oracle_tests]
pub mod fact_store;
#[generate_oracle_tests]
pub mod public_call;
#[generate_oracle_tests]
pub mod tx_resolution;
#[generate_oracle_tests]
pub mod resolve_custom_request;
#[generate_oracle_tests]
pub mod resolve_tagging_strategy;
#[generate_oracle_tests]
pub mod tx_phase;
#[generate_oracle_tests]
pub mod execution;
#[generate_oracle_tests]
pub mod execution_cache;
#[generate_oracle_tests]
pub mod get_contract_instance;
#[generate_oracle_tests]
pub mod get_l1_to_l2_membership_witness;
#[generate_oracle_tests]
pub mod get_nullifier_membership_witness;
#[generate_oracle_tests]
pub mod get_public_data_witness;
#[generate_oracle_tests]
pub mod get_membership_witness;
#[generate_oracle_tests]
pub mod keys;
#[generate_oracle_tests]
pub mod key_validation_request;
#[generate_oracle_tests]
pub mod logs;
#[generate_oracle_tests]
pub mod manifest;
#[generate_oracle_tests]
pub mod message_processing;
#[generate_oracle_tests]
pub mod notes;
#[generate_oracle_tests]
pub mod nullifiers;
#[generate_oracle_tests]
pub mod offchain_effect;
#[generate_oracle_tests]
pub mod version;
#[generate_oracle_tests]
pub mod random;
#[generate_oracle_tests]
pub mod shared_secret;
#[generate_oracle_tests]
pub mod storage;

// logging oracle is used by both noir-protocol-circuits and this crate and for this reason we just re-export it
// here from protocol circuits.
pub use crate::protocol::logging;
