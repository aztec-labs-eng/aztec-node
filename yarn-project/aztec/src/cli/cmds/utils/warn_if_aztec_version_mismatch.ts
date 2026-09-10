import type { LogFn } from '@aztec-labs/foundation/log';
import { DEV_VERSION, getPackageVersion } from '@aztec-labs/stdlib/update-checker';
import TOML from '@iarna/toml';
import { readFile } from 'fs/promises';
import { join } from 'path';

import { collectCrateDirs } from './collect_crate_dirs.js';

const AZTEC_NR_REPO = 'aztec-labs-eng/aztec-nr';
// Where aztec-nr was published before it moved to the labs organisation. Its tags stop at v5, so a
// project still pointing there cannot be fixed by bumping the tag alone.
const PREVIOUS_AZTEC_NR_REPO = 'AztecProtocol/aztec-nr';

/** Returns the `owner/name` of a github.com git URL, or undefined for anything else. */
function githubRepoOf(gitUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com') {
    return undefined;
  }
  return url.pathname
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/**
 * Warns if any aztec-nr git dependency in a crate's Nargo.toml has a tag that doesn't match the CLI version, or still
 * points at the repository aztec-nr was published from before it moved.
 */
export async function warnIfAztecVersionMismatch(log: LogFn, cliVersion?: string): Promise<void> {
  const version = cliVersion ?? getPackageVersion();
  if (version === DEV_VERSION) {
    return;
  }

  const expectedTag = `v${version}`;
  const mismatches: { file: string; depName: string; tag: string }[] = [];
  const movedRepoDeps: { file: string; depName: string }[] = [];

  const crateDirs = await collectCrateDirs('.', { skipGitDeps: true });

  for (const dir of crateDirs) {
    const tomlPath = join(dir, 'Nargo.toml');
    let content: string;
    try {
      content = await readFile(tomlPath, 'utf-8');
    } catch {
      continue;
    }

    const parsed = TOML.parse(content) as Record<string, any>;
    const deps = (parsed.dependencies as Record<string, any>) ?? {};

    for (const [depName, dep] of Object.entries(deps)) {
      // Skip non-object deps (e.g. malformed entries) and anything that isn't a tagged git dep.
      if (!dep || typeof dep !== 'object' || typeof dep.git !== 'string' || typeof dep.tag !== 'string') {
        continue;
      }
      const repo = githubRepoOf(dep.git);
      if (repo === PREVIOUS_AZTEC_NR_REPO) {
        movedRepoDeps.push({ file: tomlPath, depName });
      } else if (repo === AZTEC_NR_REPO && dep.tag !== expectedTag) {
        mismatches.push({ file: tomlPath, depName, tag: dep.tag });
      }
    }
  }

  if (movedRepoDeps.length > 0) {
    const details = movedRepoDeps.map(m => `  ${m.file} — ${m.depName}`).join('\n');
    log(
      `WARNING: aztec-nr has moved to https://github.com/${AZTEC_NR_REPO}.\n` +
        `The following dependencies still point at https://github.com/${PREVIOUS_AZTEC_NR_REPO}, which has no tags ` +
        `for this version of Aztec:\n` +
        `${details}\n\n` +
        `Change their \`git\` field to "https://github.com/${AZTEC_NR_REPO}" and their \`tag\` to "${expectedTag}".`,
    );
  }

  if (mismatches.length > 0) {
    const details = mismatches.map(m => `  ${m.file} — ${m.depName} (${m.tag})`).join('\n');
    log(
      `WARNING: Aztec dependency version mismatch detected.\n` +
        `The following aztec-nr dependencies do not match the CLI version (${expectedTag}):\n` +
        `${details}\n\n` +
        `See https://docs.aztec.network/errors/9 for how to update your dependencies.`,
    );
  }
}
