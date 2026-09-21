import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import { getPathToFile, getPathToFndFile } from './index.js';

const repoRoot = getPathToFile('');

const hasFndCheckout = (() => {
  try {
    getPathToFndFile('');
    return true;
  } catch {
    return false;
  }
})();

const itInFndCheckout = hasFndCheckout ? it : it.skip;
const itOutsideFndCheckout = hasFndCheckout ? it.skip : it;

describe('getPathToFndFile', () => {
  itInFndCheckout('resolves one directory above the repo root', () => {
    expect(getPathToFndFile('noir-projects/fnd')).toEqual(resolve(repoRoot, '..', 'noir-projects/fnd'));
  });

  itInFndCheckout('points at a checkout holding the protocol circuit sources', () => {
    expect(existsSync(getPathToFndFile('noir-projects/fnd/noir-protocol-circuits/crates'))).toBe(true);
  });

  itOutsideFndCheckout('names the target and the repository holding it when there is no foundation checkout', () => {
    expect(() => getPathToFndFile('noir-projects/fnd/noir-protocol-circuits/crates/blob/src/blob.nr')).toThrow(
      /noir-projects\/fnd\/noir-protocol-circuits\/crates\/blob\/src\/blob\.nr[\s\S]*aztec-packages/,
    );
  });
});

/**
 * The fixtures these helpers rewrite are spread over two repositories, and a target that resolves into a directory
 * which does not exist only fails for whoever runs the regeneration by hand - never in CI, which does not set
 * AZTEC_GENERATE_TEST_DATA. Resolving every literal target keeps a moved or misrouted fixture a test failure.
 */
describe('test data targets', () => {
  interface Call {
    source: string;
    helper: string;
    target: string;
  }

  function collectSourceFiles(dir: string, found: string[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dest', 'target', 'artifacts'].includes(entry.name)) {
          collectSourceFiles(path, found);
        }
      } else if (entry.name.endsWith('.ts')) {
        found.push(path);
      }
    }
    return found;
  }

  const calls: Call[] = collectSourceFiles(join(repoRoot, 'yarn-project')).flatMap(path => {
    const contents = readFileSync(path, 'utf8');
    const pattern = /\b(updateInlineTestData|updateInlineFndTestData|writeTestData|readTestData)\(\s*'([^']+)'/g;
    return [...contents.matchAll(pattern)].map(([, helper, target]) => ({
      source: relative(repoRoot, path),
      helper,
      target,
    }));
  });

  function check(calls: Call[], resolveTarget: (target: string) => string) {
    return (
      calls
        .map(call => ({ ...call, path: resolveTarget(call.target) }))
        // Only the inline updates patch a file in place; the plain writes create theirs, and just need a directory.
        .filter(call => !existsSync(call.helper.startsWith('updateInline') ? call.path : dirname(call.path)))
        .map(call => `${call.target} (from ${call.source})`)
    );
  }

  it('are found in the sources', () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it('resolve to files committed in this repository', () => {
    expect(
      check(
        calls.filter(call => call.helper !== 'updateInlineFndTestData'),
        getPathToFile,
      ),
    ).toEqual([]);
  });

  itInFndCheckout('resolve to files committed in the foundation repository', () => {
    expect(
      check(
        calls.filter(call => call.helper === 'updateInlineFndTestData'),
        getPathToFndFile,
      ),
    ).toEqual([]);
  });
});
