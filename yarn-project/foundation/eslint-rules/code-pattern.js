// @ts-check
import { parser } from 'typescript-eslint';

import { getSingleExpression, getVariable, isGlobalIdentifier } from './utils.js';

const IGNORED_FIELDS = new Set([
  'parent',
  'start',
  'end',
  'range',
  'loc',
  'raw',
  'tokens',
  'comments',
  'typeAnnotation',
  'returnType',
  'typeArguments',
  'typeParameters',
]);

/**
 * Identifies AST nodes among the primitive values and arrays stored in AST fields.
 * @param {unknown} value
 * @returns {value is import('eslint').Rule.Node}
 */
function isNode(value) {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

/** @param {import('estree').Node} node */
function isPlaceholder(node) {
  return node.type === 'Identifier' && /^\$[\w$]+$/.test(node.name);
}

/** @param {import('estree').Node} node */
function isFunction(node) {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** @param {import('estree').Node} node */
function fields(node) {
  return Object.keys(node).filter(
    key =>
      !IGNORED_FIELDS.has(key) &&
      node[key] !== undefined &&
      !(node.type === 'Identifier' && key === 'optional') &&
      !(node.type === 'Identifier' && key === 'decorators' && node[key].length === 0) &&
      !(node.type === 'Property' && key === 'optional' && node[key] === false) &&
      !(node.type === 'Literal' && key === 'bigint') &&
      !(node.type === 'Property' && (key === 'shorthand' || key === 'key')),
  );
}

/** @param {import('estree').Node} key */
function propertyName(key) {
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal') {
    return String(key.value);
  }
  return undefined;
}

/** @param {string} code */
function parseExpression(code) {
  if (!('parseForESLint' in parser)) {
    throw new Error('Utility patterns require a parser with scope analysis.');
  }
  const parsed = parser.parseForESLint(`(${code})`, {
    ecmaVersion: 2025,
    sourceType: 'module',
    range: true,
    project: false,
    projectService: false,
  });
  if (
    !isNode(parsed.ast) ||
    parsed.ast.type !== 'Program' ||
    !parsed.scopeManager ||
    typeof parsed.scopeManager !== 'object' ||
    !('scopes' in parsed.scopeManager) ||
    !Array.isArray(parsed.scopeManager.scopes)
  ) {
    throw new Error('Utility patterns require an expression AST and scope analysis.');
  }
  const statement = parsed.ast.body[0];
  if (parsed.ast.body.length !== 1 || statement?.type !== 'ExpressionStatement' || !isNode(statement.expression)) {
    throw new Error(`Expected one expression in utility pattern: ${code}`);
  }
  return { expression: statement.expression, scopes: parsed.scopeManager.scopes, visitorKeys: parsed.visitorKeys };
}

/**
 * Parses a pattern and preferred expression once, recording bindings and replacement holes.
 * `$name` captures a node; `$_` ignores one node and `...$_` ignores trailing call arguments.
 * @param {string} invalid
 * @param {string} [preferred]
 * @param {boolean} ignoreReturnValues
 */
export function compilePattern(invalid, preferred, ignoreReturnValues = false) {
  const parsed = parseExpression(invalid);
  const symbols = new WeakMap();
  const references = new WeakSet();
  for (const scope of parsed.scopes) {
    for (const variable of scope.variables) {
      for (const identifier of variable.identifiers) {
        symbols.set(identifier, variable);
      }
    }
    for (const reference of scope.references) {
      references.add(reference.identifier);
      if (reference.resolved) {
        symbols.set(reference.identifier, reference.resolved);
      }
    }
  }
  const replacement = preferred === undefined ? undefined : parseExpression(preferred);
  /** @type {{ name: string, start: number, end: number }[]} */
  const holes = [];
  function visit(node) {
    if (!isNode(node)) {
      return;
    }
    if (node.type === 'Identifier' && isPlaceholder(node)) {
      holes.push({ name: node.name, start: node.range[0] - 1, end: node.range[1] - 1 });
    }
    for (const key of replacement?.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  }
  if (replacement) {
    visit(replacement.expression);
  }
  holes.sort((a, b) => b.start - a.start);
  return {
    root: parsed.expression,
    symbols,
    references,
    preferred: preferred ?? '',
    holes,
    ignoreReturnValues,
  };
}

/**
 * Matches an expression structurally while preserving callback and global binding identity.
 * @param {ReturnType<typeof compilePattern>} pattern
 * @param {import('eslint').Rule.Node} node
 * @param {import('eslint').SourceCode} sourceCode
 */
export function matchPattern(pattern, node, sourceCode) {
  /** @type {Record<string, import('estree').Node>} */
  const captures = {};
  const bindings = new Map();

  function match(expected, actual, key = '', capture = true) {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) {
        return false;
      }
      const last = expected.at(-1);
      const rest =
        capture &&
        key === 'arguments' &&
        last?.type === 'SpreadElement' &&
        last.argument.type === 'Identifier' &&
        last.argument.name === '$_';
      const length = expected.length - (rest ? 1 : 0);
      return (
        (rest ? actual.length >= length : actual.length === length) &&
        expected.slice(0, length).every((child, index) => match(child, actual[index], '', capture))
      );
    }
    if (!isNode(expected)) {
      if (expected && typeof expected === 'object') {
        return (
          actual &&
          typeof actual === 'object' &&
          Object.keys(expected)
            .filter(key => !IGNORED_FIELDS.has(key))
            .every(key => match(expected[key], actual[key], key, capture))
        );
      }
      return expected === actual;
    }
    if (!isNode(actual)) {
      return false;
    }
    if (capture && expected.type === 'Identifier' && isPlaceholder(expected)) {
      if (expected.name === '$_') {
        return true;
      }
      const symbol = pattern.symbols.get(expected);
      if (symbol?.defs.length) {
        if (actual.type !== 'Identifier') {
          return false;
        }
        const variable = getVariable(sourceCode, actual);
        if (!variable) {
          return false;
        }
        if (bindings.has(symbol)) {
          return bindings.get(symbol) === variable;
        }
        bindings.set(symbol, variable);
      } else if (actual.type === 'SpreadElement' || actual.type === 'RestElement') {
        return false;
      }
      const previous = captures[expected.name];
      if (previous) {
        return match(previous, actual, '', false);
      }
      captures[expected.name] = actual;
      return true;
    }
    if (capture && isFunction(expected) && isFunction(actual)) {
      const expectedId = expected.type === 'FunctionExpression' ? expected.id : undefined;
      const actualId = actual.type === 'FunctionExpression' ? actual.id : undefined;
      if (
        expected.async !== actual.async ||
        !!expected.generator !== !!actual.generator ||
        (expectedId && !match(expectedId, actualId)) ||
        !match(expected.params, actual.params)
      ) {
        return false;
      }
      const expectedBody = getSingleExpression(expected.body, pattern.ignoreReturnValues);
      const actualBody = getSingleExpression(actual.body, pattern.ignoreReturnValues);
      return expectedBody ? !!actualBody && match(expectedBody, actualBody) : match(expected.body, actual.body);
    }
    if (expected.type !== actual.type) {
      return false;
    }
    if (expected.type === 'Identifier' && actual.type === 'Identifier') {
      if (!capture) {
        return expected.name === actual.name && getVariable(sourceCode, expected) === getVariable(sourceCode, actual);
      }
      const symbol = pattern.symbols.get(expected);
      if (symbol?.defs.length) {
        const variable = getVariable(sourceCode, actual);
        if (expected.name !== actual.name || !variable) {
          return false;
        }
        if (bindings.has(symbol)) {
          return bindings.get(symbol) === variable;
        }
        bindings.set(symbol, variable);
      } else if (pattern.references.has(expected)) {
        return isGlobalIdentifier(sourceCode, actual, expected.name);
      }
    }
    if (expected.type === 'Property' && actual.type === 'Property') {
      if (expected.computed || actual.computed || isPlaceholder(expected.key)) {
        if (!match(expected.key, actual.key, 'key', capture)) {
          return false;
        }
      } else if (propertyName(expected.key) !== propertyName(actual.key)) {
        return false;
      }
    }
    const expectedKeys = fields(expected);
    const actualKeys = fields(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(key => actualKeys.includes(key) && match(expected[key], actual[key], key, capture))
    );
  }

  return match(pattern.root, node) ? captures : undefined;
}

/**
 * Renders the preferred expression for a diagnostic; this does not provide an automatic fix.
 * @param {ReturnType<typeof compilePattern>} pattern
 * @param {Record<string, import('estree').Node>} captures
 * @param {import('eslint').SourceCode} sourceCode
 */
export function renderPreferred(pattern, captures, sourceCode) {
  let result = pattern.preferred;
  for (const { name, start, end } of pattern.holes) {
    const node = captures[name];
    if (!node) {
      throw new Error(`Preferred expression references an uncaptured placeholder: ${name}`);
    }
    let text = sourceCode.getText(node);
    if (node.type === 'SequenceExpression') {
      text = `(${text})`;
    }
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}
