import type { SimulationOverridesPlan } from '@aztec-labs/ethereum/contracts';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { SlotNumber } from '@aztec-labs/foundation/schemas';

import type { AztecAddress } from '../aztec-address/index.js';
import type { CheckpointGlobalVariables } from './global_variables.js';

/**
 * Interface for building global variables for Aztec blocks.
 */
export interface GlobalVariableBuilder {
  /**
   * Builds global variables that are constant throughout a checkpoint.
   * @param options - Optional L1 block to pin the fee read to, so the fee describes the same L1 state the caller
   * planned the block from. A block hash takes precedence over a number, and also pins the overrides plan's reads.
   */
  buildCheckpointGlobalVariables(
    coinbase: EthAddress,
    feeRecipient: AztecAddress,
    slotNumber: SlotNumber,
    simulationOverridesPlan?: SimulationOverridesPlan,
    options?: { blockNumber?: bigint; blockHash?: `0x${string}` },
  ): Promise<CheckpointGlobalVariables>;
}
