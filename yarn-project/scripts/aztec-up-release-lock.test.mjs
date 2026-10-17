import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rewriteReleaseLock } from './aztec-up-release-lock.mjs';
import { publishedWorkspaces } from './aztec-up-workspaces.mjs';

function installerLock() {
  const manifest = {
    name: 'aztec-up-toolchain',
    private: true,
    version: '0.0.1',
    dependencies: { '@aztec-labs/aztec': '0.0.1' },
    overrides: { '@aztec-foundation/bb.js': '6.0.0-rc.1' },
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: { ...manifest.dependencies } },
      'node_modules/@aztec-labs/aztec': {
        version: '0.0.1',
        resolved: 'https://registry.npmjs.org/@aztec-labs/aztec/-/aztec-0.0.1.tgz',
        dependencies: { '@aztec-labs/stdlib': '0.0.1', '@aztec-foundation/bb.js': '6.0.0-rc.1' },
        peerDependencies: { '@aztec-labs/stdlib': '0.0.1' },
      },
      'node_modules/@aztec-labs/stdlib': {
        version: '0.0.1',
        resolved: 'https://registry.npmjs.org/@aztec-labs/stdlib/-/stdlib-0.0.1.tgz',
        optionalDependencies: { '@aztec-labs/native': '0.0.1' },
      },
      'node_modules/@aztec-labs/native': {
        version: '0.0.1',
        resolved: 'https://registry.npmjs.org/@aztec-labs/native/-/native-0.0.1.tgz',
      },
      'node_modules/@aztec-foundation/bb.js': {
        version: '6.0.0-rc.1',
        resolved: 'https://registry.npmjs.org/@aztec-foundation/bb.js/-/bb.js-6.0.0-rc.1.tgz',
        integrity: 'sha512-pinned',
      },
    },
  };
  return { manifest, lock };
}

test('rewrites only release packages and their workspace references', () => {
  const { manifest, lock } = installerLock();
  const thirdParty = structuredClone(lock.packages['node_modules/@aztec-foundation/bb.js']);

  rewriteReleaseLock(
    manifest,
    lock,
    new Set(['@aztec-labs/aztec', '@aztec-labs/stdlib', '@aztec-labs/native']),
    '6.1.0',
  );

  assert.equal(manifest.version, '6.1.0');
  assert.equal(manifest.dependencies['@aztec-labs/aztec'], '6.1.0');
  assert.equal(lock.packages[''].version, '6.1.0');
  assert.equal(lock.packages['node_modules/@aztec-labs/aztec'].dependencies['@aztec-labs/stdlib'], '6.1.0');
  assert.equal(lock.packages['node_modules/@aztec-labs/aztec'].peerDependencies['@aztec-labs/stdlib'], '6.1.0');
  assert.equal(lock.packages['node_modules/@aztec-labs/stdlib'].optionalDependencies['@aztec-labs/native'], '6.1.0');
  assert.equal(
    lock.packages['node_modules/@aztec-labs/aztec'].resolved,
    'https://registry.npmjs.org/@aztec-labs/aztec/-/aztec-6.1.0.tgz',
  );
  assert.deepEqual(lock.packages['node_modules/@aztec-foundation/bb.js'], thirdParty);
});

test('rejects a first-party lock entry that is not the build version', () => {
  const { manifest, lock } = installerLock();
  lock.packages['node_modules/@aztec-labs/stdlib'].version = '0.0.2';

  assert.throws(
    () => rewriteReleaseLock(manifest, lock, new Set(['@aztec-labs/aztec', '@aztec-labs/stdlib']), '6.1.0'),
    /@aztec-labs\/stdlib.*0\.0\.2/,
  );
});

test('creates a release archive from a matching build lock without npm', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aztec-up-lock-test-'));
  try {
    const source = join(directory, 'source');
    const build = join(directory, 'build');
    const output = join(directory, 'output');
    await mkdir(source);
    await mkdir(build);
    for (const [path, isPrivate] of [['aztec', false], ['stdlib', false], ['native', false], ['internal', true]]) {
      await mkdir(join(source, path));
      await writeFile(join(source, path, 'package.json'), JSON.stringify({ private: isPrivate }));
    }
    await writeFile(
      join(source, 'yarn.lock'),
      JSON.stringify({
        '@aztec-labs/aztec@workspace:aztec': { resolution: '@aztec-labs/aztec@workspace:aztec' },
        '@aztec-labs/stdlib@workspace:stdlib': { resolution: '@aztec-labs/stdlib@workspace:stdlib' },
        '@aztec-labs/native@workspace:native': { resolution: '@aztec-labs/native@workspace:native' },
        '@aztec-labs/internal@workspace:internal': { resolution: '@aztec-labs/internal@workspace:internal' },
      }),
    );
    const { manifest, lock } = installerLock();
    await writeFile(join(build, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(build, 'package-lock.json'), JSON.stringify(lock));
    await writeFile(join(build, 'lock-inputs-hash'), 'current-inputs\n');
    const archive = join(directory, 'build.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', build, 'package.json', 'package-lock.json', 'lock-inputs-hash']);

    const script = fileURLToPath(new URL('./aztec-up-release-lock.mjs', import.meta.url));
    execFileSync(process.execPath, [script, source, archive, '6.1.0', 'current-inputs', output]);
    const releaseArchive = join(output, 'packages.tar.gz');
    const releasedManifest = JSON.parse(
      execFileSync('tar', ['-xzOf', releaseArchive, 'package.json'], { encoding: 'utf8' }),
    );
    const releasedLock = JSON.parse(
      execFileSync('tar', ['-xzOf', releaseArchive, 'package-lock.json'], { encoding: 'utf8' }),
    );
    assert.equal(releasedManifest.dependencies['@aztec-labs/aztec'], '6.1.0');
    assert.equal(releasedLock.packages['node_modules/@aztec-labs/aztec'].version, '6.1.0');
    assert.equal(releasedLock.packages['node_modules/@aztec-foundation/bb.js'].integrity, 'sha512-pinned');

    assert.deepEqual(
      publishedWorkspaces(source, JSON.parse(await readFile(join(source, 'yarn.lock'), 'utf8'))),
      new Set(['@aztec-labs/aztec', '@aztec-labs/stdlib', '@aztec-labs/native']),
    );

    assert.throws(
      () =>
        execFileSync(process.execPath, [script, source, archive, '6.1.0', 'stale-inputs', output], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      error => error.stderr.toString().includes('Installer lock was built from different inputs'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rewrites an encoded scoped tarball URL', () => {
  const { manifest, lock } = installerLock();
  lock.packages['node_modules/@aztec-labs/aztec'].resolved =
    'https://registry.npmjs.org/@aztec-labs%2faztec/-/aztec-0.0.1.tgz';

  rewriteReleaseLock(manifest, lock, new Set(['@aztec-labs/aztec']), '6.1.0');

  assert.equal(
    lock.packages['node_modules/@aztec-labs/aztec'].resolved,
    'https://registry.npmjs.org/@aztec-labs%2faztec/-/aztec-6.1.0.tgz',
  );
});
