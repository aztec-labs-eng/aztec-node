import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';

import { DefaultL1ContractsConfig } from './config.js';
import { RollupContract } from './contracts/rollup.js';
import {
  type DeployAztecL1ContractsArgs,
  type Operator,
  deployAztecL1Contracts,
  getForgeBroadcastArgs,
  getForgeBroadcastTimeout,
  getSlowBroadcastTimeout,
  prepareL1ContractsForDeployment,
  runProcess,
} from './deploy_aztec_l1_contracts.js';
import { resolveFoundryBinary } from './foundry_binary.js';
import { type Anvil, startAnvil } from './test/start_anvil.js';

describe('deployment directories', () => {
  it('isolates recovery state between deployments', () => {
    const first = prepareL1ContractsForDeployment();
    const second = prepareL1ContractsForDeployment();
    try {
      writeFileSync(join(first, 'cache', 'deployment.recovery.json'), 'first');
      writeFileSync(join(second, 'cache', 'deployment.recovery.json'), 'second');
      expect(readFileSync(join(first, 'cache', 'deployment.recovery.json'), 'utf8')).toBe('first');
      expect(readFileSync(join(second, 'cache', 'deployment.recovery.json'), 'utf8')).toBe('second');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

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

  it('gives a slow broadcast one block per transaction on top of the deadline', () => {
    expect(getSlowBroadcastTimeout(120_000, 33)).toBe(120_000 + 33 * 12_000);
    expect(getSlowBroadcastTimeout(undefined, 33)).toBeUndefined();
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

describe('initial validators', () => {
  const deployer = mnemonicToAccount('test test test test test test test test test test test junk', {
    addressIndex: 5,
  });
  const deployerPrivateKey = toHex(deployer.getHdKey().privateKey!);
  // Needs about 265k gas to verify its proof of possession, over the 250k a new GSE allows.
  const unstakeableBn254SecretKey = 57193n;

  let anvil: Anvil | undefined;

  afterEach(async () => {
    await anvil?.stop();
    anvil = undefined;
  });

  function makeValidators(bn254SecretKeys: bigint[]): Operator[] {
    return bn254SecretKeys.map((bn254SecretKey, index) => ({
      attester: EthAddress.fromString(`0x${(1000 + index).toString(16).padStart(40, '0')}`),
      withdrawer: EthAddress.fromString(`0x${(2000 + index).toString(16).padStart(40, '0')}`),
      bn254SecretKey: new SecretValue(bn254SecretKey),
    }));
  }

  async function deploy(overrides: Partial<DeployAztecL1ContractsArgs>) {
    const started = await startAnvil();
    anvil = started.anvil;
    const { l1ContractAddresses, l1Client } = await deployAztecL1Contracts(
      started.rpcUrl,
      deployerPrivateKey,
      foundry.id,
      {
        ...DefaultL1ContractsConfig,
        vkTreeRoot: Fr.random(),
        protocolContractsHash: Fr.random(),
        genesisArchiveRoot: Fr.random(),
        realVerifier: false,
        aztecTargetCommitteeSize: 2,
        ...overrides,
      },
    );
    return new RollupContract(l1Client, l1ContractAddresses.rollupAddress);
  }

  it('deploys when the entry queue admits only some initial validators in the first epoch', async () => {
    const rollup = await deploy({
      entryQueueBootstrapValidatorSetSize: 0,
      entryQueueBootstrapFlushSize: 0,
      entryQueueFlushSizeMin: 2,
      entryQueueFlushSizeQuotient: 2,
      entryQueueMaxFlushSize: 2,
      initialValidators: makeValidators([1n, 2n, 3n]),
    });

    expect(await rollup.getActiveAttesterCount()).toBe(2);
    expect(await rollup.getEntryQueueLength()).toBe(1);
  }, 300_000);

  it('fails when the entry queue flush drops an initial validator', async () => {
    await expect(deploy({ initialValidators: makeValidators([1n, unstakeableBn254SecretKey]) })).rejects.toThrow(
      /of 2 initial validators/,
    );
  }, 300_000);
});
