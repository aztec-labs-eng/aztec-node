use crate::ephemeral::EphemeralArray;
use crate::messages::processing::{
    event_validation_request::EventValidationRequest, log_retrieval_request::LogRetrievalRequest,
    log_retrieval_response::LogRetrievalResponse, NoteValidationRequest, pending_tagged_log::PendingTaggedLog,
    provided_secret::ProvidedSecret,
};
use crate::oracle::block_reference::BlockReference;
use crate::protocol::address::AztecAddress;
use crate::protocol::blob_data::TxEffect;
use crate::protocol::traits::{Deserialize, Serialize};

/// Finds new private logs that may have been sent to `scope` in the current contract.
///
/// PXE searches for logs tagged with the secrets it manages for `scope` and with `provided_secrets`, which are secrets
/// it cannot derive itself, such as those of the handshakes
/// [`get_handshake_secrets`](crate::messages::delivery::handshake::get_handshake_secrets) discovers onchain.
pub(crate) unconstrained fn get_pending_tagged_logs(
    scope: AztecAddress,
    provided_secrets: EphemeralArray<ProvidedSecret>,
) -> EphemeralArray<PendingTaggedLog> {
    get_pending_tagged_logs_oracle(scope, provided_secrets)
}

#[oracle(aztec_utl_getPendingTaggedLogsV2)]
unconstrained fn get_pending_tagged_logs_oracle(
    scope: AztecAddress,
    provided_secrets: EphemeralArray<ProvidedSecret>,
) -> EphemeralArray<PendingTaggedLog> {}

/// Validates note/event requests stored in ephemeral arrays.
pub(crate) unconstrained fn validate_and_store_enqueued_notes_and_events(
    note_validation_requests: EphemeralArray<NoteValidationRequest>,
    event_validation_requests: EphemeralArray<EventValidationRequest>,
    scope: AztecAddress,
) {
    validate_and_store_enqueued_notes_and_events_oracle(note_validation_requests, event_validation_requests, scope);
}

#[oracle(aztec_utl_validateAndStoreEnqueuedNotesAndEvents)]
unconstrained fn validate_and_store_enqueued_notes_and_events_oracle(
    note_validation_requests: EphemeralArray<NoteValidationRequest>,
    event_validation_requests: EphemeralArray<EventValidationRequest>,
    scope: AztecAddress,
) {}

/// Fetches all logs matching each request's tag and returns a nested ephemeral array.
///
/// Each element in the outer array is an inner `EphemeralArray<LogRetrievalResponse>` containing all matching logs for
/// the request at the same index (which may be empty if no logs were found).
pub unconstrained fn get_logs_by_tag(
    requests: EphemeralArray<LogRetrievalRequest>,
) -> EphemeralArray<EphemeralArray<LogRetrievalResponse>> {
    get_logs_by_tag_oracle(requests)
}

#[oracle(aztec_utl_getLogsByTagV2)]
unconstrained fn get_logs_by_tag_oracle(
    requests: EphemeralArray<LogRetrievalRequest>,
) -> EphemeralArray<EphemeralArray<LogRetrievalResponse>> {}

/// Fetches all effects of a settled transaction by its hash.
pub unconstrained fn get_tx_effect(tx_hash: Field) -> Option<TxEffect> {
    get_tx_effect_oracle(tx_hash)
}

#[oracle(aztec_utl_getTxEffect)]
unconstrained fn get_tx_effect_oracle(tx_hash: Field) -> Option<TxEffect> {}

/// Fetches all effects of settled transactions by hash, preserving request order.
pub unconstrained fn get_tx_effects(tx_hashes: EphemeralArray<Field>) -> EphemeralArray<Option<TxEffect>> {
    get_tx_effects_oracle(tx_hashes)
}

#[oracle(aztec_utl_getTxEffects)]
unconstrained fn get_tx_effects_oracle(tx_hashes: EphemeralArray<Field>) -> EphemeralArray<Option<TxEffect>> {}

/// A settled transaction's effects together with the block it was included in.
#[derive(Deserialize, Eq, Serialize)]
pub struct TxEffectWithBlock {
    pub effect: TxEffect,
    pub block: BlockReference,
}

/// Like [`get_tx_effects`], but pairs each effect with its block.
pub unconstrained fn get_tx_effects_with_block(
    tx_hashes: EphemeralArray<Field>,
) -> EphemeralArray<Option<TxEffectWithBlock>> {
    get_tx_effects_with_block_oracle(tx_hashes)
}

#[oracle(aztec_utl_getTxEffectsWithBlock)]
unconstrained fn get_tx_effects_with_block_oracle(
    tx_hashes: EphemeralArray<Field>,
) -> EphemeralArray<Option<TxEffectWithBlock>> {}
