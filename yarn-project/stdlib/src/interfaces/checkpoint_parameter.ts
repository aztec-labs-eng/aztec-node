import type { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { CheckpointNumberSchema, SlotNumberSchema } from '@aztec-labs/foundation/branded-types';
import { selectorSchema } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import { CHECKPOINT_QUERY_KEYS } from '../block/l2_block_source.js';
import { CheckpointTagSchema } from './chain_tips.js';

/**
 * Selector for a checkpoint in RPC calls.
 *
 * Accepts a numeric checkpoint number (or `{ number }`), a slot number (`{ slot }`),
 * or a checkpoint-tip name (e.g. `'checkpointed'`, `'proven'`, `'finalized'`).
 */
export const CheckpointParameterSchema = z.union([
  selectorSchema<{ number: CheckpointNumber } | { slot: SlotNumber }>(
    [z.object({ number: CheckpointNumberSchema }), z.object({ slot: SlotNumberSchema })],
    CHECKPOINT_QUERY_KEYS,
  ),
  CheckpointTagSchema,
  CheckpointNumberSchema,
]);

export type CheckpointParameter = z.infer<typeof CheckpointParameterSchema>;
