use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::{
    abis::block_header::BlockHeader,
    constants::PUBLIC_DATA_TREE_HEIGHT,
    data::PublicDataTreeLeafPreimage,
    traits::{Deserialize, Hash, Serialize},
};

#[derive(Deserialize, Eq, Serialize)]
pub struct PublicDataWitness {
    pub index: Field,
    pub leaf_preimage: PublicDataTreeLeafPreimage,
    pub path: [Field; PUBLIC_DATA_TREE_HEIGHT],
}

#[utl_oracle]
unconstrained fn get_public_data_witness_internal(
    block_hash: Field,
    public_data_tree_index: Field,
) -> PublicDataWitness {
    get_public_data_witness_internal_oracle(block_hash, public_data_tree_index)
}

pub unconstrained fn get_public_data_witness(
    block_header: BlockHeader,
    public_data_tree_index: Field,
) -> PublicDataWitness {
    let block_hash = block_header.hash();
    get_public_data_witness_internal(block_hash, public_data_tree_index)
}
