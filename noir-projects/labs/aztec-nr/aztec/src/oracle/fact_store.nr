//! Oracle declarations for the fact store.

use crate::ephemeral::EphemeralArray;
use crate::facts::{FactCollection, OriginBlock};
use crate::macros::{oracle_declaration::utl_oracle, oracle_testing::skip_oracle_test};
use crate::protocol::address::AztecAddress;

// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub(crate) unconstrained fn record_fact(
    contract_address: AztecAddress,
    scope: AztecAddress,
    fact_collection_type_id: Field,
    fact_collection_id: Field,
    fact_type_id: Field,
    payload: EphemeralArray<Field>,
    origin_block: Option<OriginBlock>,
) {
    record_fact_oracle(
        contract_address,
        scope,
        fact_collection_type_id,
        fact_collection_id,
        fact_type_id,
        payload,
        origin_block,
    )
}

#[utl_oracle]
pub(crate) unconstrained fn delete_fact_collection(
    contract_address: AztecAddress,
    scope: AztecAddress,
    fact_collection_type_id: Field,
    fact_collection_id: Field,
) {
    delete_fact_collection_oracle(
        contract_address,
        scope,
        fact_collection_type_id,
        fact_collection_id,
    )
}

// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub(crate) unconstrained fn get_fact_collection(
    contract_address: AztecAddress,
    scope: AztecAddress,
    fact_collection_type_id: Field,
    fact_collection_id: Field,
) -> Option<FactCollection> {
    get_fact_collection_oracle(
        contract_address,
        scope,
        fact_collection_type_id,
        fact_collection_id,
    )
}

// TODO: cover with an oracle test once the test resolver can serve EphemeralArray contents.
#[skip_oracle_test]
#[utl_oracle]
pub(crate) unconstrained fn get_fact_collections_by_type(
    contract_address: AztecAddress,
    scope: AztecAddress,
    fact_collection_type_id: Field,
) -> EphemeralArray<FactCollection> {
    get_fact_collections_by_type_oracle(contract_address, scope, fact_collection_type_id)
}
