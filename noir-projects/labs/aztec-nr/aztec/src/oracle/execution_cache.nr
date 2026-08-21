use crate::macros::oracle_declaration::prv_oracle;

/// Stores values represented as slice in execution cache to be later obtained by its hash.
// TODO(F-498): review naming consistency
pub fn store<let N: u32>(values: [Field; N], hash: Field) {
    // Safety: This oracle call returns nothing: we only call it for its side effects. It is therefore always safe to
    // call. When loading the values, however, the caller must check that the values are indeed the preimage.
    unsafe { set_hash_preimage(values, hash) };
}

// Compiles to a brillig entry point (it is called from constrained code), and entry points embed their function
// name in artifact bytecode: renaming this function would change every artifact hash and class ID.
#[prv_oracle]
unconstrained fn set_hash_preimage<let N: u32>(values: [Field; N], hash: Field) {
    set_hash_preimage_oracle(values, hash);
}

// TODO(F-498): review naming consistency
pub unconstrained fn load<let N: u32>(hash: Field) -> [Field; N] {
    get_hash_preimage(hash)
}

#[prv_oracle]
unconstrained fn get_hash_preimage<let N: u32>(hash: Field) -> [Field; N] {
    get_hash_preimage_oracle(hash)
}
