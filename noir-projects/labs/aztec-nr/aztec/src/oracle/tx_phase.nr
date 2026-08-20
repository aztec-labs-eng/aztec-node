use crate::macros::oracle_declaration::prv_oracle;

/// Notifies PXE of the side effect counter at which the revertible phase begins.
///
/// PXE uses it to classify notes and nullifiers as revertible or non-revertible in its note cache. This information is
/// then fed to kernels as hints.
pub(crate) fn notify_revertible_phase_start(counter: u32) {
    // Safety: This oracle call returns nothing: we only call it for its side effects. It is therefore always safe to
    // call.
    unsafe { notify_revertible_phase_start_oracle_wrapper(counter) };
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
unconstrained fn notify_revertible_phase_start_oracle_wrapper(counter: u32) {
    notify_revertible_phase_start_internal(counter);
}

/// Returns whether a side effect counter falls in the revertible phase of the transaction.
#[prv_oracle]
pub(crate) unconstrained fn is_execution_in_revertible_phase(current_counter: u32) -> bool {
    is_execution_in_revertible_phase_oracle(current_counter)
}

#[prv_oracle]
unconstrained fn notify_revertible_phase_start_internal(counter: u32) {
    notify_revertible_phase_start_internal_oracle(counter);
}
