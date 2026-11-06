// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { getVariable, isGlobalIdentifier, isParameterReference, isSynchronousFunction } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation promiseWithResolvers for deferred promises',
  messages: {
    preferPromiseWithResolvers:
      "Use promiseWithResolvers() from '@aztec-labs/foundation/promise' instead of exporting a Promise executor's resolvers.",
  },
  implementations: { 'promise/utils.ts': ['promiseWithResolvers'] },
  matchers: {
    NewExpression(node, { sourceCode }) {
      if (
        node.type !== 'NewExpression' ||
        !isGlobalIdentifier(sourceCode, node.callee, 'Promise') ||
        node.arguments.length !== 1
      ) {
        return;
      }
      const executor = node.arguments[0];
      if (
        !isSynchronousFunction(executor) ||
        executor.params.length < 1 ||
        executor.params.length > 2 ||
        executor.params.some(parameter => parameter.type !== 'Identifier')
      ) {
        return;
      }
      const expressions =
        executor.body.type === 'BlockStatement'
          ? executor.body.body.map(statement =>
              statement.type === 'ExpressionStatement' ? statement.expression : undefined,
            )
          : [executor.body];
      const locals = sourceCode.getDeclaredVariables(executor);
      if (
        expressions.length > 0 &&
        expressions.every(expression => {
          if (
            expression?.type !== 'AssignmentExpression' ||
            expression.operator !== '=' ||
            !executor.params.some((_, index) => isParameterReference(sourceCode, expression.right, executor, index))
          ) {
            return false;
          }
          let target = expression.left.type === 'MemberExpression' ? expression.left.object : expression.left;
          while (target.type === 'MemberExpression') {
            target = target.object;
          }
          return (
            (target.type === 'ThisExpression' && executor.type === 'ArrowFunctionExpression') ||
            (target.type === 'Identifier' && !locals.includes(getVariable(sourceCode, target)))
          );
        })
      ) {
        return 'preferPromiseWithResolvers';
      }
    },
  },
});
