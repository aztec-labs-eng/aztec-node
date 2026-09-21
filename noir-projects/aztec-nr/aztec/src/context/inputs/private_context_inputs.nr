use crate::protocol::{
    abis::{block_header::BlockHeader, call_context::CallContext, transaction::tx_context::TxContext},
    traits::Empty,
};

// PrivateContextInputs are expected to be provided to each private function
// docs:start:private-context-inputs
#[derive(Eq)]
pub struct PrivateContextInputs {
    pub call_context: CallContext,
    pub anchor_block_header: BlockHeader,
    pub tx_context: TxContext,
    pub start_side_effect_counter: u32,
    // The transaction's siloed protocol nullifier: kernel-checked, identical on every private call of the
    // transaction, and exactly the value inserted at index 0 of the transaction's nullifiers. Set by the PXE.
    pub protocol_nullifier: Field,
}
// docs:end:private-context-inputs

impl Empty for PrivateContextInputs {
    fn empty() -> Self {
        PrivateContextInputs {
            call_context: CallContext::empty(),
            anchor_block_header: BlockHeader::empty(),
            tx_context: TxContext::empty(),
            start_side_effect_counter: 0 as u32,
            protocol_nullifier: 0,
        }
    }
}
