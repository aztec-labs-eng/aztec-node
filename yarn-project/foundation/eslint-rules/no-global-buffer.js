// @ts-check

/**
 * @fileoverview Rule to disallow using the global Buffer as a value.
 * A browser has no such global, so code that may run there has to import Buffer from the 'buffer' package.
 * Uses of Buffer as a type are allowed, since they do not exist at runtime.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow using the global Buffer as a value',
      category: 'Best Practices',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      globalBuffer: "Import Buffer from 'buffer' instead of using the global, which does not exist in a browser.",
    },
    schema: [],
  },

  create(context) {
    return {
      Program(program) {
        const globalScope = context.sourceCode.getScope(program);
        const declaredGlobal = globalScope.set.get('Buffer');
        const references = [
          ...(declaredGlobal && declaredGlobal.defs.length === 0 ? declaredGlobal.references : []),
          ...globalScope.through.filter(reference => reference.identifier.name === 'Buffer'),
        ]
          // @ts-expect-error isValueReference is a typescript-eslint scope extension
          .filter(reference => reference.isValueReference !== false);

        references.forEach((reference, index) => {
          context.report({
            node: reference.identifier,
            messageId: 'globalBuffer',
            // One import covers every use in the file, so only the first report carries the fix.
            fix:
              index > 0
                ? undefined
                : fixer => {
                    const anchor = program.body.find(node => node.type === 'ImportDeclaration') ?? program.body[0];
                    return fixer.insertTextBefore(anchor, "import { Buffer } from 'buffer';\n");
                  },
          });
        });
      },
    };
  },
};
