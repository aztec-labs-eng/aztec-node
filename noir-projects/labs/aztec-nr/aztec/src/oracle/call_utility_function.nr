use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::{abis::function_selector::FunctionSelector, address::AztecAddress};

#[utl_oracle]
pub unconstrained fn call_utility_function<let M: u32, let N: u32>(
    contract_address: AztecAddress,
    function_selector: FunctionSelector,
    args: [Field; M],
) -> [Field; N] {
    call_utility_function_oracle(contract_address, function_selector, args)
}
