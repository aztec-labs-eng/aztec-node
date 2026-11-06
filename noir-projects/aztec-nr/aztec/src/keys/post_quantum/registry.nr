use crate::{
    keys::post_quantum::mlkem768::PostQuantumPublicKey,
    oracle::call_utility_function::call_utility_function,
    protocol::{abis::function_selector::FunctionSelector, address::AztecAddress, traits::{Deserialize, ToField}},
    standard_addresses::STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS,
};

/// Domain separator for the tags of the logs in which the post-quantum public key registry publishes keys.
pub global DOM_SEP__POST_QUANTUM_PUBLIC_KEY_REGISTRY_LOG_TAG: u32 = 735910790;

// `get_post_quantum_public_key` cannot import the registry's interface because the registry contract depends on
// aztec-nr. This selector pins the registry ABI surface it calls, and the registry's test suite compares it against its
// macro-generated selector so signature drift fails in tests.
pub global GET_POST_QUANTUM_PUBLIC_KEY_SELECTOR: FunctionSelector =
    comptime { FunctionSelector::from_signature("get_post_quantum_public_key((Field))") };

/// Returns `account`'s [`PostQuantumPublicKey`], or `None` if it had not registered one by the anchor block.
///
/// Unlike their elliptic curve key, which is their address point, accounts have no native post-quantum public key, so
/// they register theirs once in the standard post-quantum public key registry for senders to learn it.
pub unconstrained fn get_post_quantum_public_key(account: AztecAddress) -> Option<PostQuantumPublicKey> {
    let returns = call_utility_function(
        STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS,
        GET_POST_QUANTUM_PUBLIC_KEY_SELECTOR,
        [account.to_field()],
    );
    Deserialize::deserialize(returns)
}
