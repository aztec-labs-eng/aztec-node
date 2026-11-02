import type { z } from 'zod';

/**
 * Pipes whose input guard checks the size of the record they feed before it parses any entry, which zod's own checks
 * cannot show. This is the opt-out of the unbounded-container walker, the only reader: it treats a record that is the
 * immediate output of one of these pipes as bounded. Kept out of the schemas barrel so only `boundedRecord` adds to it.
 */
export const sizeCheckedBeforeParse = new WeakSet<z.core.$ZodType>();
