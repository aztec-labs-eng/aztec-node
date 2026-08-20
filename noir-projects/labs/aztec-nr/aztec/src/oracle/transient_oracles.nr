/// Oracles for transient arrays: in-memory arrays scoped to a single top-level private or utility function call and
/// isolated per contract.
///
/// These mirror the ephemeral array oracles but route to a store whose lifetime is the whole top-level PXE call,
/// shared across all call frames of the same contract (private and utility alike). The contract address used for
/// keying is injected by the oracle handler, not passed here.
use crate::macros::oracle_declaration::utl_oracle;

/// Appends a serialized element to the transient array and returns the new length.
#[utl_oracle]
pub(crate) unconstrained fn push_transient<let N: u32>(slot: Field, values: [Field; N]) -> u32 {
    push_transient_oracle(slot, values)
}

/// Removes and returns the last serialized element from the transient array. Panics if the array is empty.
#[utl_oracle]
pub(crate) unconstrained fn pop_transient<let N: u32>(slot: Field) -> [Field; N] {
    pop_transient_oracle(slot)
}

/// Returns the serialized element at the given index. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn get_transient<let N: u32>(slot: Field, index: u32) -> [Field; N] {
    get_transient_oracle(slot, index)
}

/// Overwrites the serialized element at the given index. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn set_transient<let N: u32>(slot: Field, index: u32, values: [Field; N]) {
    set_transient_oracle(slot, index, values)
}

/// Returns the number of elements in the transient array.
#[utl_oracle]
pub(crate) unconstrained fn get_transient_len(slot: Field) -> u32 {
    get_transient_len_oracle(slot)
}

/// Removes the element at the given index, shifting subsequent elements backward. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn remove_transient(slot: Field, index: u32) {
    remove_transient_oracle(slot, index)
}

/// Removes all elements from the transient array.
#[utl_oracle]
pub(crate) unconstrained fn clear_transient(slot: Field) {
    clear_transient_oracle(slot)
}
