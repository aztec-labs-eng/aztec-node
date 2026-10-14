import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Names of the workspaces ci3/deploy_npm publishes: every workspace in yarn.lock except the private ones, which
 * deploy_npm skips and so never appear in the installer's dependency tree.
 */
export function publishedWorkspaces(source, yarnLock) {
  const published = new Set();
  for (const entry of Object.values(yarnLock)) {
    if (!entry.resolution?.includes('@workspace:')) continue;
    const [name, path] = entry.resolution.split('@workspace:');
    const { private: isPrivate } = JSON.parse(readFileSync(join(source, path, 'package.json'), 'utf8'));
    if (!isPrivate) published.add(name);
  }
  return published;
}
