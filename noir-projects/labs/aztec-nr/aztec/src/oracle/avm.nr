//! AVM oracles.
//!
//! There are only available during public execution. Calling any of them from a private or utility function will
//! result in runtime errors.

use crate::macros::{oracle_declaration::avm_oracle, oracle_testing::skip_oracle_test};
use crate::protocol::address::{AztecAddress, EthAddress};

#[avm_oracle]
pub unconstrained fn address() -> AztecAddress {
    address_oracle()
}

#[avm_oracle]
pub unconstrained fn sender() -> AztecAddress {
    sender_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn transaction_fee() -> Field {
    transaction_fee_oracle()
}

#[avm_oracle]
pub unconstrained fn chain_id() -> Field {
    chain_id_oracle()
}

#[avm_oracle]
pub unconstrained fn version() -> Field {
    version_oracle()
}

#[avm_oracle]
pub unconstrained fn block_number() -> u32 {
    block_number_oracle()
}

#[avm_oracle]
pub unconstrained fn timestamp() -> u64 {
    timestamp_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn min_fee_per_l2_gas() -> u128 {
    min_fee_per_l2_gas_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn min_fee_per_da_gas() -> u128 {
    min_fee_per_da_gas_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn l2_gas_left() -> u32 {
    l2_gas_left_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn da_gas_left() -> u32 {
    da_gas_left_oracle()
}

#[avm_oracle]
pub unconstrained fn is_static_call() -> bool {
    is_static_call_oracle()
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn note_hash_exists(note_hash: Field, leaf_index: u64) -> bool {
    note_hash_exists_oracle(note_hash, leaf_index)
}

#[avm_oracle]
pub unconstrained fn emit_note_hash(note_hash: Field) {
    emit_note_hash_oracle(note_hash)
}

#[avm_oracle]
pub unconstrained fn nullifier_exists(siloed_nullifier: Field) -> bool {
    nullifier_exists_oracle(siloed_nullifier)
}

#[avm_oracle]
pub unconstrained fn emit_nullifier(nullifier: Field) {
    emit_nullifier_oracle(nullifier)
}

#[avm_oracle]
pub unconstrained fn emit_public_log(message: [Field]) {
    emit_public_log_oracle(message)
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn l1_to_l2_msg_exists(msg_hash: Field, msg_leaf_index: u64) -> bool {
    l1_to_l2_msg_exists_oracle(msg_hash, msg_leaf_index)
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn send_l2_to_l1_msg(recipient: EthAddress, content: Field) {
    send_l2_to_l1_msg_oracle(recipient, content)
}

pub unconstrained fn call<let N: u32>(
    l2_gas_allocation: u32,
    da_gas_allocation: u32,
    address: AztecAddress,
    args: [Field; N],
) {
    call_internal(l2_gas_allocation, da_gas_allocation, address, N, args)
}

// While the length parameter might seem unnecessary given that we have N we keep it around because at the AVM bytecode
// level, we want to support non-comptime-known lengths for such opcodes, even if Noir code will not generally take
// that route.
#[avm_oracle]
unconstrained fn call_internal<let N: u32>(
    l2_gas_allocation: u32,
    da_gas_allocation: u32,
    address: AztecAddress,
    length: u32,
    args: [Field; N],
) {
    call_internal_oracle(l2_gas_allocation, da_gas_allocation, address, length, args)
}

pub unconstrained fn call_static<let N: u32>(
    l2_gas_allocation: u32,
    da_gas_allocation: u32,
    address: AztecAddress,
    args: [Field; N],
) {
    static_call_internal(l2_gas_allocation, da_gas_allocation, address, N, args)
}

// While the length parameter might seem unnecessary given that we have N we keep it around because at the AVM bytecode
// level, we want to support non-comptime-known lengths for such opcodes, even if Noir code will not generally take
// that route.
#[avm_oracle]
unconstrained fn static_call_internal<let N: u32>(
    l2_gas_allocation: u32,
    da_gas_allocation: u32,
    address: AztecAddress,
    length: u32,
    args: [Field; N],
) {
    static_call_internal_oracle(l2_gas_allocation, da_gas_allocation, address, length, args)
}

// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn calldata_copy<let N: u32>(cdoffset: u32, copy_size: u32) -> [Field; N] {
    calldata_copy_oracle(cdoffset, copy_size)
}

/// `success_copy` is placed immediately after the CALL opcode to get the success value
#[avm_oracle]
pub unconstrained fn success_copy() -> bool {
    success_copy_oracle()
}

#[avm_oracle]
pub unconstrained fn returndata_size() -> u32 {
    returndata_size_oracle()
}

#[avm_oracle]
pub unconstrained fn returndata_copy(rdoffset: u32, copy_size: u32) -> [Field] {
    returndata_copy_oracle(rdoffset, copy_size)
}

/// The trailing underscore avoids clashing with the `return` Noir keyword; the wire name derivation strips it.
// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn return_(returndata: [Field]) {
    return__oracle(returndata)
}

/// This opcode reverts using the exact data given. In general it should only be used to do rethrows, where the revert
/// data is the same as the original revert data. For normal reverts, use Noir's `assert` which, on top of reverting,
/// will also add an error selector to the revert data.
// Not implemented by TXE/PXE, so we don't test it.
#[skip_oracle_test]
#[avm_oracle]
pub unconstrained fn revert(revertdata: [Field]) {
    revert_oracle(revertdata)
}

#[avm_oracle]
pub unconstrained fn storage_read(storage_slot: Field, contract_address: Field) -> Field {
    storage_read_oracle(storage_slot, contract_address)
}

#[avm_oracle]
pub unconstrained fn storage_write(storage_slot: Field, value: Field) {
    storage_write_oracle(storage_slot, value);
}
