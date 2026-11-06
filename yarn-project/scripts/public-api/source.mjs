import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const ts = createRequire(import.meta.url)('typescript');
export const stable = value =>
  JSON.stringify(value, (_, v) =>
    v && !Array.isArray(v) && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, v[k]]),
        )
      : v,
  );
export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
export const unwrap = node => {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
};
export const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
};
export const nameOf = node =>
  node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : undefined;
export const git = (root, args, input) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input,
  });

/** Read Git objects without checking out or executing either revision. */
export function snapshot(root, revision) {
  const files = git(
    root,
    revision === 'worktree'
      ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'yarn-project']
      : ['ls-tree', '-rz', '--name-only', revision, 'yarn-project'],
  )
    .split('\0')
    .filter(f => f.endsWith('.ts') || f.endsWith('/package.json'));
  if (revision === 'worktree') {
    return new Map(
      files.flatMap(file => {
        try {
          return [[file, readFileSync(path.join(root, file), 'utf8')]];
        } catch (error) {
          if (error.code === 'ENOENT') return [];
          throw error;
        }
      }),
    );
  }
  const batch = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
    input: files.map(f => `${revision}:${f}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
  });
  const result = new Map();
  let offset = 0;
  for (const file of files) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString();
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`Cannot read ${revision}:${file}: ${header}`);
    result.set(file, batch.subarray(end + 1, end + 1 + size).toString());
    offset = end + 2 + size;
  }
  return result;
}

/** A source-only resolver; workspace package exports point at src instead of build artifacts. */
export class Source {
  constructor(files) {
    this.files = files;
    this.parsed = new Map();
    this.packages = new Map();
    this.warnings = new Set();
    for (const [file, text] of files) {
      if (file.endsWith('/package.json')) {
        const pkg = JSON.parse(text);
        if (pkg.name) this.packages.set(pkg.name, { dir: path.posix.dirname(file), ...pkg });
      }
    }
  }

  warn(node, reason) {
    const sf = node.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    this.warnings.add(`${sf.fileName}:${line + 1}: ${reason}`);
  }

  parse(file) {
    if (!this.parsed.has(file)) {
      const text = this.files.get(file);
      if (text === undefined) throw new Error(`Missing source: ${file}`);
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (sf.parseDiagnostics.length)
        throw new Error(
          `${file}: ${sf.parseDiagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`,
        );
      this.parsed.set(file, sf);
    }
    return this.parsed.get(file);
  }

  module(from, specifier) {
    let target;
    if (specifier.startsWith('.')) target = path.posix.join(path.posix.dirname(from), specifier);
    else {
      const parts = specifier.split('/');
      const pkgName = parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
      const pkg = this.packages.get(pkgName);
      if (!pkg) return undefined;
      const subpath = '.' + specifier.slice(pkgName.length);
      let exported =
        typeof pkg.exports === 'string' ? (subpath === '.' ? pkg.exports : undefined) : pkg.exports?.[subpath];
      if (exported && typeof exported === 'object') exported = exported.import ?? exported.default ?? exported.types;
      if (typeof exported !== 'string') return undefined;
      target = path.posix.join(pkg.dir, exported.replace('/dest/', '/src/'));
    }
    target = target.replace(/\.js$/, '.ts').replace(/\.d\.ts$/, '.ts');
    return [target, `${target}.ts`, `${target}/index.ts`].find(f => this.files.has(f));
  }

  exported(file, name, seen = new Set()) {
    const key = `${file}:${name}`;
    if (seen.has(key)) return undefined;
    seen = new Set([...seen, key]);
    const sf = this.parse(file);
    for (const statement of sf.statements) {
      if (ts.isVariableStatement(statement)) {
        const decl = statement.declarationList.declarations.find(d => nameOf(d.name) === name);
        if (decl) return decl;
      }
      if (nameOf(statement.name) === name && (!ts.isFunctionDeclaration(statement) || statement.body)) return statement;
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && this.module(file, statement.moduleSpecifier.text);
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const spec = statement.exportClause.elements.find(e => e.name.text === name);
          if (spec)
            return target
              ? this.exported(target, spec.propertyName?.text ?? name, seen)
              : this.lookup(spec.propertyName ?? spec.name, seen);
        } else if (target) {
          const found = this.exported(target, name, seen);
          if (found) return found;
        }
      }
    }
  }

  lookup(node, seen = new Set()) {
    if (!ts.isIdentifier(node)) return undefined;
    const name = node.text;
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(p => nameOf(p.name) === name);
        if (parameter) return parameter;
      }
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements) {
          if (ts.isVariableStatement(statement)) {
            for (const d of statement.declarationList.declarations) {
              if (nameOf(d.name) === name) return d;
              if (ts.isObjectBindingPattern(d.name)) {
                const binding = d.name.elements.find(e => nameOf(e.name) === name);
                if (binding) return binding;
              }
            }
          }
          if (nameOf(statement.name) === name && (!ts.isFunctionDeclaration(statement) || statement.body))
            return statement;
          if (ts.isImportDeclaration(statement) && statement.importClause) {
            const bindings = statement.importClause.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
              const spec = bindings.elements.find(e => e.name.text === name);
              if (spec) {
                const target = this.module(scope.fileName, statement.moduleSpecifier.text);
                return target ? this.exported(target, spec.propertyName?.text ?? name, seen) : spec;
              }
            }
          }
        }
      }
    }
  }

  deref(node, bindings = new Map(), seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return node;
    seen = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const decl = this.lookup(node);
      if (bindings.has(decl)) return this.deref(bindings.get(decl), bindings, seen);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return this.deref(decl.initializer, bindings, seen);
      if (decl && (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl))) return decl;
    }
    if (ts.isElementAccessExpression(node)) {
      try {
        const key = this.value(node.argumentExpression, bindings);
        const prop = this.properties(node.expression, bindings).get(key);
        if (prop) return this.deref(prop.node, prop.bindings, seen);
      } catch {
        /* Dynamic indexing is retained in the normalized expression. */
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = this.deref(node.expression, bindings, seen);
      if (owner && ts.isClassDeclaration(owner)) {
        const member = owner.members.find(
          m => nameOf(m.name) === node.name.text && m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword),
        );
        if (member && ts.isGetAccessor(member)) return this.deref(this.returned(member), bindings, seen);
        if (member?.initializer) return this.deref(member.initializer, bindings, seen);
        if (member && ts.isMethodDeclaration(member)) return member;
      }
      if (
        node.name.text === 'shape' &&
        owner &&
        ts.isCallExpression(owner) &&
        ts.isPropertyAccessExpression(owner.expression) &&
        owner.expression.name.text === 'object'
      )
        return this.deref(owner.arguments[0], bindings, seen);
      if (owner && ts.isObjectLiteralExpression(owner)) {
        try {
          const value = this.properties(owner, bindings).get(node.name.text);
          if (value) return this.deref(value.node, value.bindings, seen);
        } catch {
          /* Retain property access on a runtime object. */
        }
      }
    }
    return node;
  }

  returned(fn) {
    if (!fn.body) return undefined;
    if (!ts.isBlock(fn.body)) return fn.body;
    const returns = fn.body.statements.filter(ts.isReturnStatement);
    return returns.length === 1 ? returns[0].expression : undefined;
  }

  invoke(node, bindings = new Map()) {
    const fn = this.deref(node.expression, bindings);
    if (!fn || !ts.isFunctionLike(fn)) return undefined;
    const returned = this.returned(fn);
    if (!returned) return undefined;
    const next = new Map(bindings);
    fn.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) next.set(p, ts.factory.createArrayLiteralExpression(node.arguments.slice(i)));
      else {
        const argument = node.arguments[i];
        const omitted = !argument || (ts.isIdentifier(unwrap(argument)) && nameOf(unwrap(argument)) === 'undefined');
        next.set(p, omitted ? (p.initializer ?? ts.factory.createIdentifier('undefined')) : argument);
      }
    });
    return { node: returned, bindings: next };
  }

  properties(node, bindings = new Map(), seen = new Set()) {
    node = this.deref(node, bindings);
    if (!node || seen.has(node)) throw new Error('Recursive or missing object expression');
    seen = new Set([...seen, node]);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return this.value(node.left, bindings) ? this.properties(node.right, bindings, seen) : new Map();
    if (ts.isCallExpression(node)) {
      if (node.expression.getText() === 'Object.fromEntries') {
        const mapped = unwrap(node.arguments[0]);
        if (
          ts.isCallExpression(mapped) &&
          ts.isPropertyAccessExpression(mapped.expression) &&
          mapped.expression.name.text === 'map'
        ) {
          const keys = this.value(mapped.expression.expression, bindings);
          const callback = mapped.arguments[0];
          const tuple = unwrap(this.returned(callback));
          if (Array.isArray(keys) && ts.isArrayLiteralExpression(tuple)) {
            return new Map(
              keys.map(key => {
                const next = new Map(bindings);
                next.set(callback.parameters[0], ts.factory.createStringLiteral(key));
                return [this.value(tuple.elements[0], next), { node: tuple.elements[1], bindings: next }];
              }),
            );
          }
        }
      }
      const name = nameOf(node.expression);
      if (name === 'omitConfigMappings' || name === 'pickConfigMappings') {
        const props = this.properties(node.arguments[0], bindings, seen);
        const keys = this.value(node.arguments[1], bindings);
        if (!Array.isArray(keys)) throw new Error(`Cannot resolve ${name} keys`);
        return new Map([...props].filter(([key]) => keys.includes(key) === (name === 'pickConfigMappings')));
      }
      const invoked = this.invoke(node, bindings);
      if (invoked) return this.properties(invoked.node, invoked.bindings, seen);
    }
    if (!ts.isObjectLiteralExpression(node)) throw new Error(`Unsupported object: ${node.getText().slice(0, 120)}`);
    const props = new Map();
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        for (const [key, value] of this.properties(prop.expression, bindings, seen)) props.set(key, value);
      } else {
        const key = nameOf(prop.name);
        if (key === undefined) throw new Error(`Unsupported computed property: ${prop.getText().slice(0, 80)}`);
        props.set(key, {
          node: ts.isShorthandPropertyAssignment(prop) ? prop.name : (prop.initializer ?? prop),
          bindings,
        });
      }
    }
    return props;
  }

  value(node, bindings = new Map(), seen = new Set()) {
    node = this.deref(node, bindings);
    if (!node) return undefined;
    if (seen.has(node)) throw new Error('Recursive value');
    seen = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isIdentifier(node) &&
      (node.text === 'undefined' ||
        (this.lookup(node) && ts.isParameter(this.lookup(node)) && !bindings.has(this.lookup(node))))
    )
      return undefined;
    if (ts.isArrayLiteralExpression(node))
      return node.elements.flatMap(e =>
        ts.isSpreadElement(e) ? this.value(e.expression, bindings, seen) : [this.value(e, bindings, seen)],
      );
    if (ts.isObjectLiteralExpression(node))
      return Object.fromEntries(
        [...this.properties(node, bindings)].map(([k, v]) => [k, this.value(v.node, v.bindings, seen)]),
      );
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map(s => {
            const value = this.value(s.expression, bindings, seen);
            if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Dynamic template');
            return value + s.literal.text;
          })
          .join('')
      );
    if (ts.isCallExpression(node)) {
      if (nameOf(node.expression) === 'getKeys' || node.expression.getText() === 'Object.keys')
        return [...this.properties(node.arguments[0], bindings).keys()];
      const invoked = this.invoke(node, bindings);
      if (invoked) return this.value(invoked.node, invoked.bindings, seen);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken)
      return -this.value(node.operand, bindings, seen);
    if (ts.isBinaryExpression(node)) {
      const left = this.value(node.left, bindings, seen),
        right = this.value(node.right, bindings, seen);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
      if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
      if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) return left / right;
    }
    throw new Error(`Dynamic value: ${node.getText().slice(0, 120)}`);
  }

  /** Normalize syntax and substitute source aliases without evaluating application code. */
  shape(node, bindings = new Map(), seen = new Set(), locals = new Map()) {
    node = unwrap(node);
    if (!node) return null;
    if (seen.has(node)) return { recursive: true };
    seen = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const decl = this.lookup(node);
      if (locals.has(node.text)) return locals.get(node.text);
      if (bindings.has(decl)) return this.shape(bindings.get(decl), bindings, seen, locals);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
        return this.shape(decl.initializer, bindings, seen, locals);
      if (decl && ts.isFunctionDeclaration(decl)) return this.shape(decl, bindings, seen, locals);
      if (decl && ts.isImportSpecifier(decl)) {
        const spec = decl.parent.parent.parent.moduleSpecifier.text;
        if (spec.startsWith('@aztec-labs/'))
          this.warn(node, `Unresolved workspace export ${spec}:${decl.propertyName?.text ?? decl.name.text}`);
        return { external: `${spec}:${decl.propertyName?.text ?? decl.name.text}` };
      }
      return node.text;
    }
    const resolved = this.deref(node, bindings);
    if (resolved !== node) return this.shape(resolved, bindings, seen, locals);
    if (ts.isStringLiteralLike(node)) return { string: node.text };
    if (ts.isNumericLiteral(node)) return { number: Number(node.text) };
    if (ts.isFunctionLike(node)) {
      const names = new Map(locals);
      node.parameters.forEach((p, i) => {
        if (nameOf(p.name)) names.set(nameOf(p.name), `$${i}`);
      });
      if (node.body)
        walk(node.body, child => {
          if (ts.isVariableDeclaration(child) && nameOf(child.name) && !names.has(nameOf(child.name)))
            names.set(nameOf(child.name), `$local${names.size}`);
        });
      return {
        parameters: node.parameters.map(p => ({
          optional: !!p.questionToken,
          rest: !!p.dotDotDotToken,
          type: this.syntax(p.type),
          default: this.shape(p.initializer, bindings, seen, names),
        })),
        body: digest(this.shape(node.body, bindings, seen, names)),
      };
    }
    if (ts.isPropertyAccessExpression(node))
      return { member: nameOf(node.name), of: this.shape(node.expression, bindings, seen, locals) };
    if (ts.isObjectLiteralExpression(node)) {
      try {
        return {
          object: Object.fromEntries(
            [...this.properties(node, bindings)].map(([k, v]) => [k, this.shape(v.node, v.bindings, seen, locals)]),
          ),
        };
      } catch (error) {
        if (!locals.size) this.warn(node, error.message);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node))
      return {
        [ts.isCallExpression(node) ? 'call' : 'new']: this.shape(node.expression, bindings, seen, locals),
        args: node.arguments?.map(a => this.shape(a, bindings, seen, locals)) ?? [],
      };
    if (ts.isTypeNode(node)) return this.syntax(node);
    const children = [];
    node.forEachChild(child => {
      children.push(this.shape(child, bindings, seen, locals));
    });
    return children.length ? { [ts.SyntaxKind[node.kind]]: children } : (ts.tokenToString(node.kind) ?? node.getText());
  }

  /** Resolve the declared types reachable from an RPC signature, without type checking the monorepo. */
  typeShape(node, seen = new Set()) {
    if (!node) return null;
    if (seen.has(node)) return { recursive: true };
    seen = new Set([...seen, node]);
    if (ts.isTypeReferenceNode(node)) {
      const decl = ts.isIdentifier(node.typeName) && this.lookup(node.typeName);
      const type =
        decl && ts.isTypeAliasDeclaration(decl)
          ? this.typeShape(decl.type, seen)
          : decl && ts.isInterfaceDeclaration(decl)
            ? this.typeShape(decl, seen)
            : this.syntax(node.typeName);
      return { type, arguments: node.typeArguments?.map(t => this.typeShape(t, seen)) ?? [] };
    }
    if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node))
      return {
        members: Object.fromEntries(
          node.members
            .map(member => [
              nameOf(member.name) ?? this.syntax(member.name),
              {
                optional: !!member.questionToken,
                ...(ts.isMethodSignature(member)
                  ? {
                      parameters: member.parameters.map(p => ({
                        type: this.typeShape(p.type, seen),
                        optional: !!p.questionToken,
                        rest: !!p.dotDotDotToken,
                      })),
                    }
                  : {}),
                type: this.typeShape(member.type, seen),
              },
            ])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        ),
        extends: node.heritageClauses?.map(clause => this.syntax(clause)) ?? [],
      };
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))
      return {
        [ts.isUnionTypeNode(node) ? 'union' : 'intersection']: node.types
          .map(t => this.typeShape(t, seen))
          .sort((a, b) => stable(a).localeCompare(stable(b))),
      };
    if (ts.isArrayTypeNode(node)) return { array: this.typeShape(node.elementType, seen) };
    if (ts.isTupleTypeNode(node)) return { tuple: node.elements.map(e => this.typeShape(e, seen)) };
    if (ts.isParenthesizedTypeNode(node)) return this.typeShape(node.type, seen);
    if (ts.isLiteralTypeNode(node)) return this.shape(node.literal);
    return this.syntax(node);
  }

  syntax(node) {
    if (!node) return null;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.getText());
    const tokens = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
    return tokens.join(' ');
  }
}
