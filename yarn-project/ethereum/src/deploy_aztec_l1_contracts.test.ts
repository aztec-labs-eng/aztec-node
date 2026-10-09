import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foundry, sepolia } from 'viem/chains';

import {
  getForgeBroadcastArgs,
  getForgeBroadcastTimeout,
  prepareL1ContractsForDeployment,
  runProcess,
} from './deploy_aztec_l1_contracts.js';
import { resolveFoundryBinary } from './foundry_binary.js';

describe('Forge broadcast options', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-options-'));

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('disables external identification on Anvil without reading artifact configuration', () => {
    expect(getForgeBroadcastArgs(directory, foundry.id)).toEqual(['--broadcast', '--disable-external-identification']);
  });

  it('uses the artifact EVM target and skips simulation on Sepolia', () => {
    writeFileSync(join(directory, 'foundry.toml'), '[profile.default]\nevm_version = "prague"\n');
    expect(getForgeBroadcastArgs(directory, sepolia.id)).toEqual([
      '--broadcast',
      '--disable-external-identification',
      '--hardfork',
      'prague',
      '--skip-simulation',
    ]);
  });

  it('rejects a missing artifact EVM target on Sepolia', () => {
    writeFileSync(join(directory, 'foundry.toml'), '[profile.default]\n');
    expect(() => getForgeBroadcastArgs(directory, sepolia.id)).toThrow('do not specify an EVM version');
  });

  it('limits Anvil broadcasts but leaves public broadcasts without a default deadline', () => {
    expect(getForgeBroadcastTimeout(foundry.id, undefined)).toBe(120_000);
    expect(getForgeBroadcastTimeout(sepolia.id, undefined)).toBeUndefined();
    expect(getForgeBroadcastTimeout(sepolia.id, '500')).toBe(500);
    expect(getForgeBroadcastTimeout(foundry.id, '0')).toBeUndefined();
  });

  it.each(['-1', 'NaN', 'Infinity'])('rejects invalid timeout %s before broadcasting', value => {
    expect(() => getForgeBroadcastTimeout(sepolia.id, value)).toThrow('FORGE_BROADCAST_TIMEOUT_MS');
  });
});

describe('deployment directory', () => {
  it('reuses the compiled L1 contracts shipped in l1-artifacts', () => {
    const deployDir = prepareL1ContractsForDeployment();
    const { status, stdout, stderr } = spawnSync(resolveFoundryBinary('forge'), ['build'], {
      cwd: deployDir,
      encoding: 'utf-8',
    });
    expect({ status, output: stdout + stderr }).toEqual({
      status: 0,
      output: expect.stringContaining('No files changed, compilation skipped'),
    });
  });
});

describe('deployment process', () => {
  it('parses deployment results', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'console.log(\'JSON DEPLOY RESULT: {"value":42}\')'], {}, tmpdir()),
    ).resolves.toEqual({ value: 42 });
  });

  it('reports nonzero exit codes', async () => {
    await expect(runProcess(process.execPath, ['-e', 'process.exit(7)'], {}, tmpdir(), 500)).rejects.toThrow(
      'exited with code 7',
    );
  });

  it('rejects malformed deployment results', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'console.log("JSON DEPLOY RESULT: invalid")'], {}, tmpdir(), 500),
    ).rejects.toThrow('Failed to parse deploy result JSON');
  });

  it('reports spawn failures', async () => {
    await expect(runProcess('/nonexistent/forge', [], {}, tmpdir(), 500)).rejects.toThrow('Failed to spawn');
  });

  it('reports a timeout', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, tmpdir(), 500),
    ).rejects.toThrow('timed out after 500ms');
  });

  it('kills a process that ignores SIGTERM', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {},
        tmpdir(),
        500,
      ),
    ).rejects.toThrow('timed out after 500ms (signal SIGKILL)');
  }, 5000);

  it('reports termination signals separately from exit codes', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], {}, tmpdir()),
    ).rejects.toThrow('terminated by signal SIGTERM');
  });
});
