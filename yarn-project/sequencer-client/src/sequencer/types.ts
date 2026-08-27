import type { L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';

export type SequencerRollupConstants = Pick<
  L1RollupConstants,
  'ethereumSlotDuration' | 'l1GenesisTime' | 'slotDuration' | 'rollupManaLimit' | 'epochDuration'
>;
