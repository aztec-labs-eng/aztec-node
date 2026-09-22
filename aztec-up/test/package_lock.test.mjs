import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let output = '';
    child.stdout.on('data', data => (output += data));
    child.stderr.on('data', data => (output += data));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

test('a clean installer keeps the approved dependency after a newer publication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aztec-up-lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packages = new Map();
  const tarballs = new Map();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.slice(1));
    const body = tarballs.get(path) ?? JSON.stringify(packages.get(path));
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}`;

  async function publish(name, version, dependencies = {}, peerDependencies = {}) {
    const path = join(dir, `${name.replaceAll('/', '-')}-${version}`);
    await mkdir(join(path, 'package'), { recursive: true });
    const manifest = { name, version, dependencies, peerDependencies, main: 'index.js' };
    await writeFile(join(path, 'package/package.json'), JSON.stringify(manifest));
    await writeFile(join(path, 'package/index.js'), `module.exports = '${version}';`);
    await run('tar', ['-czf', join(path, 'package.tgz'), '-C', path, 'package']);
    const tarball = `${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
    tarballs.set(tarball, await readFile(join(path, 'package.tgz')));
    const metadata = packages.get(name) ?? { name, versions: {}, 'dist-tags': {} };
    metadata.versions[version] = { ...manifest, dist: { tarball: `${registry}/${tarball}` } };
    metadata['dist-tags'].latest = version;
    packages.set(name, metadata);
  }

  await publish('upstream', '1.0.0');
  await publish('upstream', '1.0.1');
  await publish('leaf', '1.0.0');
  await publish('leaf', '1.1.0');
  await publish('peer-runtime', '1.0.0', { leaf: '^1.0.0' });
  await publish('consumer', '1.0.0', {}, { 'peer-runtime': '^1.0.0' });
  await publish('@aztec-labs/aztec', '0.0.1', { upstream: '^1.0.0', consumer: '^1.0.0' });
  await publish('@aztec-labs/cli-wallet', '0.0.1', {}, { '@aztec-labs/peer': '0.0.1' });
  await publish('@aztec-labs/peer', '0.0.1');
  const source = join(dir, 'source');
  await mkdir(source);
  await writeFile(join(source, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.13.0' }));
  await writeFile(
    join(source, 'yarn.lock'),
    `__metadata:
  version: 8
  cacheKey: 10
"@aztec-labs/peer@workspace:peer":
  version: 0.0.0-use.local
  resolution: "@aztec-labs/peer@workspace:peer"
  languageName: unknown
  linkType: soft
"@aztec-labs/cli-wallet@workspace:cli-wallet":
  version: 0.0.0-use.local
  resolution: "@aztec-labs/cli-wallet@workspace:cli-wallet"
  peerDependencies:
    "@aztec-labs/peer": "workspace:^"
  languageName: unknown
  linkType: soft
"leaf@npm:^1.0.0":
  version: 1.0.0
  resolution: "leaf@npm:1.0.0"
  languageName: node
  linkType: hard
"peer-runtime@npm:^1.0.0":
  version: 1.0.0
  resolution: "peer-runtime@npm:1.0.0"
  dependencies:
    leaf: "npm:^1.0.0"
  languageName: node
  linkType: hard
"consumer@npm:^1.0.0":
  version: 1.0.0
  resolution: "consumer@npm:1.0.0"
  peerDependencies:
    peer-runtime: "^1.0.0"
  languageName: node
  linkType: hard
"upstream@npm:^1.0.0":
  version: 1.0.0
  resolution: "upstream@npm:1.0.0"
  languageName: node
  linkType: hard
`,
  );
  const approvedLock = await readFile(join(source, 'yarn.lock'));
  const assets = join(dir, 'assets/0.0.1');
  await mkdir(assets, { recursive: true });
  const env = {
    ...process.env,
    npm_config_registry: registry,
    npm_config_cache: join(dir, 'npm-cache'),
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    YARN_ENABLE_TELEMETRY: '0',
  };
  await run(process.execPath, [join(root, 'scripts/generate-package-lock.mjs'), source, '0.0.1', assets], { env });
  await publish('upstream', '1.1.0');

  const installer = await readFile(join(root, 'bin/0.0.1/install'), 'utf8');
  const installPackages = installer.match(/function install_aztec_packages \{[\s\S]*?\n\}/)[0];
  const destination = join(dir, 'installed');
  await mkdir(destination);
  const install = () =>
    run('bash', ['-e', '-c', `${installPackages}\ninstall_aztec_packages`], {
      env: { ...env, VERSION: '0.0.1', INSTALL_URI: `file://${join(dir, 'assets')}`, version_path: destination },
    });
  await install();
  assert.equal(JSON.parse(await readFile(join(destination, 'node_modules/upstream/package.json'))).version, '1.0.0');

  assert.equal(
    JSON.parse(await readFile(join(destination, 'node_modules/@aztec-labs/peer/package.json'))).version,
    '0.0.1',
  );

  assert.equal(JSON.parse(await readFile(join(destination, 'node_modules/leaf/package.json'))).version, '1.0.0');

  await t.test('an unapproved resolution prevents publishing an artifact', async () => {
    await writeFile(
      join(source, 'yarn.lock'),
      approvedLock.toString().replace(/\"upstream@npm:\^1\.0\.0\":[\s\S]*$/, ''),
    );
    const rejected = join(dir, 'rejected');
    await assert.rejects(
      run(process.execPath, [join(root, 'scripts/generate-package-lock.mjs'), source, '0.0.1', rejected], { env }),
      /Unapproved release dependency: upstream@npm:1.1.0/,
    );
    await assert.rejects(readFile(join(rejected, 'packages.tar.gz')), { code: 'ENOENT' });
    await writeFile(join(source, 'yarn.lock'), approvedLock);
  });

  await t.test('a manifest inconsistent with the lock fails installation', async () => {
    const broken = join(dir, 'broken');
    await mkdir(broken);
    await run('tar', ['-xzf', join(assets, 'packages.tar.gz'), '-C', broken]);
    const manifestPath = join(broken, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath));
    manifest.dependencies.upstream = '1.1.0';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await run('tar', ['-czf', join(assets, 'packages.tar.gz'), '-C', broken, '.']);
    await assert.rejects(install(), /lockfile would have been modified/);
  });

  await t.test('a missing release artifact fails even with an existing install', async () => {
    await rm(join(assets, 'packages.tar.gz'));
    await assert.rejects(install(), /curl/);
  });
});
