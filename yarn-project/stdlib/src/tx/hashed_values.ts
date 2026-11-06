import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader, BufferSink, serializeToSink } from '@aztec-labs/foundation/serialize';
import type { FieldsOf } from '@aztec-labs/foundation/types';
import { z } from 'zod';

import { MAX_FUNCTION_ARGS_LEN } from '../abi/function_call.js';
import { computeCalldataHash, computeVarArgsHash } from '../hash/index.js';
import { type ZodFor, schemas } from '../schemas/schemas.js';
import { Vector } from '../types/index.js';

/**
 * Bound for the hashed argument preimages a single tx request carries, one per call or authwit it hashes arguments for.
 * The protocol sets none; real requests carry a handful.
 */
export const MAX_HASHED_ARGS_PER_TX = 1024;

/**
 * A container for storing a list of values and their hash.
 */
export class HashedValues {
  constructor(
    /**
     *  Raw values.
     */
    public readonly values: Fr[],
    /**
     * The hash of the raw values
     */
    public readonly hash: Fr,
  ) {}

  getSize() {
    return this.values.length + 1 /* hash */;
  }

  /** Schema that accepts up to {@link MAX_FUNCTION_ARGS_LEN} values, the bound for any function's arguments. */
  static get schema(): ZodFor<HashedValues> {
    return HashedValues.schemaFor(MAX_FUNCTION_ARGS_LEN);
  }

  /**
   * Returns a schema that rejects more than `maxValues` values, for callers whose values have a tighter limit than
   * `schema` applies, such as public calldata.
   */
  static schemaFor(maxValues: number): ZodFor<HashedValues> {
    return z.object({ values: z.array(schemas.Fr).max(maxValues), hash: schemas.Fr }).transform(HashedValues.from);
  }

  static from(fields: FieldsOf<HashedValues>): HashedValues {
    return new HashedValues(...HashedValues.getFields(fields));
  }

  static getFields(fields: FieldsOf<HashedValues>) {
    return [fields.values, fields.hash] as const;
  }

  static random() {
    return new HashedValues([Fr.random(), Fr.random()], Fr.random());
  }

  toBuffer(): Buffer;
  toBuffer(sink: BufferSink): void;
  toBuffer(sink?: BufferSink): Buffer | void {
    if (!sink) {
      return BufferSink.serialize(this);
    }
    serializeToSink(sink, new Vector(this.values), this.hash);
  }

  static fromBuffer(buffer: Buffer | BufferReader): HashedValues {
    const reader = BufferReader.asReader(buffer);
    return new HashedValues(reader.readVector(Fr), Fr.fromBuffer(reader));
  }

  // Computes the hash of input arguments or return values for private functions, or for authwit creation.
  static async fromArgs(args: Fr[]) {
    return new HashedValues(args, await computeVarArgsHash(args));
  }

  // Computes the hash of calldata for public functions.
  static async fromCalldata(calldata: Fr[]) {
    return new HashedValues(calldata, await computeCalldataHash(calldata));
  }
}
