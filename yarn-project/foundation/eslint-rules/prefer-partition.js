// @ts-check
import { createTypeHelpers, getSingleExpression, isSynchronousFunction } from './utils.js';

const NEGATED_EQUALITY = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };

/**
 * Accepts receivers that evaluate to the same array twice: identifiers, `this`, and non-computed property chains.
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isStableReceiver(node) {
  if (node.type === 'Identifier' || node.type === 'ThisExpression') {
    return true;
  }
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    !node.optional &&
    isStableReceiver(/** @type {any} */ (node.object))
  );
}

/**
 * Matches `items.filter(item => predicate)` with an inline, single-parameter, synchronous callback that is not a type
 * predicate, since `partition` does not narrow its result types.
 * @param {import('estree').Node | null | undefined} init
 */
function getFilter(init) {
  if (
    init?.type !== 'CallExpression' ||
    /** @type {any} */ (init).optional ||
    init.arguments.length !== 1 ||
    init.callee.type !== 'MemberExpression' ||
    init.callee.computed ||
    /** @type {any} */ (init.callee).optional ||
    init.callee.property.type !== 'Identifier' ||
    init.callee.property.name !== 'filter' ||
    !isStableReceiver(init.callee.object)
  ) {
    return undefined;
  }
  const callback = init.arguments[0];
  if (
    !isSynchronousFunction(callback) ||
    callback.params.length !== 1 ||
    callback.params[0].type !== 'Identifier' ||
    /** @type {any} */ (callback).returnType
  ) {
    return undefined;
  }
  const body = getSingleExpression(callback.body);
  if (!body) {
    return undefined;
  }
  return { items: init.callee.object, callback, param: callback.params[0].name, body };
}

/**
 * Reports two adjacent declarations that filter the same array by a predicate and by its negation.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Prefer foundation partition over filtering one array twice with opposite predicates' },
    messages: {
      preferPartition:
        "Use `const [{{pass}}, {{fail}}] = partition({{items}}, {{predicate}})` from '@aztec-labs/foundation/collection' " +
        'instead of filtering the array twice with opposite predicates.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const { getArrayElementType } = createTypeHelpers(sourceCode);

    /** @param {import('estree').Node} node */
    function tokens(node) {
      return sourceCode
        .getTokens(node)
        .map(token => `${token.type}:${token.value}`)
        .join(' ');
    }

    /** @param {import('estree').Node} a @param {import('estree').Node} b */
    function same(a, b) {
      return tokens(a) === tokens(b);
    }

    /**
     * Returns whether the first body is the negation of the second.
     * @param {import('estree').Node} a
     * @param {import('estree').Node} b
     */
    function negates(a, b) {
      if (a.type === 'UnaryExpression' && a.operator === '!' && same(a.argument, b)) {
        return true;
      }
      return (
        a.type === 'BinaryExpression' &&
        b.type === 'BinaryExpression' &&
        (a.operator === '!==' || a.operator === '!=') &&
        NEGATED_EQUALITY[a.operator] === b.operator &&
        same(a.left, b.left) &&
        same(a.right, b.right)
      );
    }

    /**
     * @param {import('estree').VariableDeclarator} first
     * @param {import('estree').VariableDeclarator} second
     */
    function check(first, second) {
      const a = getFilter(first.init);
      const b = getFilter(second.init);
      if (!a || !b || a.param !== b.param || !same(a.items, b.items) || !getArrayElementType(a.items)) {
        return;
      }
      const [pass, fail] = negates(a.body, b.body) ? [second, first] : negates(b.body, a.body) ? [first, second] : [];
      if (!pass || !fail) {
        return;
      }
      context.report({
        node: first,
        messageId: 'preferPartition',
        data: {
          pass: sourceCode.getText(pass.id),
          fail: sourceCode.getText(fail.id),
          items: sourceCode.getText(a.items),
          predicate: sourceCode.getText((pass === first ? a : b).callback),
        },
      });
    }

    /** @param {import('estree').Node[]} statements */
    function checkStatements(statements) {
      /** @type {import('estree').VariableDeclarator | undefined} */
      let previous;
      for (const statement of statements) {
        if (statement.type !== 'VariableDeclaration' || (statement.kind !== 'const' && statement.kind !== 'let')) {
          previous = undefined;
          continue;
        }
        for (const declarator of statement.declarations) {
          if (previous) {
            check(previous, declarator);
          }
          previous = declarator;
        }
      }
    }

    return {
      Program: node => checkStatements(node.body),
      BlockStatement: node => checkStatements(node.body),
      StaticBlock: node => checkStatements(node.body),
      SwitchCase: node => checkStatements(node.consequent),
    };
  },
};
