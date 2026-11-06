// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation size-capped collections over evicting the first key by hand',
  messageId: 'preferBoundedCollection',
  importFrom: '@aztec-labs/foundation/collection',
  message:
    "To cap a Map or Set, use {{preferred}} or LruSet from '{{importFrom}}', or FifoSet.withLimit(n) from " +
    "'@aztec-labs/foundation/fifo-set', instead of evicting its first key by hand.",
  patterns: [
    {
      invalid: '$collection.keys().next().value',
      preferred: 'LruMap',
    },
  ],
});
