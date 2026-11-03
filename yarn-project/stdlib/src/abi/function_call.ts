import { MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS } from '@aztec-labs/constants';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { FieldsOf } from '@aztec-labs/foundation/types';
import { z } from 'zod';

import { AztecAddress } from '../aztec-address/index.js';
import { schemas } from '../schemas/index.js';
import { type AbiType, AbiTypeSchema, FunctionType, getFunctionReturnType } from './abi.js';
import { FunctionSelector } from './function_selector.js';

/**
 * Bound for the arguments of a single function call, and for any hashed argument preimage: private call arguments,
 * utility call arguments and authwit preimages. The protocol caps only public calldata, through
 * `MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS`. Private arguments are circuit inputs folded into an args hash of any length,
 * and utility arguments never reach a circuit, so this is a sanity bound far above any real function signature. It
 * never drops below the public calldata cap, since public calls carry their arguments in the same field.
 */
export const MAX_FUNCTION_ARGS_LEN = Math.max(2 ** 14, MAX_FR_CALLDATA_TO_ALL_ENQUEUED_CALLS);

/** A request to call a function on a contract. */
export class FunctionCall {
  constructor(
    /** The name of the function to call */
    public name: string,
    /** The recipient contract */
    public to: AztecAddress,
    /** The function being called */
    public selector: FunctionSelector,
    /** Type of the function */
    public type: FunctionType,
    /** Only applicable for enqueued public function calls. `hideMsgSender = true` will set the msg_sender field (the caller's address) to "null", meaning the public function (and observers around the world) won't know which smart contract address made the call. */
    public hideMsgSender: boolean,
    /** Whether this call can make modifications to state or not */
    public isStatic: boolean,
    /** The encoded args */
    public args: Fr[],
    /** The type the call returns, for decoding, or undefined if it returns nothing */
    public returnType?: AbiType,
  ) {}

  static getFields(fields: FieldsOf<FunctionCall>) {
    return [
      fields.name,
      fields.to,
      fields.selector,
      fields.type,
      fields.hideMsgSender,
      fields.isStatic,
      fields.args,
      fields.returnType,
    ] as const;
  }

  static from(fields: FieldsOf<FunctionCall>): FunctionCall {
    return new FunctionCall(...FunctionCall.getFields(fields));
  }

  static get schema() {
    return z
      .object({
        name: z.string(),
        to: schemas.AztecAddress,
        selector: schemas.FunctionSelector,
        type: z.nativeEnum(FunctionType),
        isStatic: z.boolean(),
        hideMsgSender: z.boolean(),
        args: z.array(schemas.Fr).max(MAX_FUNCTION_ARGS_LEN),
        returnType: AbiTypeSchema.optional(),
        // Old consumers send `returnTypes`, not `returnType`. So we accept both for now, until we can safely remove
        // the old version.
        returnTypes: z.array(AbiTypeSchema).optional(),
      })
      .transform(({ returnType, returnTypes, ...fields }) =>
        FunctionCall.from({ ...fields, returnType: getFunctionReturnType({ returnType, returnTypes }) }),
      );
  }

  /**
   * Serializes the deprecated `returnTypes` alongside `returnType`, so that peers that still require the old field can
   * parse calls sent by this version.
   */
  public toJSON() {
    return { ...this, returnTypes: this.returnType ? [this.returnType] : [] };
  }

  public isPublicStatic(): boolean {
    return this.type === FunctionType.PUBLIC && this.isStatic;
  }

  /**
   * Creates an empty function call.
   * @returns an empty function call.
   */
  public static empty() {
    return FunctionCall.from({
      name: '',
      to: AztecAddress.ZERO,
      selector: FunctionSelector.empty(),
      type: FunctionType.PUBLIC,
      hideMsgSender: false,
      isStatic: false,
      args: [],
    });
  }
}
