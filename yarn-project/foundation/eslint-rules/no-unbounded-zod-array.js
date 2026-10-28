// @ts-check

/**
 * @fileoverview Rule to require an upper size bound on zod array schemas.
 *
 * zod validates every element of an array and records one issue per invalid element, so a large array of junk sent to
 * a JSON-RPC endpoint makes the server allocate memory proportional to the array length before rejecting it
 * (GHSA-mrhx-c7xc-m3w5). Since zod 4.6.6, a declared `.max(n)` or `.length(n)` is checked before any element is
 * parsed, which caps that cost. This rule flags array schemas that do not declare such a bound.
 *
 * Flagged expressions:
 * - `z.array(element)`
 * - `schema.array()` (the zero-argument method every zod schema has)
 *
 * The bound must appear in the method chain applied directly to that expression, before it is wrapped or transformed:
 * - `z.array(x).max(10)`, `z.array(x).min(1).max(10)`, `z.array(x).length(4)`, `z.array(x).max(10).optional()` pass.
 * - `z.array(x)`, `z.array(x).optional()`, `z.array(x).nonempty()`, `optional(z.array(x))` are flagged.
 *
 * The check is per expression: a bound applied later through a variable (`const s = z.array(x); s.max(10)`) is not
 * seen, so declare the bound inline or disable the rule on that line with a justification.
 *
 * `z.set`, `z.map` and `z.record` are not checked: the first two only accept `Set`/`Map` instances, which JSON cannot
 * produce, and zod offers no size bound on records that is checked before their entries are parsed.
 */

const BOUND_METHODS = new Set(['max', 'length']);

/**
 * Returns whether the node is a call to `z.array(...)` or to a zero-argument `.array()` method.
 * @param {import('estree').CallExpression} node
 * @returns {boolean}
 */
function isArraySchemaCall(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') {
    return false;
  }
  if (callee.property.name !== 'array') {
    return false;
  }
  if (callee.object.type === 'Identifier' && callee.object.name === 'z') {
    return true;
  }
  return node.arguments.length === 0;
}

/**
 * Walks up the method chain applied to `node` (`node.a().b()...`) and returns whether any call in it is a size bound.
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function chainHasBound(node) {
  /** @type {import('eslint').Rule.Node} */
  let current = node;
  while (true) {
    const member = current.parent;
    if (!member || member.type !== 'MemberExpression' || member.object !== current) {
      return false;
    }
    const call = member.parent;
    if (!call || call.type !== 'CallExpression' || call.callee !== member) {
      return false;
    }
    if (!member.computed && member.property.type === 'Identifier' && BOUND_METHODS.has(member.property.name)) {
      return true;
    }
    current = call;
  }
}

/**
 * Returns whether the node sits inside the `output` schema of a `z.function({ input, output })` declaration. Those
 * schemas parse what the server returns to a client, not what a caller sends to the server.
 * @param {import('eslint').Rule.Node[]} ancestors
 * @returns {boolean}
 */
function isInFunctionOutput(ancestors) {
  for (let i = ancestors.length - 1; i >= 2; i--) {
    const property = ancestors[i];
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') {
      continue;
    }
    if (property.key.name !== 'output') {
      continue;
    }
    const call = ancestors[i - 2];
    if (
      ancestors[i - 1].type === 'ObjectExpression' &&
      call.type === 'CallExpression' &&
      call.callee.type === 'MemberExpression' &&
      call.callee.object.type === 'Identifier' &&
      call.callee.object.name === 'z' &&
      call.callee.property.type === 'Identifier' &&
      call.callee.property.name === 'function'
    ) {
      return true;
    }
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require an upper size bound on zod array schemas',
      category: 'Security',
      recommended: true,
    },
    messages: {
      unboundedArray:
        'zod array schema has no upper size bound. zod builds one issue per invalid element, so an unbounded array ' +
        'parsed from untrusted input (e.g. a JSON-RPC request) lets a caller exhaust memory. Add `.max(<bound>)` or ' +
        '`.length(<n>)` directly on this expression, before any `.optional()`/`.transform()` (e.g. `.max(MAX_RPC_LEN)`). ' +
        'If the schema only parses trusted data, disable this rule for the line with a justification.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        if (!isArraySchemaCall(node) || chainHasBound(node)) {
          return;
        }
        if (isInFunctionOutput(context.sourceCode.getAncestors(node))) {
          return;
        }
        context.report({ node, messageId: 'unboundedArray' });
      },
    };
  },
};
