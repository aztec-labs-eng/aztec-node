//! Nullifier creation, existence checks, etc.

use crate::macros::oracle_declaration::{prv_oracle, utl_oracle};
use crate::protocol::address::aztec_address::AztecAddress;

/// Notifies the simulator that a nullifier has been created, so that its correct status (pending or settled) can be
/// determined when reading nullifiers in subsequent private function calls. The first non-revertible nullifier emitted
/// is also used to compute note nonces.
pub fn notify_created_nullifier(inner_nullifier: Field) {
    // Safety: This oracle call returns nothing: we only call it for its side effects. It is therefore always safe to
    // call.
    unsafe { notify_created_nullifier_oracle_proxy(inner_nullifier) };
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
unconstrained fn notify_created_nullifier_oracle_proxy(inner_nullifier: Field) {
    notify_created_nullifier_internal(inner_nullifier);
}

#[prv_oracle]
unconstrained fn notify_created_nullifier_internal(inner_nullifier: Field) {
    notify_created_nullifier_internal_oracle(inner_nullifier)
}

/// Returns `true` if the nullifier has been emitted in the same transaction, i.e. if [`notify_created_nullifier`] has
/// been
/// called for this inner nullifier from the contract with the specified address.
///
/// Note that despite sharing pending transaction information with the app, this is not a privacy leak: anyone in the
/// network can always determine in which transaction a inner nullifier was emitted by a given contract by simply
/// inspecting transaction effects. What _would_ constitute a leak would be to share the list of inner pending
/// nullifiers, as that would reveal their preimages.
#[prv_oracle]
pub unconstrained fn is_nullifier_pending(inner_nullifier: Field, contract_address: AztecAddress) -> bool {
    is_nullifier_pending_oracle(inner_nullifier, contract_address)
}

/// Returns `true` if the nullifier exists. Note that a `true` value can be constrained by proving existence of the
/// nullifier, but a `false` value should not be relied upon since other transactions may emit this nullifier before
/// the current transaction is included in a block. While this might seem of little use at first, certain design
/// patterns benefit from this abstraction (see e.g. `PrivateMutable`).
// TODO(F-498): review naming consistency
pub unconstrained fn check_nullifier_exists(inner_nullifier: Field) -> bool {
    does_nullifier_exist(inner_nullifier)
}

#[utl_oracle]
unconstrained fn does_nullifier_exist(inner_nullifier: Field) -> bool {
    does_nullifier_exist_oracle(inner_nullifier)
}
