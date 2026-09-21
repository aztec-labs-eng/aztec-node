import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';

import { createConsoleLogger } from '../log/console.js';
import { getPathToFile, getPathToFndFile } from '../testing/files/index.js';

const HELPERS = ['updateInlineTestData', 'updateInlineFndTestData', 'writeTestData', 'readTestData'] as const;

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

function collectCalls(repoRoot: string): Call[] {
  const pattern = new RegExp(String.raw`\b(${HELPERS.join('|')})\(\s*'([^']+)'`, 'g');
  return collectSourceFiles(join(repoRoot, 'yarn-project')).flatMap(path => {
    const contents = readFileSync(path, 'utf8');
    return [...contents.matchAll(pattern)].map(([, helper, target]) => ({
      source: relative(repoRoot, path),
      helper,
      target,
    }));
  });
}

/**
 * Verifies that every fixture the test data helpers rewrite resolves onto a path that exists.
 *
 * Nothing sets AZTEC_GENERATE_TEST_DATA in CI, so a target left pointing at a file that moved between the two
 * repositories these fixtures are spread over only fails for whoever regenerates it by hand, with no hint that a
 * repository boundary is the cause. The foundation targets can only be checked from a checkout that has this
 * repository as its `labs` submodule, since that is the only place they exist.
 */
function assertTestDataTargetsResolve(): void {
  const repoRoot = getPathToFile('');
  const calls = collectCalls(repoRoot);
  if (calls.length === 0) {
    throw new Error(`Found no test data targets under ${join(repoRoot, 'yarn-project')}`);
  }

  const inFndCheckout = existsSync(join(repoRoot, '..', 'noir-projects/fnd'));
  const checked = calls.filter(call => call.helper !== 'updateInlineFndTestData' || inFndCheckout);
  const unresolved = checked
    .map(call => ({
      ...call,
      // Only the inline updates patch a file in place; the plain writes create theirs, and just need a directory.
      path: call.helper === 'updateInlineFndTestData' ? getPathToFndFile(call.target) : getPathToFile(call.target),
    }))
    .filter(call => !existsSync(call.helper.startsWith('updateInline') ? call.path : dirname(call.path)))
    .map(call => `  ${call.target}\n    from ${call.source}\n    resolved to ${call.path}`);

  if (unresolved.length > 0) {
    throw new Error(`Test data targets that do not exist:\n${unresolved.join('\n')}`);
  }

  const skipped = calls.length - checked.length;
  const logger = createConsoleLogger('aztec:foundation:check_test_data_targets');
  logger(
    `Checked ${checked.length} test data targets` +
      (skipped > 0 ? `, skipped ${skipped} committed in the foundation repository (not a checkout of it)` : ''),
  );
}

assertTestDataTargetsResolve();
