// @ts-check
import { compilePattern, matchPattern, renderPreferred } from './code-pattern.js';
import { createTypeHelpers } from './utils.js';

/**
 * @typedef {{ sourceCode: import('eslint').SourceCode } & ReturnType<typeof createTypeHelpers>} PatternHelpers
 * @typedef {Record<string, import('estree').Node>} Captures
 * @typedef {{ node?: import('estree').Node, data?: Record<string, string> }} PatternReport
 * @typedef {{
 *   invalid: string | string[],
 *   messageId: string,
 *   preferred?: string,
 *   ignoreReturnValues?: boolean,
 *   guard?: (captures: Captures, helpers: PatternHelpers) => boolean,
 *   report?: (captures: Captures, helpers: PatternHelpers) => PatternReport | false,
 * }} CodePattern
 */

/**
 * Builds an ESLint rule from expression patterns and optional semantic checks.
 * A report callback can choose the diagnostic location and data, or decline a syntactic match.
 * @param {{
 *   meta: import('eslint').Rule.RuleMetaData,
 *   patterns: CodePattern[],
 *   implementations?: Record<string, string[]>,
 * }} options
 * @returns {import('eslint').Rule.RuleModule}
 */
export function createCodePatternRule({ meta, patterns, implementations = {} }) {
  const compiled = patterns.flatMap(pattern =>
    (Array.isArray(pattern.invalid) ? pattern.invalid : [pattern.invalid]).map(invalid => ({
      ...pattern,
      code: compilePattern(invalid, pattern.preferred, pattern.ignoreReturnValues),
    })),
  );
  return {
    meta,
    create(context) {
      const sourceCode = context.sourceCode;
      const helpers = { sourceCode, ...createTypeHelpers(sourceCode) };
      const filename = context.filename.replaceAll('\\', '/');
      const implementationNames = Object.entries(implementations)
        .filter(([path]) => filename.endsWith(`/${path}`))
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
              if (pattern.code.root.type !== node.type) {
                continue;
              }
              const captures = matchPattern(pattern.code, node, sourceCode);
              if (!captures || (pattern.guard && !pattern.guard(captures, helpers))) {
                continue;
              }
              const report = pattern.report?.(captures, helpers);
              if (report === false) {
                continue;
              }
              context.report({
                node: report?.node ?? node,
                messageId: pattern.messageId,
                data: {
                  ...(pattern.preferred === undefined
                    ? {}
                    : { preferred: renderPreferred(pattern.code, captures, sourceCode) }),
                  ...report?.data,
                },
              });
              return;
            }
          },
        ]),
      );
    },
  };
}
