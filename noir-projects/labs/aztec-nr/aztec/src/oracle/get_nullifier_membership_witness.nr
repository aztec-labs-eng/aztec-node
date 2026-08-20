use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::{
    abis::{block_header::BlockHeader, nullifier_leaf_preimage::NullifierLeafPreimage},
    constants::NULLIFIER_TREE_HEIGHT,
    merkle_tree::MembershipWitness,
    traits::Hash,
};

#[utl_oracle]
unconstrained fn get_low_nullifier_membership_witness_internal(
    block_hash: Field,
    nullifier: Field,
) -> (NullifierLeafPreimage, MembershipWitness<NULLIFIER_TREE_HEIGHT>) {
    get_low_nullifier_membership_witness_internal_oracle(block_hash, nullifier)
}

/// Returns a leaf preimage and membership witness for the low nullifier of `nullifier` in the nullifier tree whose
/// root is defined in `block_header`.
///
/// The low nullifier is the leaf with the largest value that is still smaller than `nullifier`. This is used to prove
/// non-inclusion: if the low nullifier's `next_value` is greater than `nullifier`, then `nullifier` is not in the
/// tree.
pub unconstrained fn get_low_nullifier_membership_witness(
    block_header: BlockHeader,
    nullifier: Field,
) -> (NullifierLeafPreimage, MembershipWitness<NULLIFIER_TREE_HEIGHT>) {
    let block_hash = block_header.hash();
    get_low_nullifier_membership_witness_internal(block_hash, nullifier)
}

#[utl_oracle]
unconstrained fn get_nullifier_membership_witness_internal(
    block_hash: Field,
    nullifier: Field,
) -> (NullifierLeafPreimage, MembershipWitness<NULLIFIER_TREE_HEIGHT>) {
    get_nullifier_membership_witness_internal_oracle(block_hash, nullifier)
}

/// Returns a leaf preimage and membership witness for `nullifier` in the nullifier tree whose root is defined in
/// `block_header`.
///
/// This is used to prove that a nullifier exists in the tree (inclusion proof).
pub unconstrained fn get_nullifier_membership_witness(
    block_header: BlockHeader,
    nullifier: Field,
) -> (NullifierLeafPreimage, MembershipWitness<NULLIFIER_TREE_HEIGHT>) {
    let block_hash = block_header.hash();
    get_nullifier_membership_witness_internal(block_hash, nullifier)
}
