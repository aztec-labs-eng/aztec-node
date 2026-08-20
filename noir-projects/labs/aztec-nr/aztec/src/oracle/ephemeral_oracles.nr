/// Oracles for ephemeral arrays: in-memory arrays scoped to a single contract call frame.
///
/// Unlike capsule oracles, ephemeral oracles operate on arrays (not individual slots) and each oracle call performs a
/// complete logical operation. This reduces the number of oracle round-trips compared to building array semantics on
/// top of slot-level oracles.
use crate::macros::oracle_declaration::utl_oracle;

/// Appends a serialized element to the ephemeral array and returns the new length.
#[utl_oracle]
pub(crate) unconstrained fn push_ephemeral<let N: u32>(slot: Field, values: [Field; N]) -> u32 {
    push_ephemeral_oracle(slot, values)
}

/// Removes and returns the last serialized element from the ephemeral array. Panics if the array is empty.
#[utl_oracle]
pub(crate) unconstrained fn pop_ephemeral<let N: u32>(slot: Field) -> [Field; N] {
    pop_ephemeral_oracle(slot)
}

/// Returns the serialized element at the given index. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn get_ephemeral<let N: u32>(slot: Field, index: u32) -> [Field; N] {
    get_ephemeral_oracle(slot, index)
}

/// Overwrites the serialized element at the given index. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn set_ephemeral<let N: u32>(slot: Field, index: u32, values: [Field; N]) {
    set_ephemeral_oracle(slot, index, values)
}

/// Returns the number of elements in the ephemeral array.
#[utl_oracle]
pub(crate) unconstrained fn get_ephemeral_len(slot: Field) -> u32 {
    get_ephemeral_len_oracle(slot)
}

/// Removes the element at the given index, shifting subsequent elements backward. Panics if `index` is out of bounds.
#[utl_oracle]
pub(crate) unconstrained fn remove_ephemeral(slot: Field, index: u32) {
    remove_ephemeral_oracle(slot, index)
}

/// Removes all elements from the ephemeral array.
#[utl_oracle]
pub(crate) unconstrained fn clear_ephemeral(slot: Field) {
    clear_ephemeral_oracle(slot)
}
