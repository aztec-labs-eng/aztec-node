import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(new URL('../../yarn-project/end-to-end/package.json', import.meta.url));
const yaml = require('js-yaml');
const semver = createRequire(new URL('../../yarn-project/cli/package.json', import.meta.url))('semver');
const [source, version, output] = process.argv.slice(2);
assert(source && version && output, 'Usage: generate-package-lock.mjs <yarn-project> <version> <output-directory>');
const manifest = JSON.parse(await readFile(join(source, 'package.json')));
const original = yaml.load(await readFile(join(source, 'yarn.lock'), 'utf8'));
const yarnVersion = manifest.packageManager.match(/^yarn@(\d+\.\d+\.\d+)$/)?.[1];
assert(yarnVersion, 'Expected an exact Yarn version');
const approved = new Map();
const workspaces = new Set(['@aztec-labs/aztec', '@aztec-labs/cli-wallet']);
const seed = { __metadata: original.__metadata };
for (const [descriptor, entry] of Object.entries(original)) {
  if (descriptor === '__metadata') continue;
  if (entry.resolution.includes('@workspace:')) {
    workspaces.add(entry.resolution.split('@workspace:')[0]);
  } else {
    const descriptors = new Set(descriptor.split(', '));
    if (/^[^:]+@npm:[^:]+$/.test(entry.resolution)) descriptors.add(entry.resolution);
    seed[[...descriptors].join(', ')] = entry;
    approved.set(entry.resolution, entry);
  }
}

// Yarn does not auto-install peers like npm. Keep workspace CLI peers available in the standalone toolchain.
const packageExtensions = {};
for (const entry of Object.values(original)) {
  if (!entry.resolution?.includes('@workspace:') || !entry.peerDependencies) continue;
  const dependencies = {};
  for (const [name, range] of Object.entries(entry.peerDependencies)) {
    if (entry.peerDependenciesMeta?.[name]?.optional) continue;
    dependencies[name] = manifest.resolutions?.[name] ?? (workspaces.has(name) ? version : range);
  }
  packageExtensions[`${entry.resolution.split('@workspace:')[0]}@*`] = { dependencies };
}

const directory = await mkdtemp(join(tmpdir(), 'aztec-up-packages-'));
try {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'aztec-up-toolchain',
        private: true,
        packageManager: manifest.packageManager,
        dependencies: { '@aztec-labs/aztec': version, '@aztec-labs/cli-wallet': version },
        resolutions: manifest.resolutions ?? {},
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(directory, 'yarn.lock'), yaml.dump(seed, { lineWidth: -1, noRefs: true }));
  await mkdir(join(directory, '.yarn/patches'), { recursive: true });
  try {
    await cp(join(source, '.yarn/patches'), join(directory, '.yarn/patches'), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const registry = process.env.npm_config_registry ?? 'https://registry.npmjs.org';
  await writeFile(
    join(directory, '.yarnrc.yml'),
    yaml.dump({
      nodeLinker: 'node-modules',
      compressionLevel: 'mixed',
      enableGlobalCache: false,
      globalFolder: '.yarn/global',
      enableTelemetry: false,
      npmRegistryServer: registry,
      packageExtensions,
      ...(registry.startsWith('http:') ? { unsafeHttpWhitelist: [new URL(registry).hostname] } : {}),
    }),
  );
  execFileSync(
    'curl',
    [
      '-fsSL',
      `https://repo.yarnpkg.com/${yarnVersion}/packages/yarnpkg-cli/bin/yarn.js`,
      '-o',
      join(directory, 'yarn.cjs'),
    ],
    { stdio: 'inherit' },
  );
  const env = { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', YARN_IGNORE_PATH: '1' };
  execFileSync(process.execPath, ['yarn.cjs', 'install', '--mode=update-lockfile'], {
    cwd: directory,
    env,
    stdio: 'inherit',
  });
  let generated;
  while (true) {
    generated = yaml.load(await readFile(join(directory, 'yarn.lock'), 'utf8'));
    let changed = false;
    for (const entry of Object.values(generated)) {
      if (!entry.peerDependencies || !entry.resolution.includes('@npm:')) continue;
      const name = entry.resolution.slice(0, entry.resolution.lastIndexOf('@npm:'));
      if (workspaces.has(name)) continue;
      for (const [peer, range] of Object.entries(entry.peerDependencies)) {
        if (entry.peerDependenciesMeta?.[peer]?.optional || entry.dependencies?.[peer]) continue;
        const candidates = [...approved.values()].filter(
          candidate =>
            candidate.resolution === `${peer}@npm:${candidate.version}` && semver.satisfies(candidate.version, range),
        );
        candidates.sort((a, b) => semver.rcompare(a.version, b.version));
        assert(
          candidates.length,
          `No approved version satisfies peer ${peer}@${range} required by ${entry.resolution}`,
        );
        const extension = (packageExtensions[`${name}@${entry.version}`] ??= { dependencies: {} });
        if (!extension.dependencies[peer]) {
          extension.dependencies[peer] = candidates[0].version;
          changed = true;
        }
      }
    }
    if (!changed) break;
    const configuration = yaml.load(await readFile(join(directory, '.yarnrc.yml'), 'utf8'));
    configuration.packageExtensions = packageExtensions;
    await writeFile(join(directory, '.yarnrc.yml'), yaml.dump(configuration));
    // Restore pruned entries so newly included peers cannot float their transitive dependencies.
    await writeFile(
      join(directory, 'yarn.lock'),
      yaml.dump({ ...seed, ...generated }, { lineWidth: -1, noRefs: true }),
    );
    execFileSync(process.execPath, ['yarn.cjs', 'install', '--mode=update-lockfile'], {
      cwd: directory,
      env,
      stdio: 'inherit',
    });
  }
  for (const [descriptor, entry] of Object.entries(generated)) {
    if (descriptor === '__metadata' || entry.resolution === 'aztec-up-toolchain@workspace:.') continue;
    const name = entry.resolution.slice(0, entry.resolution.lastIndexOf('@npm:'));
    if (workspaces.has(name) && entry.resolution === `${name}@npm:${version}`) continue;
    const expected = approved.get(entry.resolution);
    assert(expected, `Unapproved release dependency: ${entry.resolution}. Update the monorepo lock first.`);
    if (expected.checksum) assert.equal(entry.checksum, expected.checksum, `Checksum changed: ${entry.resolution}`);
  }
  execFileSync(process.execPath, ['yarn.cjs', 'install', '--immutable', '--mode=skip-build'], {
    cwd: directory,
    env,
    stdio: 'inherit',
  });
  await mkdir(output, { recursive: true });
  execFileSync('tar', [
    '-czf',
    resolve(output, 'packages.tar.gz'),
    '-C',
    directory,
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    'yarn.cjs',
    '.yarn/patches',
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
