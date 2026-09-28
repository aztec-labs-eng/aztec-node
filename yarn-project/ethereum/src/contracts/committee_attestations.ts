import { type ZodFor, schemas } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

/** Raw packed `CommitteeAttestations` tuple used by viem. */
export type ViemCommitteeAttestations = {
  signatureIndices: `0x${string}`;
  signaturesOrAddresses: `0x${string}`;
};

/** Schema for the raw packed `CommitteeAttestations` tuple. */
export const ViemCommitteeAttestationsSchema: ZodFor<ViemCommitteeAttestations> = z.object({
  signatureIndices: schemas.HexStringWith0x,
  signaturesOrAddresses: schemas.HexStringWith0x,
});
