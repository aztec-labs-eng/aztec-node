use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::address::AztecAddress;

/// Forces the PXE to re-sync the given contract for a set of scopes on the next query.
///
/// Call this after writing data (e.g. offchain messages) that the contract's `sync_state` function needs to discover.
/// Without invalidation, the sync cache would skip re-running `sync_state` until the next block.
#[utl_oracle]
pub unconstrained fn set_contract_sync_cache_invalid<let N: u32>(
    contract_address: AztecAddress,
    scopes: BoundedVec<AztecAddress, N>,
) {
    set_contract_sync_cache_invalid_oracle(contract_address, scopes);
}
