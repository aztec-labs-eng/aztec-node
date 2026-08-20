use crate::ephemeral::EphemeralArray;
use crate::macros::{oracle_declaration::utl_oracle, oracle_testing::skip_oracle_test};
use crate::messages::processing::{
    event_validation_request::EventValidationRequest, log_retrieval_request::LogRetrievalRequest,
    log_retrieval_response::LogRetrievalResponse, NoteValidationRequest, pending_tagged_log::PendingTaggedLog,
    provided_secret::ProvidedSecret,
};
use crate::protocol::address::AztecAddress;
use crate::protocol::blob_data::TxEffect;

/// Finds new private logs that may have been sent to all registered accounts in PXE in the current contract and
/// returns them in an ephemeral array with an oracle-allocated base slot.
///
/// # Arguments
///
/// * `scope` - The account scope to search under.
/// * `provided_secrets` - Tagging secrets the app supplies explicitly, searched alongside the secrets PXE manages
///   internally. Used for secrets PXE cannot derive itself (e.g. handshake-derived ones).
pub(crate) unconstrained fn get_pending_tagged_logs(
    scope: AztecAddress,
    provided_secrets: EphemeralArray<ProvidedSecret>,
) -> EphemeralArray<PendingTaggedLog> {
    get_pending_tagged_logs_v2(scope, provided_secrets)
}

// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
unconstrained fn get_pending_tagged_logs_v2(
    scope: AztecAddress,
    provided_secrets: EphemeralArray<ProvidedSecret>,
) -> EphemeralArray<PendingTaggedLog> {
    get_pending_tagged_logs_v2_oracle(scope, provided_secrets)
}

/// Validates note/event requests stored in ephemeral arrays.
// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub(crate) unconstrained fn validate_and_store_enqueued_notes_and_events(
    note_validation_requests: EphemeralArray<NoteValidationRequest>,
    event_validation_requests: EphemeralArray<EventValidationRequest>,
    scope: AztecAddress,
) {
    validate_and_store_enqueued_notes_and_events_oracle(note_validation_requests, event_validation_requests, scope);
}

/// Fetches all logs matching each request's tag and returns a nested ephemeral array.
///
/// Each element in the outer array is an inner `EphemeralArray<LogRetrievalResponse>` containing all matching logs for
/// the request at the same index (which may be empty if no logs were found).
pub unconstrained fn get_logs_by_tag(
    requests: EphemeralArray<LogRetrievalRequest>,
) -> EphemeralArray<EphemeralArray<LogRetrievalResponse>> {
    get_logs_by_tag_v2(requests)
}

// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
unconstrained fn get_logs_by_tag_v2(
    requests: EphemeralArray<LogRetrievalRequest>,
) -> EphemeralArray<EphemeralArray<LogRetrievalResponse>> {
    get_logs_by_tag_v2_oracle(requests)
}

/// Fetches all effects of a settled transaction by its hash.
#[utl_oracle]
pub unconstrained fn get_tx_effect(tx_hash: Field) -> Option<TxEffect> {
    get_tx_effect_oracle(tx_hash)
}

/// Fetches all effects of settled transactions by hash, preserving request order.
// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub unconstrained fn get_tx_effects(tx_hashes: EphemeralArray<Field>) -> EphemeralArray<Option<TxEffect>> {
    get_tx_effects_oracle(tx_hashes)
}
