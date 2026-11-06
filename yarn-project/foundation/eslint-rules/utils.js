// @ts-check
import * as ts from 'typescript';

/**
 * Finds the lexical binding used by an identifier.
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Identifier} node
 */
export function getVariable(sourceCode, node) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) {
      return variable;
    }
  }
  return undefined;
}

/**
 * Checks for a built-in identifier without matching a local binding with the same name.
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 * @param {string} name
 */
export function isGlobalIdentifier(sourceCode, node, name) {
  if (node.type !== 'Identifier' || node.name !== name) {
    return false;
  }
  const variable = getVariable(sourceCode, node);
  return !variable || variable.defs.length === 0;
}

/**
 * Matches an ordinary method call, excluding optional calls and computed properties.
 * @param {import('estree').Node} node
 * @param {string} name
 * @returns {node is import('estree').SimpleCallExpression & { callee: import('estree').MemberExpression }}
 */
export function isMethodCall(node, name) {
  return (
    node.type === 'CallExpression' &&
    !node.optional &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.optional &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === name
  );
}

/**
 * Matches synchronous inline functions whose bodies can be inspected directly.
 * @param {import('estree').Node} node
 * @returns {node is import('estree').ArrowFunctionExpression | import('estree').FunctionExpression}
 */
export function isSynchronousFunction(node) {
  return (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && !node.async && !node.generator
  );
}

/**
 * Extracts a single returned expression; executors may also use an expression statement.
 * @param {import('estree').Node} body
 * @param {boolean} allowExpressionStatement
 */
export function getSingleExpression(body, allowExpressionStatement = false) {
  if (body.type !== 'BlockStatement') {
    return body;
  }
  const statement = body.body.length === 1 ? body.body[0] : undefined;
  if (statement?.type === 'ReturnStatement') {
    return statement.argument ?? undefined;
  }
  if (allowExpressionStatement && statement?.type === 'ExpressionStatement') {
    return statement.expression;
  }
  return undefined;
}

/**
 * Checks binding identity rather than just the spelling of a callback parameter.
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 * @param {import('estree').ArrowFunctionExpression | import('estree').FunctionExpression} fn
 * @param {number} index
 */
export function isParameterReference(sourceCode, node, fn, index) {
  const parameter = fn.params[index];
  return (
    node.type === 'Identifier' &&
    parameter?.type === 'Identifier' &&
    (getVariable(sourceCode, node)?.identifiers.includes(parameter) ?? false)
  );
}

/**
 * Creates accessors for the TypeScript program already supplied by ESLint's parser.
 * Without type information, helpers fail closed instead of guessing from variable names.
 * @param {import('eslint').SourceCode} sourceCode
 */
export function createTypeHelpers(sourceCode) {
  const services = sourceCode.parserServices;
  /** @type {import('typescript').TypeChecker | undefined} */
  const checker = services.program?.getTypeChecker();

  /**
   * @param {import('estree').Node} node
   * @returns {import('typescript').Type | undefined}
   */
  function getType(node) {
    if (!checker || !services.esTreeNodeToTSNodeMap) {
      return undefined;
    }
    return checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
  }

  /** @param {import('estree').Node} node */
  function getArrayElementType(node) {
    const type = getType(node);
    if (!type || !checker || (!checker.isArrayType(type) && !checker.isTupleType(type)) || !type.getProperty('push')) {
      return undefined;
    }
    return checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  }

  /**
   * @param {import('typescript').Type} type
   * @param {number} flags
   * @returns {boolean}
   */
  function isPrimitiveType(type, flags) {
    if (type.isUnion()) {
      return type.types.every(member => isPrimitiveType(member, flags));
    }
    if (type.isIntersection()) {
      return type.types.some(member => isPrimitiveType(member, flags));
    }
    const constraint = checker?.getBaseConstraintOfType(type);
    return !!(type.flags & flags) || (!!constraint && constraint !== type && isPrimitiveType(constraint, flags));
  }

  /** @param {import('estree').Node} node */
  function isBuffer(node) {
    const symbol = getType(node)?.getSymbol();
    return (
      symbol?.getName() === 'Buffer' &&
      (symbol.declarations?.some(declaration =>
        /\/node_modules\/(?:@types\/node|buffer)\//.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')),
      ) ??
        false)
    );
  }

  return { getArrayElementType, isPrimitiveType, isBuffer };
}
