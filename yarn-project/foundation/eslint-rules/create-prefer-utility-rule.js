// @ts-check
import { compilePattern, matchPattern, renderPreferred } from './code-pattern.js';
import { createTypeHelpers } from './utils.js';

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
 *     helpers: { sourceCode: import('eslint').SourceCode } & ReturnType<typeof createTypeHelpers>,
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
  const compiled = patterns.flatMap(pattern =>
    (Array.isArray(pattern.invalid) ? pattern.invalid : [pattern.invalid]).map(invalid => ({
      ...pattern,
      messageId: pattern.messageId ?? messageId,
      importFrom: pattern.importFrom ?? importFrom,
      code: compilePattern(invalid, pattern.preferred, pattern.ignoreReturnValues),
    })),
  );
  const messages = Object.fromEntries(compiled.map(pattern => [pattern.messageId, message]));
  return {
    meta: { type: 'suggestion', docs: { description }, messages, schema: [] },
    create(context) {
      const sourceCode = context.sourceCode;
      const helpers = { sourceCode, ...createTypeHelpers(sourceCode) };
      const filename = context.filename.replaceAll('\\', '/');
      const implementationNames = Object.entries(implementations)
        .filter(([path]) => filename.endsWith(`/foundation/src/${path}`))
        .flatMap(([, names]) => names);

      return Object.fromEntries(
        [...new Set(compiled.map(pattern => pattern.code.root.type))].map(selector => [
          selector,
          node => {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (parent.type === 'FunctionDeclaration' && parent.id && implementationNames.includes(parent.id.name)) {
                return;
              }
            }
            for (const pattern of compiled) {
              if (pattern.code.root.type !== node.type) continue;
              const captures = matchPattern(pattern.code, node, sourceCode);
              if (captures && (!pattern.guard || pattern.guard(captures, helpers))) {
                context.report({
                  node,
                  messageId: pattern.messageId,
                  data: {
                    preferred: renderPreferred(pattern.code, captures, sourceCode),
                    importFrom: pattern.importFrom,
                  },
                });
                return;
              }
            }
          },
        ]),
      );
    },
  };
}
