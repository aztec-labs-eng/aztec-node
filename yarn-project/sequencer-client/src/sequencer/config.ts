import type { GovernanceProposerContract } from '@aztec-labs/ethereum/contracts';
import type { RollupContract } from '@aztec-labs/ethereum/contracts/rollup';

export { type SequencerConfig } from '@aztec-labs/stdlib/config';

export type SequencerContracts = {
  rollupContract: RollupContract;
  governanceProposerContract: GovernanceProposerContract;
};
