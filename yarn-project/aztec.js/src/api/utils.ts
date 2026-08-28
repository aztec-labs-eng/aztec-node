/**
 * Utility functions for aztec.js.
 *
 * NOTE: This module contains low-usage utilities and may be deprecated in the future.
 * Prefer using more specific modules:
 * - Node connection utilities → `@aztec-labs/aztec.js/node`
 * - Type converters → `@aztec-labs/aztec.js/abi`
 * - Key generation → `@aztec-labs/aztec.js/keys`
 * - Messaging utilities → `@aztec-labs/aztec.js/messaging`
 */

// Low-usage utilities - consider these internal/experimental
export { getFeeJuiceBalance } from '../utils/fee_juice.js';
export { readFieldCompressedString } from '../utils/field_compressed_string.js';
