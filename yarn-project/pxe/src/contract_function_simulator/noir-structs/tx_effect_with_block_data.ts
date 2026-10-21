import type { BlockReference } from '../../storage/fact_store/index.js';
import type { TxEffectData } from './tx_effect_data.js';

/**
 * Wire form of a settled transaction's effects paired with the block it was included in, as each present element of
 * the `getTxEffectsWithBlock` oracle's return.
 */
export type TxEffectWithBlockData = {
  effect: TxEffectData;
  block: BlockReference;
};
