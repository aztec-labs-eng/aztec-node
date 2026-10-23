mod test;

use aztec::macros::aztec;

/// A contract used to exercise the tx effect oracles end-to-end.
#[aztec]
pub contract TxEffectOracleTest {
    use aztec::{
        ephemeral::EphemeralArray,
        macros::functions::external,
        oracle::{
            block_reference::BlockReference,
            message_processing::{get_tx_effect, get_tx_effects, get_tx_effects_with_block},
        },
        protocol::{hash::poseidon2_hash, traits::Serialize},
    };

    /// Poseidon hash of a single tx's effect, fetched via the singular oracle.
    #[external("utility")]
    unconstrained fn get_tx_effect_hash(tx_hash: Field) -> Field {
        poseidon2_hash(get_tx_effect(tx_hash).unwrap().serialize())
    }

    /// Poseidon hash of each requested tx's effect, in request order, fetched via the batch oracle.
    #[external("utility")]
    unconstrained fn get_tx_effect_hashes(tx_hashes: [Field; 2]) -> [Field; 2] {
        let tx_effects = get_tx_effects(EphemeralArray::from_array(tx_hashes));
        [poseidon2_hash(tx_effects.get(0).unwrap().serialize()), poseidon2_hash(tx_effects.get(1).unwrap().serialize())]
    }

    /// Like `get_tx_effect_hashes`, but via the batch-with-block oracle.
    #[external("utility")]
    unconstrained fn get_tx_effect_with_block_hashes(tx_hashes: [Field; 2]) -> [Field; 2] {
        let tx_effects = get_tx_effects_with_block(EphemeralArray::from_array(tx_hashes));
        [
            poseidon2_hash(tx_effects.get(0).unwrap().effect.serialize()),
            poseidon2_hash(tx_effects.get(1).unwrap().effect.serialize()),
        ]
    }

    /// The block each requested tx was included in, in request order.
    #[external("utility")]
    unconstrained fn get_tx_effect_blocks(tx_hashes: [Field; 2]) -> [BlockReference; 2] {
        let tx_effects = get_tx_effects_with_block(EphemeralArray::from_array(tx_hashes));
        [tx_effects.get(0).unwrap().block, tx_effects.get(1).unwrap().block]
    }

    #[external("utility")]
    unconstrained fn assert_is_none(tx_hash: Field) {
        assert(get_tx_effect(tx_hash).is_none(), "expected get_tx_effect to return None");
    }
}
