import { schemas } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import { type MessagingSecret, MessagingSecretSchema } from './messaging_secret.js';

/** Represents a range of tagging indexes for a given messaging secret. */
export type TaggingIndexRange = {
  extendedSecret: MessagingSecret;
  lowestIndex: number;
  highestIndex: number;
};

export const TaggingIndexRangeSchema = z.object({
  extendedSecret: MessagingSecretSchema,
  lowestIndex: schemas.Integer,
  highestIndex: schemas.Integer,
});
