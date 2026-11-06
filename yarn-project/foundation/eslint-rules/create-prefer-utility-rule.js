// @ts-check
import { createCodePatternRule } from './create-code-pattern-rule.js';

/**
 * Describes equivalent syntax forms and the semantic guard needed before reporting them.
 * @typedef {{
 *   invalid: string | string[],
 *   preferred: string,
 *   messageId?: string,
 *   importFrom?: string,
 *   ignoreReturnValues?: boolean,
 *   guard?: (
 *     captures: Record<string, import('estree').Node>,
 *     helpers: import('./create-code-pattern-rule.js').PatternHelpers,
 *   ) => boolean,
 * }} UtilityPattern
 */

/**
 * Builds a rule from code templates, sharing AST matching, bindings, reporting, and type helpers.
 * Pattern strings are parsed once; source files reuse ESLint's AST and TypeScript program.
 * @param {{
 *   description: string,
 *   messageId: string,
 *   importFrom: string,
 *   message?: string,
 *   implementations?: Record<string, string[]>,
 *   patterns: UtilityPattern[],
 * }} options
 * @returns {import('eslint').Rule.RuleModule}
 */
export function createPreferUtilityRule({
  description,
  messageId,
  importFrom,
  message = "Use {{preferred}} from '{{importFrom}}' instead.",
  implementations = {},
  patterns,
}) {
  const messages = Object.fromEntries(patterns.map(pattern => [pattern.messageId ?? messageId, message]));
  return createCodePatternRule({
    meta: { type: 'suggestion', docs: { description }, messages, schema: [] },
    implementations: Object.fromEntries(
      Object.entries(implementations).map(([path, names]) => [`foundation/src/${path}`, names]),
    ),
    patterns: patterns.map(pattern => ({
      ...pattern,
      messageId: pattern.messageId ?? messageId,
      report: () => ({ data: { importFrom: pattern.importFrom ?? importFrom } }),
    })),
  });
}
