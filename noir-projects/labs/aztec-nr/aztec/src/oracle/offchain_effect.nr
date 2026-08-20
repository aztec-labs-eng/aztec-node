use crate::macros::oracle_declaration::utl_oracle;
use crate::protocol::traits::Serialize;

/// Emits data that will be delivered to PXE unaltered. This data can be interpreted freely by a downstream consumer
/// (such as a wallet).
///
/// # Arguments
///
/// * `data` - The data to emit.
pub unconstrained fn emit_offchain_effect<T>(data: T)
where
    T: Serialize,
{
    emit_offchain_effect_internal(data.serialize());
}

#[utl_oracle]
unconstrained fn emit_offchain_effect_internal<let N: u32>(data: [Field; N]) {
    emit_offchain_effect_internal_oracle(data)
}
