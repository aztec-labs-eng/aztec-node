use crate::macros::oracle_declaration::prv_oracle;
use crate::protocol::address::AztecAddress;

/// The below only exists to broadcast the raw log, so we can provide it to the base rollup later to be constrained.
#[prv_oracle]
pub unconstrained fn notify_created_contract_class_log<let N: u32>(
    contract_address: AztecAddress,
    message: [Field; N],
    length: u32,
    counter: u32,
) {
    notify_created_contract_class_log_oracle(contract_address, message, length, counter)
}
