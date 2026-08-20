use crate::context::UtilityContext;
use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::{abis::block_header::BlockHeader, address::AztecAddress};

/// Wire shape of [`get_utility_context_internal`]'s response. [`UtilityContext`] is built from it rather than
/// returned directly so its fields stay private to its module.
#[derive(Eq)]
pub(crate) struct UtilityContextData {
    pub(crate) block_header: BlockHeader,
    pub(crate) contract_address: AztecAddress,
    pub(crate) msg_sender: AztecAddress,
}

#[utl_oracle]
unconstrained fn get_utility_context_internal() -> UtilityContextData {
    get_utility_context_internal_oracle()
}

/// Returns a utility context built from the global variables of anchor block and the contract address of the function
/// being executed.
pub unconstrained fn get_utility_context() -> UtilityContext {
    UtilityContext::from(get_utility_context_internal())
}
