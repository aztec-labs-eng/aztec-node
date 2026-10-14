/**
 * Generates the npm manifest and lock that aztec-up installs a release from, and writes them to
 * <output-directory>/packages.tar.gz.
 *
 * npm must point at a registry that holds every public workspace at <version>, as published by ci3/deploy_npm, and that
 * proxies everything else to npmjs. aztec-up/bootstrap.sh runs a local verdaccio for this, so a release has its lock
 * before anything reaches npmjs. The published manifests already carry ci3/release_prep_package_json's rewrites, so
 * first-party versions come from them rather than from rules repeated here.
 *
 * Third-party versions are limited to the ones yarn-project/yarn.lock resolves: npm reads them as a Yarn Classic lock
 * hint, and any version outside that set fails the generation. Peer dependencies npm would not install are added to the
 * root manifest until none are missing.
 *
 * The written lock points every tarball at registry.npmjs.org, which npm by default replaces with the configured
 * registry. It omits the integrity of the release's own packages: their npmjs tarballs do not exist when the lock is
 * made, npm never lets a published version change, and `npm ci` installs a registry entry without integrity while still
 * checking every other entry.
 */
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import semver from 'semver';

const [source, version, output] = process.argv.slice(2);
assert(
  source && version && output,
  'Usage: generate-aztec-up-package-lock.mjs <yarn-project> <version> <output-directory>',
);

const manifest = JSON.parse(await readFile(join(source, 'package.json')));
const yarnLock = yaml.load(await readFile(join(source, 'yarn.lock'), 'utf8'));
const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
const publicRegistry = 'https://registry.npmjs.org';
// The scopes ci3/release_prep_package_json rewrites.
const firstPartyScopes = ['@aztec/', '@aztec-labs/', '@aztec-foundation/'];
const approved = new Map();
const workspaces = new Set();
let classicLock = '# yarn lockfile v1\n\n';

for (const [descriptors, entry] of Object.entries(yarnLock)) {
  if (!entry.resolution) continue;
  if (entry.resolution.includes('@workspace:')) {
    workspaces.add(entry.resolution.split('@workspace:')[0]);
    continue;
  }
  const protocol = entry.resolution.includes('@npm:') ? '@npm:' : '@patch:';
  const name = entry.resolution.split(protocol)[0];
  if (!approved.has(name)) approved.set(name, new Set());
  approved.get(name).add(entry.version);
  if (protocol !== '@npm:') continue;

  const tarball = `${registry}/${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz`;
  for (const descriptor of descriptors.split(', ')) {
    if (!descriptor.includes('@npm:')) continue;
    const reference = descriptor.slice(descriptor.indexOf('@npm:') + '@npm:'.length);
    const alias = /^(@[^/]+\/[^@]+|[^@]+)@/.test(reference);
    const request = alias ? descriptor : descriptor.replace('@npm:', '@');
    classicLock += `${JSON.stringify(request)}:\n  version ${JSON.stringify(entry.version)}\n  resolved ${JSON.stringify(tarball)}\n\n`;
  }
}

function approvedVersion(name, range) {
  const versions = [...(approved.get(name) ?? [])].filter(candidate => semver.satisfies(candidate, range));
  versions.sort(semver.rcompare);
  assert(versions.length, `No approved version satisfies ${name}@${range}`);
  return versions[0];
}

function peerVersion(name, range) {
  const pinned = manifest.resolutions?.[name];
  if (!firstPartyScopes.some(scope => name.startsWith(scope))) return pinned ?? approvedVersion(name, range);
  // Our published manifests already apply the root resolutions; a peer declared by another publisher gets the same pin.
  return pinned && semver.valid(pinned) ? pinned : range;
}

const dependencies = {
  '@aztec-labs/aztec': version,
  '@aztec-labs/cli-wallet': version,
};
const overrides = Object.fromEntries(
  Object.entries(manifest.resolutions ?? {}).filter(
    ([name, range]) => !name.includes('@npm:') && !range.startsWith('patch:'),
  ),
);

const directory = await mkdtemp(join(tmpdir(), 'aztec-up-packages-'));
try {
  const packagePath = join(directory, 'package.json');
  const lockPath = join(directory, 'package-lock.json');
  const seedPath = join(directory, 'yarn.lock');
  function npm(...args) {
    execFileSync('npm', args, { cwd: directory, stdio: 'inherit' });
  }
  function writeManifest() {
    return writeFile(
      packagePath,
      JSON.stringify(
        {
          name: 'aztec-up-toolchain',
          private: true,
          version,
          dependencies,
          overrides,
        },
        null,
        2,
      ) + '\n',
    );
  }

  // npm can use a Yarn Classic lock as a resolution hint; it cannot use Yarn 4's format.
  const maxPeerDiscoveryPasses = 20; // In practice it settled in 3
  for (let pass = 1; pass <= maxPeerDiscoveryPasses; pass++) {
    await writeManifest();
    await writeFile(seedPath, classicLock);
    await rm(lockPath, { force: true });
    npm(
      'install',
      '--package-lock-only',
      '--prefer-online',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    );
    const generated = JSON.parse(await readFile(lockPath));
    let changed = false;
    for (const entry of Object.values(generated.packages)) {
      for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
        if (entry.peerDependenciesMeta?.[name]?.optional || dependencies[name]) continue;
        dependencies[name] = peerVersion(name, range);
        changed = true;
      }
    }
    if (!changed) break;
    assert(
      pass < maxPeerDiscoveryPasses,
      `Peer dependency discovery did not converge after ${maxPeerDiscoveryPasses} passes`,
    );
  }

  // npm 11.6 rejects shared dependencies of separately overridden parents, even for no-op overrides.
  const discovered = JSON.parse(await readFile(lockPath));
  for (const [name, spec] of Object.entries(overrides)) {
    if (!semver.valid(spec)) continue;
    const requests = Object.values(discovered.packages).flatMap(entry =>
      [entry.dependencies?.[name], entry.optionalDependencies?.[name], entry.peerDependencies?.[name]].filter(
        request => request !== undefined,
      ),
    );
    if (requests.length && requests.every(request => request === spec)) delete overrides[name];
  }

  // Validate the lock works
  await writeManifest();
  await writeFile(seedPath, classicLock);
  await rm(lockPath, { force: true });
  npm(
    'install',
    '--package-lock-only',
    '--prefer-online',
    '--ignore-scripts',
    '--legacy-peer-deps=false',
    '--no-audit',
    '--no-fund',
  );
  const generated = JSON.parse(await readFile(lockPath));
  for (const [path, entry] of Object.entries(generated.packages)) {
    if (!path || !entry.version) continue;
    const installedName = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    assert(entry.resolved && entry.integrity, `Missing tarball or integrity for ${path}`);
    if (entry.resolved.startsWith(`${registry}/`)) {
      entry.resolved = publicRegistry + entry.resolved.slice(registry.length);
    }
    if (workspaces.has(installedName) && entry.version === version) {
      delete entry.integrity;
      continue;
    }
    const match = new URL(entry.resolved).pathname.match(/^\/(.+)\/-\//);
    assert(match, `Unexpected tarball URL for ${path}: ${entry.resolved}`);
    const packageName = decodeURIComponent(match[1]);
    assert(
      approved.get(packageName)?.has(entry.version),
      `Unapproved release dependency: ${packageName}@${entry.version}. Update the monorepo lock first.`,
    );
  }
  await writeFile(lockPath, JSON.stringify(generated, null, 2) + '\n');

  // Installs the lock as users will: npm swaps registry.npmjs.org for the configured registry.
  await rm(seedPath);
  const before = await readFile(lockPath);
  npm('ci', '--ignore-scripts', '--legacy-peer-deps=false', '--no-audit', '--no-fund');
  assert((await readFile(lockPath)).equals(before), 'npm ci changed the release lock');
  execFileSync('npm', ['ls', '--all', '--parseable'], {
    cwd: directory,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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
