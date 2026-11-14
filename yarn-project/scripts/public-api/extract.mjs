import { Source, digest, nameOf, stable, ts, unwrap, walk } from './source.mjs';

const fields = [
  'defaultValue',
  'default',
  'type',
  'isBoolean',
  'parseEnv',
  'parseVal',
  'fallback',
  'deprecatedFallback',
  'schema',
  'aliases',
  'required',
];
const entry = (node, bindings = new Map()) => ({ node, bindings });
const read = (source, value) => source.value(value?.node, value?.bindings);
const shape = (source, value) => source.shape(value?.node, value?.bindings);

/** Inventory only the explicitly configured environment, CLI and registered RPC surfaces. */
export function extract(files, config) {
  const source = new Source(files);
  const result = { environment: {}, cli: {}, rpc: {} };
  const locations = {};
  const add = (surface, key, value, node) => {
    const id = `${surface}:${key}`;
    const sf = node.getSourceFile();
    (locations[id] ??= new Set()).add(sf.fileName);
    const variants = (result[surface][key] ??= []);
    if (!variants.some(v => stable(v) === stable(value))) variants.push(value);
  };

  const envNames = source.exported(config.environment.names.file, config.environment.names.export);
  if (!envNames || !ts.isTypeAliasDeclaration(envNames)) throw new Error('Missing environment name declaration');
  walk(envNames.type, node => {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
      add('environment', node.literal.text, { declared: true }, node);
  });

  const metadata = props =>
    Object.fromEntries(
      fields
        .filter(key => props.has(key))
        .map(key => {
          const value = props.get(key);
          if (key === 'deprecatedFallback') {
            // Deprecation prose is not an API signature.
            const node = source.deref(value.node, value.bindings);
            if (ts.isArrayLiteralExpression(node))
              return [
                key,
                node.elements.map(element => {
                  const properties = source.properties(element, value.bindings);
                  return Object.fromEntries(
                    ['env', 'transform'].filter(k => properties.has(k)).map(k => [k, shape(source, properties.get(k))]),
                  );
                }),
              ];
          }
          return [key, shape(source, value)];
        }),
    );

  for (const [file, text] of files) {
    if (
      !file.startsWith(config.environment.root) ||
      !file.includes('/src/') ||
      !file.endsWith('.ts') ||
      config.environment.exclude.some(pattern => file.includes(pattern)) ||
      !/\benv['"]?\s*:/.test(text)
    )
      continue;
    walk(source.parse(file), node => {
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        ts.isTypeReferenceNode(node.type) &&
        nameOf(node.type.typeName) === 'ConfigMappingsType' &&
        node.initializer
      ) {
        try {
          for (const value of source.properties(node.initializer).values()) {
            const props = source.properties(value.node, value.bindings);
            if (!props.has('env')) continue;
            const name = read(source, props.get('env'));
            if (typeof name === 'string') add('environment', name, metadata(props), node);
          }
        } catch (error) {
          source.warn(node, error.message);
        }
      }
      if (!ts.isObjectLiteralExpression(node)) return;
      const env = node.properties.find(p => nameOf(p.name) === 'env' && ts.isPropertyAssignment(p));
      if (
        !env ||
        !node.properties.some(
          p => fields.includes(nameOf(p.name)) || nameOf(p.name) === 'description' || ts.isSpreadAssignment(p),
        )
      )
        return;
      try {
        let name;
        try {
          name = source.value(env.initializer);
        } catch {
          if (
            !(
              file === config.cli.startOptions.file &&
              ts.isIdentifier(unwrap(env.initializer)) &&
              nameOf(env.initializer) === 'env'
            ) &&
            node.properties.some(p => nameOf(p.name) === 'description' || fields.includes(nameOf(p.name)))
          )
            source.warn(env, 'Dynamic environment variable name');
          return;
        }
        if (name === undefined || name === null || typeof name !== 'string') return;
        const props = source.properties(node);
        const value = metadata(props);
        // An env field in a deprecatedFallback entry is covered by its parent mapping.
        if (props.has('message') && !fields.some(f => props.has(f))) return;
        add('environment', name, value, node);
        if (props.has('fallback')) {
          for (const alias of read(source, props.get('fallback'))) add('environment', alias, { aliasFor: name }, node);
        }
      } catch (error) {
        source.warn(node, error.message);
      }
    });
  }

  extractCli(source, config.cli, add, metadata);
  extractRpc(source, config.rpc, add);
  for (const surface of Object.values(result)) {
    for (const variants of Object.values(surface)) variants.sort((a, b) => stable(a).localeCompare(stable(b)));
  }
  return {
    surfaces: result,
    locations: Object.fromEntries(Object.entries(locations).map(([key, value]) => [key, [...value].sort()])),
    warnings: [...source.warnings].sort(),
    parsedFiles: source.parsed.size,
  };
}

function extractRpc(source, config, add) {
  const namespaces = new Map();
  walk(source.parse(config.registration), node => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    if (ts.isElementAccessExpression(node.left) && config.registries.includes(nameOf(node.left.expression))) {
      source.warn(node, 'Computed Node RPC registrations require an extraction adapter');
      return;
    }
    if (!ts.isPropertyAccessExpression(node.left) || !config.registries.includes(nameOf(node.left.expression))) return;
    const namespace = node.left.name.text;
    if (config.excludeNamespaces.includes(namespace)) return;
    const rhs = unwrap(node.right);
    if (ts.isArrayLiteralExpression(rhs)) {
      const schema = rhs.elements[1];
      if (!config.schemas.includes(nameOf(schema))) {
        source.warn(node, `Unconfigured RPC schema for ${namespace}: ${schema?.getText()}`);
        return;
      }
      namespaces.set(namespace, { schema, registry: nameOf(node.left.expression), node });
    } else if (ts.isPropertyAccessExpression(rhs) && namespaces.has(rhs.name.text)) {
      namespaces.set(namespace, { ...namespaces.get(rhs.name.text), node });
    } else source.warn(node, `Unsupported RPC registration for ${namespace}`);
  });
  if (!namespaces.size) throw new Error('No configured Node RPC registrations found');
  for (const [namespace, { schema, registry, node }] of namespaces) {
    const decl = source.lookup(schema);
    if (!decl?.initializer) throw new Error(`Cannot resolve RPC schema ${schema.getText()}`);
    const type = decl.type;
    const interfaceName = type && ts.isTypeReferenceNode(type) && type.typeArguments?.[0];
    const iface =
      interfaceName && ts.isTypeReferenceNode(interfaceName) ? source.lookup(interfaceName.typeName) : undefined;
    const methods = source.properties(decl.initializer);
    for (const [method, value] of methods) {
      const signature = iface?.members?.find(m => nameOf(m.name) === method);
      if (!signature || !ts.isMethodSignature(signature))
        source.warn(value.node, `Missing RPC type signature for ${method}`);
      add(
        'rpc',
        `${namespace}_${method}`,
        {
          endpoint: registry === 'adminServices' ? 'admin' : 'public',
          schema: shape(source, value),
          type: signature
            ? {
                parameters: signature.parameters.map(p => ({
                  type: source.typeShape(p.type),
                  optional: !!p.questionToken,
                  rest: !!p.dotDotDotToken,
                })),
                output: source.typeShape(signature.type),
              }
            : null,
        },
        node,
      );
    }
  }
}

function extractCli(source, config, add, metadata) {
  const root = { path: 'aztec', aliases: [], arguments: [] };
  const commands = new Map([['aztec', root]]);
  const cache = new Map();
  const visiting = new Set();
  const option = (flags, details, node, command) => {
    if (typeof flags !== 'string') throw new Error('Dynamic CLI flags');
    const names = flags.match(/--?[\w][\w.-]*/g) ?? [];
    const primary = names.find(n => n.startsWith('--')) ?? names[0];
    if (!primary) throw new Error(`Unsupported CLI flags: ${flags}`);
    const args = flags.match(/<[^>]+>|\[[^\]]+\]/g) ?? [];
    add(
      'cli',
      `${command.path} ${primary}`,
      {
        kind: 'option',
        aliases: names.filter(n => n !== primary).sort(),
        arguments: args,
        ...details,
      },
      node,
    );
    if (typeof details.env === 'string')
      add('environment', details.env, { cliDefault: details.default ?? null, parser: details.parser ?? null }, node);
  };
  const signature = (args, bindings) => {
    const third = args[2] && source.deref(args[2], bindings);
    const parser = third && (ts.isFunctionLike(third) || ts.isIdentifier(third));
    return {
      required: false,
      default: source.shape(parser ? args[3] : args[2], bindings),
      parser: parser ? source.shape(args[2], bindings) : null,
    };
  };
  function optionObject(node, bindings = new Map(), seen = new Set()) {
    node = source.deref(node, bindings);
    if (!node || seen.has(node)) throw new Error('Recursive CLI option');
    seen = new Set([...seen, node]);
    if (ts.isNewExpression(node) && nameOf(node.expression) === 'Option')
      return { flags: source.value(node.arguments[0], bindings), required: false, default: null, parser: null };
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const result = optionObject(node.expression.expression, bindings, seen);
      const key = node.expression.name.text;
      const methods = {
        default: 'default',
        argParser: 'parser',
        env: 'env',
        choices: 'choices',
        makeOptionMandatory: 'required',
        preset: 'preset',
        implies: 'implies',
        conflicts: 'conflicts',
        hideHelp: 'hidden',
      };
      if (!methods[key]) throw new Error(`Unsupported Option method: ${key}`);
      result[methods[key]] = ['env', 'required', 'hidden'].includes(methods[key])
        ? node.arguments.length
          ? source.value(node.arguments[0], bindings)
          : true
        : source.shape(node.arguments[0], bindings);
      return result;
    }
    if (ts.isCallExpression(node)) {
      const invoked = source.invoke(node, bindings);
      if (invoked) return optionObject(invoked.node, invoked.bindings, seen);
    }
    throw new Error(`Unsupported CLI option: ${node.getText().slice(0, 100)}`);
  }

  function command(node, bindings, commandBindings) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) {
      const decl = source.lookup(node);
      if (commandBindings.has(decl)) return commandBindings.get(decl);
      if (decl?.initializer) return command(decl.initializer, bindings, commandBindings);
      return undefined;
    }
    const cacheFor = cache.get(node) ?? new Map();
    cache.set(node, cacheFor);
    if (cacheFor.has(commandBindings)) return cacheFor.get(commandBindings);
    if (ts.isNewExpression(node) && nameOf(node.expression) === 'Command') {
      const name = source.value(node.arguments?.[0], bindings);
      const result = name === 'aztec' ? root : { path: `aztec ${name}`, aliases: [], arguments: [] };
      commands.set(result.path, result);
      cacheFor.set(commandBindings, result);
      return result;
    }
    if (!ts.isCallExpression(node)) return undefined;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const parent = command(node.expression.expression, bindings, commandBindings);
      if (!parent) return undefined;
      const method = node.expression.name.text;
      let result = parent;
      if (method === 'command') {
        const spec = source.value(node.arguments[0], bindings);
        if (typeof spec !== 'string') throw new Error('Dynamic command name');
        const [name, ...args] = spec.trim().split(/\s+/);
        result = { path: `${parent.path} ${name}`, aliases: [], arguments: args.map(shape => ({ shape })) };
        commands.set(result.path, result);
      } else if (method === 'option' || method === 'requiredOption') {
        option(
          source.value(node.arguments[0], bindings),
          {
            ...signature(node.arguments, bindings),
            required: method === 'requiredOption',
          },
          node,
          parent,
        );
      } else if (method === 'addOption') {
        const { flags, ...details } = optionObject(node.arguments[0], bindings);
        option(flags, details, node, parent);
      } else if (method === 'argument' || method === 'arguments') {
        parent.arguments.push({
          shape: source.value(node.arguments[0], bindings),
          ...signature(node.arguments, bindings),
        });
      } else if (method === 'alias' || method === 'aliases') {
        parent.aliases.push(...[source.value(node.arguments[0], bindings)].flat());
      } else if (method === 'addCommand') {
        const child = command(node.arguments[0], bindings, commandBindings);
        if (!child) throw new Error('Unsupported addCommand argument');
        if (parent !== root) throw new Error('Nested addCommand requires an extraction adapter');
      } else if (method === 'version') {
        option(node.arguments[1] ? source.value(node.arguments[1], bindings) : '-V, --version', {}, node, parent);
      } else if (
        [
          'allowUnknownOption',
          'allowExcessArguments',
          'enablePositionalOptions',
          'passThroughOptions',
          'helpOption',
          'addHelpCommand',
        ].includes(method)
      ) {
        parent[method] = node.arguments.map(arg => source.shape(arg, bindings));
      } else if (
        ![
          'description',
          'summary',
          'action',
          'configureHelp',
          'addHelpText',
          'hook',
          'parseAsync',
          'configureOutput',
          'showHelpAfterError',
          'showSuggestionAfterError',
        ].includes(method)
      ) {
        source.warn(node, `Unsupported Commander method: ${method}`);
      }
      cacheFor.set(commandBindings, result);
      return result;
    }
    const fn = source.deref(node.expression, bindings);
    if (!fn || !ts.isFunctionLike(fn)) {
      if (node.arguments.some(arg => command(arg, bindings, commandBindings)))
        source.warn(node, 'Unresolved CLI registration helper');
      return undefined;
    }
    const passed = node.arguments.map(arg => command(arg, bindings, commandBindings));
    if (!passed.some(Boolean)) return undefined;
    const nextCommands = new Map(commandBindings);
    const nextBindings = new Map(bindings);
    fn.parameters.forEach((param, i) => {
      if (passed[i]) nextCommands.set(param, passed[i]);
      if (node.arguments[i] ?? param.initializer) nextBindings.set(param, node.arguments[i] ?? param.initializer);
    });
    if (!visiting.has(fn)) {
      visiting.add(fn);
      scan(fn.body, nextBindings, nextCommands);
      visiting.delete(fn);
    }
    const result = passed.find(Boolean);
    cacheFor.set(commandBindings, result);
    return result;
  }

  function scan(node, bindings = new Map(), commandBindings = new Map()) {
    if (!node) return;
    if (ts.isCallExpression(node)) {
      try {
        const result = command(node, bindings, commandBindings);
        if (result) return;
      } catch (error) {
        source.warn(node, error.message);
        return;
      }
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      walk(node, child => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          ['command', 'addCommand', 'option', 'requiredOption', 'addOption'].includes(child.expression.name.text)
        )
          source.warn(child, 'CLI registration in a callback requires an extraction adapter');
      });
      return;
    }
    ts.forEachChild(node, child => scan(child, bindings, commandBindings));
  }
  scan(source.parse(config.entrypoint));

  const start = source.exported(config.startOptions.file, config.startOptions.export);
  if (!start?.initializer) throw new Error('Missing aztec start options');
  const universal = source.exported(config.startOptions.file, 'universalOptions');
  for (const adapter of config.adapters) {
    const declaration = source.exported(adapter.file, adapter.export);
    if (!declaration) throw new Error(`Missing CLI adapter: ${adapter.file}:${adapter.export}`);
    const bindings = new Map([[universal, ts.factory.createStringLiteral('universal-options')]]);
    const actual = digest(source.shape(declaration.initializer ?? declaration, bindings));
    if (!adapter.fingerprints.includes(actual))
      throw new Error(
        `Unsupported CLI adapter implementation: ${adapter.file}:${adapter.export} (${actual}). Update extraction before accepting this fingerprint.`,
      );
  }
  const universalKeys = source.value(universal.initializer);
  function startOptions(node, bindings = new Map()) {
    node = source.deref(node, bindings);
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) startOptions(ts.isSpreadElement(item) ? item.expression : item, bindings);
    } else if (ts.isCallExpression(node) && nameOf(node.expression) === 'getOptions') {
      const namespace = source.value(node.arguments[0], bindings);
      for (const [key, props] of source.properties(node.arguments[1], bindings)) {
        if (universalKeys.includes(key)) continue;
        const properties = source.properties(props.node, props.bindings);
        // getOptions checks typeof the mapping object, so its current generated flags all take a value.
        option(`--${namespace}.${key} <value>`, metadata(properties), node, { path: 'aztec start' });
      }
    } else if (ts.isCallExpression(node) && nameOf(node.expression) === 'configToFlag') {
      const props = source.properties(node.arguments[1], bindings);
      const isBoolean = props.has('isBoolean') && read(source, props.get('isBoolean'));
      if (node.arguments[2]) props.set('defaultValue', entry(node.arguments[2], bindings));
      option(source.value(node.arguments[0], bindings) + (isBoolean ? '' : ' <value>'), metadata(props), node, {
        path: 'aztec start',
      });
    } else {
      const props = source.properties(node, bindings);
      option(read(source, props.get('flag')), metadata(props), node, { path: 'aztec start' });
    }
  }
  for (const value of source.properties(start.initializer).values()) {
    try {
      startOptions(value.node, value.bindings);
    } catch (error) {
      source.warn(value.node, error.message);
    }
  }
  for (const [name, details] of commands) {
    details.aliases.sort();
    add('cli', name, { kind: 'command', ...details }, source.parse(config.entrypoint));
  }
}

/** Compare stable API keys; renames are deliberately a removal and an addition. */
export function compare(before, after) {
  const changes = { added: [], removed: [], modified: [] };
  for (const surface of Object.keys(before.surfaces)) {
    const oldEntries = before.surfaces[surface],
      newEntries = after.surfaces[surface];
    for (const name of [...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])].sort()) {
      const change = { surface, name, before: oldEntries[name], after: newEntries[name] };
      if (!(name in oldEntries)) changes.added.push(change);
      else if (!(name in newEntries)) changes.removed.push(change);
      else if (stable(oldEntries[name]) !== stable(newEntries[name])) changes.modified.push(change);
    }
  }
  return changes;
}
