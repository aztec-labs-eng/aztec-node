use crate::ephemeral::EphemeralArray;
use crate::macros::{oracle_declaration::utl_oracle, oracle_testing::skip_oracle_test};
use crate::protocol::{constants::MAX_NOTE_HASHES_PER_TX, traits::{Deserialize, Serialize}};

/// The resolved on-chain context of a transaction.
#[derive(Serialize, Deserialize, Eq)]
pub struct ResolvedTx {
    pub tx_hash: Field,
    pub unique_note_hashes_in_tx: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    pub first_nullifier_in_tx: Field,
    pub block_number: u32,
    pub block_hash: Field,
}

/// Resolves the on-chain context of each tx hash.
// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub(crate) unconstrained fn get_resolved_txs(requests: EphemeralArray<Field>) -> EphemeralArray<Option<ResolvedTx>> {
    get_resolved_txs_oracle(requests)
}
