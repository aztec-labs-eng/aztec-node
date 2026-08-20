use crate::macros::oracle_declaration::prv_oracle;
use crate::protocol::{abis::function_selector::FunctionSelector, address::AztecAddress};

#[prv_oracle]
pub unconstrained fn call_private_function_internal(
    contract_address: AztecAddress,
    function_selector: FunctionSelector,
    args_hash: Field,
    start_side_effect_counter: u32,
    is_static_call: bool,
) -> (u32, Field) {
    call_private_function_internal_oracle(
        contract_address,
        function_selector,
        args_hash,
        start_side_effect_counter,
        is_static_call,
    )
}
