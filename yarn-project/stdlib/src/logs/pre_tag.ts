import { schemas } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import { type MessagingSecret, MessagingSecretSchema } from './messaging_secret.js';

/**
 * Represents a preimage of a private log tag (see `Tag` in `pxe/src/tagging`).
 *
 * Note: It's a bit unfortunate that this type resides in `stdlib` as the rest of the tagging functionality resides
 * in `pxe/src/tagging`. But this type is used by other types in stdlib hence there doesn't seem to be a good way
 * around this.
 */
export type PreTag = {
  extendedSecret: MessagingSecret;
  index: number;
};

export const PreTagSchema = z.object({
  extendedSecret: MessagingSecretSchema,
  index: schemas.Integer,
});
