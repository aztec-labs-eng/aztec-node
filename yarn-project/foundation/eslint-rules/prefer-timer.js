// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { getVariable, isGlobalIdentifier } from './utils.js';

/**
 * Matches a `const` whose only initializer is `<clock>.now()`, so subtracting it from another reading measures elapsed
 * time and nothing else.
 * @param {import('estree').Node} start
 * @param {string} clock
 * @param {import('eslint').SourceCode} sourceCode
 */
function isConstClockReading(start, clock, sourceCode) {
  if (start.type !== 'Identifier') {
    return false;
  }
  const definitions = getVariable(sourceCode, start)?.defs ?? [];
  const declarator = definitions.length === 1 ? definitions[0].node : undefined;
  const init = declarator?.type === 'VariableDeclarator' ? declarator.init : undefined;
  return (
    definitions[0]?.parent?.type === 'VariableDeclaration' &&
    definitions[0].parent.kind === 'const' &&
    init?.type === 'CallExpression' &&
    init.arguments.length === 0 &&
    init.callee.type === 'MemberExpression' &&
    !init.callee.computed &&
    !init.callee.optional &&
    init.callee.property.type === 'Identifier' &&
    init.callee.property.name === 'now' &&
    isGlobalIdentifier(sourceCode, init.callee.object, clock)
  );
}

export default createPreferUtilityRule({
  description: 'Prefer foundation Timer for measuring elapsed time',
  messageId: 'preferTimer',
  importFrom: '@aztec-labs/foundation/timer',
  message:
    "Use {{preferred}} from '{{importFrom}}' to measure elapsed time: `const timer = new Timer(); …; timer.ms()`, or " +
    '`const [ms, result] = await elapsed(fn)`.',
  implementations: { 'timer/timer.ts': ['Timer'], 'timer/elapsed.ts': ['elapsed', 'elapsedSync'] },
  patterns: [
    {
      invalid: 'Date.now() - $start',
      preferred: 'timer.ms()',
      guard: ({ $start }, { sourceCode }) => isConstClockReading($start, 'Date', sourceCode),
    },
    {
      invalid: 'performance.now() - $start',
      preferred: 'timer.ms()',
      guard: ({ $start }, { sourceCode }) => isConstClockReading($start, 'performance', sourceCode),
    },
  ],
});
