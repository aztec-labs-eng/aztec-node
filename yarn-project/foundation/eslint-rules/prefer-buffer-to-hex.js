// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation bufferToHex for prefixed Buffer hex strings',
  messageId: 'preferBufferToHex',
  importFrom: '@aztec-labs/foundation/string',
  implementations: { 'string/index.ts': ['bufferToHex'] },
  patterns: [
    {
      invalid: '`0x${$buffer.toString("hex")}`',
      preferred: 'bufferToHex($buffer)',
      guard: ({ $buffer }, { isBuffer }) => isBuffer($buffer),
    },
  ],
});
