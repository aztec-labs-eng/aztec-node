use crate::{
    context::inputs::PrivateContextInputs,
    event::EventSelector,
    macros::{oracle_declaration::txe_oracle, oracle_testing::skip_oracle_test},
    messages::encoding::MESSAGE_CIPHERTEXT_LEN,
    test::helpers::{tagging_secret_strategy::TaggingSecretStrategy, utils::TestAccount},
};

use crate::protocol::{
    abis::{function_selector::FunctionSelector, gas_settings::GasSettings},
    address::{AztecAddress, EthAddress},
    constants::{
        CONTRACT_INSTANCE_LENGTH, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX, MAX_PRIVATE_LOGS_PER_TX,
        PRIVATE_LOG_SIZE_IN_FIELDS,
    },
    contract_instance::ContractInstance,
    traits::{Deserialize, ToField},
};

/// The TXE oracle version constants are used to check that the oracle interface used for tests is in sync between
/// TXE and Aztec.nr. This is separate from the contract oracle version in
/// [`oracle::version`](crate::oracle::version), which covers oracles used during contract execution by PXE.
///
/// The TypeScript counterparts are in `yarn-project/txe/src/oracle/txe_oracle_version.ts`.
pub global TXE_ORACLE_VERSION_MAJOR: Field = 9;
pub global TXE_ORACLE_VERSION_MINOR: Field = 0;

/// Asserts that the TXE oracle interface version is compatible.
pub unconstrained fn assert_compatible_txe_oracle_version() {
    assert_compatible_txe_oracle_version_oracle_call(TXE_ORACLE_VERSION_MAJOR, TXE_ORACLE_VERSION_MINOR);
}

#[oracle(aztec_txe_assertCompatibleOracleVersion)]
unconstrained fn assert_compatible_txe_oracle_version_oracle_call(major: Field, minor: Field) {}

/// Transports the TXE oracle manifest (the `txe`/`avm` declarations, which are never embedded in contract
/// artifacts) for the TXE to validate against the oracles it serves. Called at `TestEnvironment` creation
/// with the canonical rendering of the manifest.
// The manifest transport is exercised at every `TestEnvironment` creation; its generic length has no
// synthesizer fixture, so we don't roundtrip-test it.
#[skip_oracle_test]
#[txe_oracle]
pub unconstrained fn assert_compatible_oracle_manifest<let N: u32>(manifest: str<N>) {
    assert_compatible_oracle_manifest_oracle(manifest)
}

/// Upper bound on the number of raw offchain effects the TXE test environment will surface
/// to Noir in a single `get_last_call_offchain_effects` query.
pub(crate) global MAX_OFFCHAIN_EFFECTS_PER_TXE_QUERY: u32 = 64;

/// Maximum number of fields in a single raw offchain effect payload.
pub(crate) global MAX_OFFCHAIN_EFFECT_LEN: u32 = 2 + MESSAGE_CIPHERTEXT_LEN;

global MAX_PRIVATE_EVENTS_PER_TXE_QUERY: u32 = 5;
global MAX_EVENT_SERIALIZATION_LENGTH: u32 = 10;

pub unconstrained fn deploy<let M: u32, let N: u32, let P: u32>(
    path: str<N>,
    initializer: str<P>,
    args: [Field; M],
    secret: Field,
    salt: Field,
    deployer: AztecAddress,
) -> ContractInstance {
    let instance_fields = deploy_internal(path, initializer, args, secret, salt, deployer);
    ContractInstance::deserialize(instance_fields)
}

// TODO: implement once we support more complex types
#[skip_oracle_test]
#[txe_oracle]
unconstrained fn deploy_internal<let N: u32, let P: u32>(
    path: str<N>,
    initializer: str<P>,
    args: [Field],
    secret: Field,
    salt: Field,
    deployer: AztecAddress,
) -> [Field; CONTRACT_INSTANCE_LENGTH] {
    deploy_internal_oracle(path, initializer, args, secret, salt, deployer)
}

#[txe_oracle]
pub unconstrained fn private_call_new_flow<let M: u32, let N: u32, let S: u32, let T: u32>(
    from: Option<AztecAddress>,
    contract_address: AztecAddress,
    function_selector: FunctionSelector,
    args: [Field; M],
    args_hash: Field,
    is_static_call: bool,
    additional_scopes: [AztecAddress; S],
    authorized_utility_call_targets: [AztecAddress; T],
    gas_settings: GasSettings,
) -> [Field; N] {
    private_call_new_flow_oracle(
        from,
        contract_address,
        function_selector,
        args,
        args_hash,
        is_static_call,
        additional_scopes,
        authorized_utility_call_targets,
        gas_settings,
    )
}

pub unconstrained fn public_call_new_flow<let M: u32, let N: u32>(
    from: Option<AztecAddress>,
    contract_address: AztecAddress,
    function_selector: FunctionSelector,
    args: [Field; M],
    is_static_call: bool,
    gas_settings: GasSettings,
) -> [Field; N] {
    let calldata = [function_selector.to_field()].concat(args);

    public_call_new_flow_internal(
        from,
        contract_address,
        calldata,
        is_static_call,
        gas_settings,
    )
}

#[txe_oracle]
unconstrained fn public_call_new_flow_internal<let M: u32, let N: u32>(
    from: Option<AztecAddress>,
    contract_address: AztecAddress,
    calldata: [Field; M],
    is_static_call: bool,
    gas_settings: GasSettings,
) -> [Field; N] {
    public_call_new_flow_internal_oracle(
        from,
        contract_address,
        calldata,
        is_static_call,
        gas_settings,
    )
}

#[txe_oracle]
pub unconstrained fn set_private_txe_context(
    contract_address: Option<AztecAddress>,
    anchor_block_number: Option<u32>,
    gas_settings: GasSettings,
) -> PrivateContextInputs {
    set_private_txe_context_oracle(contract_address, anchor_block_number, gas_settings)
}

#[txe_oracle]
pub unconstrained fn execute_utility_function<let M: u32, let N: u32, let T: u32>(
    from: Option<AztecAddress>,
    contract_address: AztecAddress,
    function_selector: FunctionSelector,
    args: [Field; M],
    authorized_utility_call_targets: [AztecAddress; T],
) -> [Field; N] {
    execute_utility_function_oracle(
        from,
        contract_address,
        function_selector,
        args,
        authorized_utility_call_targets,
    )
}

#[txe_oracle]
pub unconstrained fn get_next_block_number() -> u32 {
    get_next_block_number_oracle()
}

#[txe_oracle]
pub unconstrained fn get_next_block_timestamp() -> u64 {
    get_next_block_timestamp_oracle()
}

#[txe_oracle]
pub unconstrained fn get_last_block_timestamp() -> u64 {
    get_last_block_timestamp_oracle()
}

/// Note hashes emitted by a single transaction, as surfaced by [`get_last_tx_effects`].
pub type TxNoteHashes = BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>;

/// Nullifiers emitted by a single transaction, as surfaced by [`get_last_tx_effects`].
pub type TxNullifiers = BoundedVec<Field, MAX_NULLIFIERS_PER_TX>;

/// A single private log's `log_data` as surfaced by [`get_last_tx_effects`]: the first field is
/// the kernel-siloed tag and the remainder is the ciphertext payload.
pub type TxPrivateLog = BoundedVec<Field, PRIVATE_LOG_SIZE_IN_FIELDS>;

/// Private logs emitted by a single transaction, in emission order, as surfaced by
/// [`get_last_tx_effects`].
pub type TxPrivateLogs = BoundedVec<TxPrivateLog, MAX_PRIVATE_LOGS_PER_TX>;

/// The side effects of a single transaction, as surfaced by [`get_last_tx_effects`].
#[derive(Eq)]
pub struct TxEffects {
    pub tx_hash: Field,
    pub note_hashes: TxNoteHashes,
    pub nullifiers: TxNullifiers,
    pub private_logs: TxPrivateLogs,
}

/// Returns the effects of the last transaction included by the TXE.
#[txe_oracle]
pub unconstrained fn get_last_tx_effects() -> TxEffects {
    get_last_tx_effects_oracle()
}

/// Returns the raw offchain effect payloads emitted by the last top-level call into TXE.
/// Each effect is a variable-length field array (e.g. offchain messages have a different size
/// than authwit authorization requests).
#[txe_oracle]
pub unconstrained fn get_last_call_offchain_effects() -> BoundedVec<BoundedVec<Field, MAX_OFFCHAIN_EFFECT_LEN>, MAX_OFFCHAIN_EFFECTS_PER_TXE_QUERY> {
    get_last_call_offchain_effects_oracle()
}

/// The context of the last top-level call into TXE, as captured by the call executor. Refreshed on
/// every top-level call.
#[derive(Eq)]
pub struct TXECallContext {
    /// Tx hash of the top-level call, or `None` if the call was tx-less (`execute_utility`, context
    /// setters, etc.).
    pub tx_hash: Option<Field>,
    /// Anchor block timestamp captured at the *start* of the call. Note: this is not the timestamp
    /// of the block where a transaction produced by this call is included, which does not exist at
    /// the moment TXE runs the call.
    pub anchor_block_timestamp: u64,
}

/// Returns the context of the last top-level call into TXE. See [`TXECallContext`].
#[txe_oracle]
pub unconstrained fn get_last_call_context() -> TXECallContext {
    get_last_call_context_oracle()
}

#[txe_oracle]
pub unconstrained fn get_default_address() -> AztecAddress {
    get_default_address_oracle()
}

// experimental
#[txe_oracle]
pub(crate) unconstrained fn get_private_events(
    selector: EventSelector,
    contract_address: AztecAddress,
    scope: AztecAddress,
) -> BoundedVec<BoundedVec<Field, MAX_EVENT_SERIALIZATION_LENGTH>, MAX_PRIVATE_EVENTS_PER_TXE_QUERY> {
    get_private_events_oracle(selector, contract_address, scope)
}

#[txe_oracle]
pub unconstrained fn advance_blocks_by(blocks: u32) {
    advance_blocks_by_oracle(blocks)
}

#[txe_oracle]
pub unconstrained fn advance_timestamp_by(duration: u64) {
    advance_timestamp_by_oracle(duration)
}

#[txe_oracle]
pub unconstrained fn create_account(secret: Field, partial_address: Field) -> TestAccount {
    create_account_oracle(secret, partial_address)
}

#[txe_oracle]
pub unconstrained fn add_account(secret: Field) -> TestAccount {
    add_account_oracle(secret)
}

pub unconstrained fn add_authwit(address: AztecAddress, message_hash: Field) {
    add_auth_witness_internal(address, message_hash)
}

#[txe_oracle]
unconstrained fn add_auth_witness_internal(address: AztecAddress, message_hash: Field) {
    add_auth_witness_internal_oracle(address, message_hash)
}

#[txe_oracle]
pub unconstrained fn send_l1_to_l2_message(
    content: Field,
    secret_hash: Field,
    sender: EthAddress,
    recipient: AztecAddress,
) -> Field {
    send_l1_to_l2_message_oracle(content, secret_hash, sender, recipient)
}

// TODO: implement once we support more complex types
#[skip_oracle_test]
#[txe_oracle]
pub unconstrained fn set_tagging_secret_strategies(
    unconstrained_strategy: Option<TaggingSecretStrategy>,
    constrained_strategy: Option<TaggingSecretStrategy>,
) {
    set_tagging_secret_strategies_oracle(unconstrained_strategy, constrained_strategy)
}

#[txe_oracle]
pub unconstrained fn set_authorize_all_utility_call_targets(authorize_all: bool) {
    set_authorize_all_utility_call_targets_oracle(authorize_all)
}

#[txe_oracle]
pub unconstrained fn set_top_level_txe_context() {
    set_top_level_txe_context_oracle()
}

#[txe_oracle]
pub unconstrained fn set_public_txe_context(contract_address: Option<AztecAddress>) {
    set_public_txe_context_oracle(contract_address)
}

#[txe_oracle]
pub unconstrained fn set_utility_txe_context(contract_address: Option<AztecAddress>) {
    set_utility_txe_context_oracle(contract_address)
}
