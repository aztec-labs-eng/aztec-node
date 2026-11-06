// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { isMethodCall } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation bufferToHex for prefixed Buffer hex strings',
  messages: {
    preferBufferToHex:
      "Use bufferToHex(buffer) from '@aztec-labs/foundation/string' to produce a 0x-prefixed hex string.",
  },
  implementations: { 'string/index.ts': ['bufferToHex'] },
  matchers: {
    TemplateLiteral(node, { isBuffer }) {
      if (
        node.type !== 'TemplateLiteral' ||
        node.expressions.length !== 1 ||
        node.quasis[0].value.cooked !== '0x' ||
        node.quasis[1].value.cooked !== ''
      ) {
        return;
      }
      const expression = node.expressions[0];
      if (
        isMethodCall(expression, 'toString') &&
        expression.arguments.length === 1 &&
        expression.arguments[0].type === 'Literal' &&
        expression.arguments[0].value === 'hex' &&
        isBuffer(expression.callee.object)
      ) {
        return 'preferBufferToHex';
      }
    },
  },
});
