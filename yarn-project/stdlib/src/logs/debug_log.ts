import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type LogLevel, LogLevels } from '@aztec-labs/foundation/log';
import { type ZodFor, schemas } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';

// Excessive memory reads due to debug logging can open a DOS vector to nodes that perform public tx simulation for users.
// This default limit (4MB) can be configured further by node runners via the `RPC_SIMULATE_PUBLIC_MAX_DEBUG_LOG_MEMORY_READS` environment variable.
// It also bounds the fields a client accepts in a single debug log.
export const DEFAULT_MAX_DEBUG_LOG_MEMORY_READS = 125000;

/*
 * Represents a debug log emitted by public bytecode.
 */
export class DebugLog {
  constructor(
    public contractAddress: AztecAddress,
    public level: LogLevel,
    public message: string,
    public fields: Fr[],
  ) {}

  static get schema(): ZodFor<DebugLog> {
    return z
      .object({
        contractAddress: AztecAddress.schema,
        level: z.enum(LogLevels),
        message: z.string(),
        fields: z.array(schemas.Fr).max(DEFAULT_MAX_DEBUG_LOG_MEMORY_READS),
      })
      .transform(
        ({ contractAddress, level, message, fields }) => new DebugLog(contractAddress, level, message, fields),
      );
  }

  /**
   * Creates a DebugLog from a plain object without Zod validation.
   * This method is optimized for performance and skips validation, making it suitable
   * for deserializing trusted data (e.g., from C++ via MessagePack).
   * @param obj - Plain object containing DebugLog fields
   * @returns A DebugLog instance
   */
  static fromPlainObject(obj: any): DebugLog {
    if (obj instanceof DebugLog) {
      return obj;
    }
    return new DebugLog(
      AztecAddress.fromPlainObject(obj.contractAddress),
      obj.level,
      obj.message,
      obj.fields.map((f: any) => Fr.fromPlainObject(f)),
    );
  }
}
