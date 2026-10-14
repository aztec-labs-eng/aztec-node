import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { publishedWorkspaces } from './aztec-up-workspaces.mjs';

const buildVersion = '0.0.1';
const publicRegistry = 'https://registry.npmjs.org';

function releaseTarballUrl(resolved, name, version) {
  const url = new URL(resolved);
  assert.equal(url.origin, publicRegistry, 'Unexpected registry for ' + name);
  assert(!url.search && !url.hash, 'Unexpected tarball URL for ' + name);
  const packageFile = name.split('/').at(-1);
  const buildSuffix = '/-/' + packageFile + '-' + buildVersion + '.tgz';
  assert(url.pathname.endsWith(buildSuffix), 'Unexpected tarball URL for ' + name);
  assert.equal(
    decodeURIComponent(url.pathname.slice(1, -buildSuffix.length)),
    name,
    'Unexpected tarball package for ' + name,
  );
  url.pathname = url.pathname.slice(0, -buildSuffix.length) + '/-/' + packageFile + '-' + version + '.tgz';
  return url.href;
}

function rewriteDependencies(dependencies, workspaces, version) {
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    if (workspaces.has(name) && spec === buildVersion) dependencies[name] = version;
  }
}

export function rewriteReleaseLock(manifest, lock, workspaces, version) {
  assert(version && version !== buildVersion, 'Invalid release version: ' + version);
  assert.equal(manifest.version, buildVersion, 'Installer manifest is not from the build version');
  assert.equal(lock.version, buildVersion, 'Installer lock is not from the build version');
  assert.equal(lock.packages?.['']?.version, buildVersion, 'Installer lock root is not from the build version');
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'Installer lock and manifest disagree');

  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!workspaces.has(name)) continue;
    if (entry.version !== buildVersion) {
      assert(entry.integrity, 'Unexpected installer package ' + name + '@' + entry.version + ' without integrity');
      continue;
    }
    assert(!entry.integrity, 'Installer package ' + name + '@' + buildVersion + ' unexpectedly has integrity');
    releaseTarballUrl(entry.resolved, name, version);
  }

  manifest.version = version;
  rewriteDependencies(manifest.dependencies, workspaces, version);
  rewriteDependencies(manifest.overrides, workspaces, version);
  lock.version = version;
  lock.packages[''].version = version;
  rewriteDependencies(lock.packages[''].dependencies, workspaces, version);

  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!workspaces.has(name) || entry.version !== buildVersion) continue;
    entry.version = version;
    entry.resolved = releaseTarballUrl(entry.resolved, name, version);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      rewriteDependencies(entry[field], workspaces, version);
    }
  }
}

async function main() {
  const [source, archive, version, expectedHash, output] = process.argv.slice(2);
  assert(
    source && archive && version && expectedHash && output,
    'Usage: aztec-up-release-lock.mjs <yarn-project> <build-archive> <version> <inputs-hash> <output-directory>',
  );

  const archiveEntry = name => execFileSync('tar', ['-xzOf', archive, name], { encoding: 'utf8' });
  assert.equal(archiveEntry('lock-inputs-hash').trim(), expectedHash, 'Installer lock was built from different inputs');
  const manifest = JSON.parse(archiveEntry('package.json'));
  const lock = JSON.parse(archiveEntry('package-lock.json'));
  const { default: yaml } = await import('js-yaml');
  const yarnLock = yaml.load(await readFile(join(source, 'yarn.lock'), 'utf8'));
  const workspaces = publishedWorkspaces(source, yarnLock);
  rewriteReleaseLock(manifest, lock, workspaces, version);

  const directory = await mkdtemp(join(tmpdir(), 'aztec-up-release-lock-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    await mkdir(output, { recursive: true });
    execFileSync('tar', [
      '-czf',
      resolve(output, 'packages.tar.gz'),
      '-C',
      directory,
      'package.json',
      'package-lock.json',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
