// @ts-check
import * as ts from 'typescript';

import { compilePattern, matchPattern } from './code-pattern.js';
import { createCodePatternRule } from './create-code-pattern-rule.js';

/**
 * @fileoverview Disallow implicit number formatting at viem decimal parser inputs.
 * Number stringification may produce exponent notation, which these parsers reject. Check direct expressions and
 * same-file const initializers; function returns, mutable variables, and runtime range checks are outside this rule.
 * Explicit formatting (for example, toFixed with suitable range and rounding constraints) remains the caller's choice.
 */

const DECIMAL_PARSERS = new Set(['parseGwei', 'parseEther', 'parseUnits']);
const VIEM_MODULES = new Set(['viem', 'viem/utils']);

const STRINGIFICATIONS = ['String($value)', '$value.toString(...$_)', '`${$value}`'].map(invalid =>
  compilePattern(invalid),
);

/** @type {WeakMap<import('eslint').SourceCode, ReturnType<typeof createAnalysis>>} */
const analyses = new WeakMap();

export default createCodePatternRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow number stringification passed to viem decimal amount parsers',
      recommended: true,
    },
    messages: {
      numberString:
        '{{parser}} requires decimal notation, but number stringification can produce exponent notation. Keep the amount as a decimal string, or use an explicit conversion with defined range and rounding.',
    },
    schema: [],
  },

  patterns: [
    {
      invalid: '$parser($value, ...$_)',
      messageId: 'numberString',
      report({ $parser, $value }, { sourceCode }) {
        if (!analyses.has(sourceCode)) {
          analyses.set(sourceCode, createAnalysis(sourceCode));
        }
        const analysis = analyses.get(sourceCode);
        const parser = analysis?.getParserName($parser);
        return parser && analysis.hasNumberString($value) ? { node: $value, data: { parser } } : false;
      },
    },
  ],
});

/** @param {import('eslint').SourceCode} sourceCode */
function createAnalysis(sourceCode) {
  const services = sourceCode.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap || !services.tsNodeToESTreeNodeMap) {
    return undefined;
  }
  /** @type {ts.Program} */
  const program = services.program;
  const checker = program.getTypeChecker();

  /** @param {ts.Expression} expression */
  function unwrap(expression) {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      expression = expression.expression;
    }
    return expression;
  }

  /** @param {ts.Node} declaration */
  function isViemImport(declaration) {
    return (
      ts.isImportDeclaration(declaration) &&
      ts.isStringLiteral(declaration.moduleSpecifier) &&
      VIEM_MODULES.has(declaration.moduleSpecifier.text)
    );
  }

  /** @param {ts.Expression} expression */
  function getMember(expression) {
    if (ts.isPropertyAccessExpression(expression)) {
      return { object: expression.expression, name: expression.name.text };
    }
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
      return { object: expression.expression, name: expression.argumentExpression.text };
    }
    return undefined;
  }

  /** @param {ts.Expression} expression */
  function getParserName(expression) {
    const callee = unwrap(expression);
    if (ts.isIdentifier(callee)) {
      const declarations = checker.getSymbolAtLocation(callee)?.declarations ?? [];
      for (const declaration of declarations) {
        if (ts.isImportSpecifier(declaration) && isViemImport(declaration.parent.parent.parent)) {
          const name = (declaration.propertyName ?? declaration.name).text;
          return DECIMAL_PARSERS.has(name) ? name : undefined;
        }
      }
    }
    const member = getMember(callee);
    if (member && DECIMAL_PARSERS.has(member.name)) {
      const object = unwrap(member.object);
      if (ts.isIdentifier(object)) {
        const declarations = checker.getSymbolAtLocation(object)?.declarations ?? [];
        if (
          declarations.some(declaration => ts.isNamespaceImport(declaration) && isViemImport(declaration.parent.parent))
        ) {
          return member.name;
        }
      }
    }
    return undefined;
  }

  /**
   * @param {ts.Type} type
   * @returns {boolean}
   */
  function includesNumber(type) {
    if (type.flags & ts.TypeFlags.NumberLike) {
      return true;
    }
    if (type.isUnionOrIntersection()) {
      return type.types.some(includesNumber);
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && constraint !== type && includesNumber(constraint);
  }

  /** @param {ts.Expression} expression */
  function isNumber(expression) {
    return includesNumber(checker.getTypeAtLocation(unwrap(expression)));
  }

  /**
   * @param {ts.Expression} expression
   * @param {Set<ts.Node>} seen
   * @returns {boolean}
   */
  function hasNumberString(expression, seen = new Set()) {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    if (ts.isIdentifier(value)) {
      const declarations = checker.getSymbolAtLocation(value)?.declarations ?? [];
      return declarations.some(
        declaration =>
          ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          !!(declaration.parent.flags & ts.NodeFlags.Const) &&
          declaration.getSourceFile() === value.getSourceFile() &&
          declaration.initializer !== undefined &&
          hasNumberString(declaration.initializer, seen),
      );
    }
    const node = services.tsNodeToESTreeNodeMap.get(value);
    for (const pattern of STRINGIFICATIONS) {
      const captures = matchPattern(pattern, node, sourceCode);
      if (captures) {
        const operand = services.esTreeNodeToTSNodeMap.get(captures.$value);
        return isNumber(operand) || hasNumberString(operand, seen);
      }
    }
    if (ts.isTemplateExpression(value)) {
      return value.templateSpans.some(span => isNumber(span.expression) || hasNumberString(span.expression, seen));
    }
    if (ts.isConditionalExpression(value)) {
      return hasNumberString(value.whenTrue, seen) || hasNumberString(value.whenFalse, seen);
    }
    return false;
  }

  return {
    getParserName: node => getParserName(services.esTreeNodeToTSNodeMap.get(node)),
    hasNumberString: node => hasNumberString(services.esTreeNodeToTSNodeMap.get(node)),
  };
}
