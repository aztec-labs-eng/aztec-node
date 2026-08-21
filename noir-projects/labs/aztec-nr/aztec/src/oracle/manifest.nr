//! The oracle manifest compatibility check, injected into every private and utility external function.
//!
//! The oracle carries no payload: the environment already holds the executing contract's embedded oracle
//! manifest (the artifact's `outputs.globals.oracles`, emitted by the `#[aztec]` macro), so the call is a
//! trigger for it to validate that manifest against the oracles it serves. It reports per-oracle
//! diagnostics, unlike the version handshake in [`version`](crate::oracle::version) it runs alongside.

use crate::macros::oracle_declaration::misc_oracle;

/// Asserts that the environment serves every oracle this contract was compiled against, compatibly.
pub fn assert_compatible_oracle_manifest() {
    // Safety: This oracle call takes no inputs and returns nothing; it only triggers a compatibility check
    // in the environment. It is therefore always safe to call.
    unsafe {
        assert_compatible_oracle_manifest_internal();
    }
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their
// function name in artifact bytecode: renaming this function would change every artifact hash and class ID
// (and its derived wire name).
#[misc_oracle]
unconstrained fn assert_compatible_oracle_manifest_internal() {
    assert_compatible_oracle_manifest_internal_oracle()
}
