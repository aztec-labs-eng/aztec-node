import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { z } from 'zod';

import type { FunctionSelector } from '../abi/function_selector.js';
import type { AztecAddress } from '../aztec-address/index.js';
import { Gas } from '../gas/gas.js';
import { schemas, zodFor } from '../schemas/index.js';

/** Constraints a setup call must satisfy, beyond targeting the entry's function, for the tx to be admitted. */
type AllowedCallConstraints = {
  onlySelf?: boolean;
  rejectNullMsgSender?: boolean;
  calldataLength?: number;
  /**
   * The most gas the call can use in setup, for any calldata the entry allows. The tx's gas limits must leave at least
   * this much for setup.
   */
  minGas?: Gas;
};

type AllowedInstanceFunction = AllowedCallConstraints & {
  address: AztecAddress;
  selector: FunctionSelector;
};
type AllowedClassFunction = AllowedCallConstraints & {
  classId: Fr;
  selector: FunctionSelector;
};

export type AllowedElement = AllowedInstanceFunction | AllowedClassFunction;

const allowedCallConstraintsSchema = {
  onlySelf: z.boolean().optional(),
  rejectNullMsgSender: z.boolean().optional(),
  calldataLength: z.number().optional(),
  minGas: Gas.schema.optional(),
};

export const AllowedElementSchema = zodFor<AllowedElement>()(
  z.union([
    z.object({
      address: schemas.AztecAddress,
      selector: schemas.FunctionSelector,
      ...allowedCallConstraintsSchema,
    }),
    z.object({
      classId: schemas.Fr,
      selector: schemas.FunctionSelector,
      ...allowedCallConstraintsSchema,
    }),
  ]),
);
