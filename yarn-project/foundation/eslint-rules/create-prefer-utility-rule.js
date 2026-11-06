// @ts-check
import { createTypeHelpers } from './utils.js';

/**
 * Builds a utility-preference rule from AST matchers and replacement messages.
 * ESLint owns parsing; all matchers share its source, scope manager, and TypeScript program.
 * @param {{
 *   description: string,
 *   messages: Record<string, string>,
 *   implementations?: Record<string, string[]>,
 *   matchers: Record<string, (
 *     node: import('eslint').Rule.Node,
 *     helpers: { sourceCode: import('eslint').SourceCode } & ReturnType<typeof createTypeHelpers>,
 *   ) => string | undefined>,
 * }} options
 * @returns {import('eslint').Rule.RuleModule}
 */
export function createPreferUtilityRule({ description, messages, implementations = {}, matchers }) {
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
        Object.entries(matchers).map(([selector, match]) => [
          selector,
          node => {
            for (let parent = node.parent; parent; parent = parent.parent) {
              if (parent.type === 'FunctionDeclaration' && parent.id && implementationNames.includes(parent.id.name)) {
                return;
              }
            }
            const messageId = match(node, helpers);
            if (messageId) {
              context.report({ node, messageId });
            }
          },
        ]),
      );
    },
  };
}
