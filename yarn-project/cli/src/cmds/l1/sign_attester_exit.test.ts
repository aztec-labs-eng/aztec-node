import { getPublicClient } from '@aztec-labs/ethereum/client';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { jest } from '@jest/globals';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { injectCommands } from './index.js';
import { readAttesterExitAuthorizations, signAttesterExit } from './update_l1_validators.js';

const privateKey = `0x${'01'.repeat(32)}` as const;
const secondPrivateKey = `0x${'02'.repeat(32)}` as const;
const attester = privateKeyToAccount(privateKey);
// January 1, 2100 (Unix seconds), so the test authorization stays valid as time passes.
const deadline = 4102444800n;
const rollupAddress = EthAddress.fromString('0x1234567890123456789012345678901234567890');
const args = {
  rpcUrls: ['http://127.0.0.1:1'],
  chainId: 31337,
  privateKey,
  attesterAddress: EthAddress.fromString(attester.address),
  rollupAddress,
  deadline,
  log: () => {},
};

describe('sign-attester-exit', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sign-attester-exit-'));
    jest
      .spyOn(RollupContract.prototype, 'createAttesterExitAuthorization')
      .mockImplementation((attester, deadline) =>
        Promise.resolve({ attester, deadline, signature: Signature.random().toViemSignature() }),
      );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [{ privateKey: undefined, mnemonic: undefined }, 'Provide either a private key or a mnemonic'],
    [
      { privateKey, mnemonic: 'test test test test test test test test test test test junk' },
      'Provide either a private key or a mnemonic',
    ],
    [{ privateKey, addressIndex: 1 }, 'Account and address indices require a mnemonic'],
    [
      {
        privateKey: undefined,
        mnemonic: 'test test test test test test test test test test test junk',
        accountIndex: -1,
      },
      'non-negative safe integers',
    ],
  ])('rejects invalid signer options: %p', async (credentials, message) => {
    await expect(
      signAttesterExit({ ...args, ...credentials, output: join(directory, 'invalid.json') }),
    ).rejects.toThrow(message);
  });

  it('rejects an attester address derived from a different mnemonic index', async () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const selected = mnemonicToAccount(mnemonic, { accountIndex: 1, addressIndex: 2 });
    await expect(
      signAttesterExit({
        ...args,
        privateKey: undefined,
        mnemonic,
        accountIndex: 1,
        addressIndex: 3,
        attesterAddress: EthAddress.fromString(selected.address),
        output: join(directory, 'mismatch.json'),
      }),
    ).rejects.toThrow('The signing account must match the attester address');
  });

  it('appends another attester without changing the existing authorization', async () => {
    const output = join(directory, 'batch.json');
    await signAttesterExit({ ...args, output });
    const original = await readAttesterExitAuthorizations(output);
    const account = privateKeyToAccount(secondPrivateKey);
    const options = {
      ...args,
      output,
      append: true,
      privateKey: secondPrivateKey,
      attesterAddress: EthAddress.fromString(account.address),
    };
    await signAttesterExit(options);
    const entries = await readAttesterExitAuthorizations(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(original[0]);
    expect(entries[1].attester).toEqual(options.attesterAddress);
  });

  it('creates then appends with the same loop options', async () => {
    const output = join(directory, 'loop.json');
    for (const key of [privateKey, secondPrivateKey]) {
      const account = privateKeyToAccount(key);
      await signAttesterExit({
        ...args,
        privateKey: key,
        attesterAddress: EthAddress.fromString(account.address),
        output,
        append: true,
      });
    }
    const entries = await readAttesterExitAuthorizations(output);
    expect(entries.map(entry => entry.attester.toString().toLowerCase())).toEqual(
      [privateKey, secondPrivateKey].map(key => privateKeyToAccount(key).address.toLowerCase()),
    );
  });

  it('leaves invalid batch JSON unchanged when appending', async () => {
    const output = join(directory, 'batch.json');
    await writeFile(output, 'invalid');
    await expect(signAttesterExit({ ...args, output, append: true })).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('invalid');
  });

  it('allows duplicate attesters when appending', async () => {
    const output = join(directory, 'batch.json');
    await signAttesterExit({ ...args, output });
    await signAttesterExit({ ...args, output, append: true });
    expect(await readAttesterExitAuthorizations(output)).toHaveLength(2);
  });

  it.each([{ malformed: true }, { attester: attester.address, deadline: '1', signature: '0x12' }])(
    'preserves existing entries without validating them: %p',
    async entry => {
      const output = join(directory, 'batch.json');
      await writeFile(output, JSON.stringify([entry]));
      await signAttesterExit({ ...args, output, append: true });
      const entries = JSON.parse(await readFile(output, 'utf8'));
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual(entry);
    },
  );

  it('rejects a mismatched signer', async () => {
    await expect(
      signAttesterExit({ ...args, output: join(directory, 'exit.json'), attesterAddress: EthAddress.ZERO }),
    ).rejects.toThrow('The signing account must match the attester address');
  });

  it('preserves an existing output file', async () => {
    const output = join(directory, 'exit.json');
    await writeFile(output, 'existing authorization');
    await expect(signAttesterExit({ ...args, output })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe('existing authorization');
  });
});

describe('sign-attester-exit with real signatures', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const envVars = [
    'PRIVATE_KEY',
    'MNEMONIC',
    'L1_CHAIN_ID',
    'ETHEREUM_HOSTS',
    'NETWORK',
    'NETWORK_CONFIG_LOCATION',
    'DATA_DIRECTORY',
    'REGISTRY_CONTRACT_ADDRESS',
  ];
  const testnetChainId = 11155111;
  const testnetRegistry = EthAddress.fromString(`0x${'ab'.repeat(20)}`);
  const offlineTarget = ['--l1-chain-id', String(args.chainId), '--rollup', rollupAddress.toString()];
  let directory: string;
  let previousEnv: Record<string, string | undefined>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sign-attester-exit-signed-'));
    previousEnv = Object.fromEntries(envVars.map(name => [name, process.env[name]]));
    envVars.forEach(name => delete process.env[name]);
    process.env.PRIVATE_KEY = privateKey;
    const networkConfig = join(directory, 'network_config.json');
    await writeFile(
      networkConfig,
      JSON.stringify({
        testnet: {
          bootnodes: [],
          snapshots: [],
          registryAddress: testnetRegistry.toString(),
          l1ChainId: testnetChainId,
        },
      }),
    );
    process.env.NETWORK_CONFIG_LOCATION = networkConfig;
  });
  afterEach(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  const runCli = (credentials: string[], attesterAddress: string, output: string, target = offlineTarget) => {
    const program = new Command().name('aztec').exitOverride();
    injectCommands(program, () => {}, createLogger('cli:test:signer'));
    return program.parseAsync(
      [
        'sign-attester-exit',
        ...credentials,
        ...target,
        '--attester',
        attesterAddress,
        '--deadline',
        deadline.toString(),
        '--output',
        output,
      ],
      { from: 'user' },
    );
  };

  const serveL1Rpc = async (chainId: number, canonicalRollup?: EthAddress) => {
    const registryCalls: { to: string; data: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => (body += chunk));
      request.on('end', () => {
        const { id, method, params } = JSON.parse(body);
        response.setHeader('content-type', 'application/json');
        if (method === 'eth_chainId') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${chainId.toString(16)}` }));
        } else if (method === 'eth_call' && canonicalRollup) {
          registryCalls.push({ to: params[0].to, data: params[0].data });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: encodeAbiParameters([{ type: 'address' }], [canonicalRollup.toString() as `0x${string}`]),
            }),
          );
        } else {
          response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }
    return {
      url: `http://127.0.0.1:${address.port}`,
      registryCalls,
      close: () => new Promise(resolve => server.close(resolve)),
    };
  };

  const expectValidAuthorizationFor = async (
    output: string,
    signer: string,
    chainId = args.chainId,
    signedRollup = rollupAddress,
  ) => {
    const [entry] = await readAttesterExitAuthorizations(output);
    expect(entry.attester).toEqual(EthAddress.fromString(signer));
    const rollup = new RollupContract(getPublicClient({ l1RpcUrls: args.rpcUrls, l1ChainId: chainId }), signedRollup);
    await expect(rollup.validateAttesterExitAuthorizations([entry])).resolves.toBeUndefined();
  };

  const onlyMnemonicExported = { PRIVATE_KEY: undefined, MNEMONIC: mnemonic };
  it.each([
    [
      'the mnemonic over the exported PRIVATE_KEY',
      {},
      ['--mnemonic', mnemonic, '--account-index', '1', '--address-index', '2'],
      mnemonicToAccount(mnemonic, { accountIndex: 1, addressIndex: 2 }).address,
    ],
    ['the exported PRIVATE_KEY', {}, [], privateKeyToAccount(privateKey).address],
    [
      'an explicit key over the exported PRIVATE_KEY',
      {},
      ['--private-key', secondPrivateKey],
      privateKeyToAccount(secondPrivateKey).address,
    ],
    ['the exported MNEMONIC', onlyMnemonicExported, [], mnemonicToAccount(mnemonic).address],
    [
      'the exported PRIVATE_KEY over the exported MNEMONIC',
      { MNEMONIC: mnemonic },
      [],
      privateKeyToAccount(privateKey).address,
    ],
    [
      'an explicit key over the exported MNEMONIC',
      onlyMnemonicExported,
      ['--private-key', secondPrivateKey],
      privateKeyToAccount(secondPrivateKey).address,
    ],
  ])('signs with %s', async (_label, env: Record<string, string | undefined>, credentials, signer) => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    const output = join(directory, 'exit.json');
    await runCli(credentials, signer, output);
    await expectValidAuthorizationFor(output, signer);
  });

  it('rejects an explicit key combined with a mnemonic', async () => {
    await expect(
      runCli(['--private-key', privateKey, '--mnemonic', mnemonic], attester.address, join(directory, 'exit.json')),
    ).rejects.toThrow('Provide either a private key or a mnemonic for the signer');
  });

  it.each([
    [
      'no chain ID source',
      ['--rollup', rollupAddress.toString()],
      'Provide --l1-chain-id, --network, or --l1-rpc-urls',
    ],
    ['chain ID 0', ['--l1-chain-id', '0', '--rollup', rollupAddress.toString()], 'positive safe integer'],
    ['neither --rollup nor --network', ['--l1-chain-id', '1'], 'Provide --rollup, or --network'],
    ['--network without an RPC for the registry', ['--network', 'testnet'], 'requires --l1-rpc-urls'],
    [
      'a chain ID that differs from --network',
      ['--l1-chain-id', '1', '--network', 'testnet', '--rollup', rollupAddress.toString()],
      `Chain ID 1 does not match testnet, which uses chain ID ${testnetChainId}`,
    ],
    [
      '--network local without --rollup',
      ['--l1-chain-id', '31337', '--network', 'local'],
      'Network local publishes no registry address; provide --rollup',
    ],
  ])('rejects %s', async (_label, target, message) => {
    const output = join(directory, 'exit.json');
    await expect(runCli([], attester.address, output, target)).rejects.toThrow(message);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('signs for the chain ID reported by the RPC when no chain ID is given', async () => {
    const rpc = await serveL1Rpc(11155111);
    try {
      const output = join(directory, 'exit.json');
      await runCli([], attester.address, output, ['--l1-rpc-urls', rpc.url, '--rollup', rollupAddress.toString()]);
      await expectValidAuthorizationFor(output, attester.address, 11155111);
    } finally {
      await rpc.close();
    }
  });

  it('rejects an exported L1_CHAIN_ID that neither --network nor an RPC confirms', async () => {
    process.env.L1_CHAIN_ID = '31337';
    const output = join(directory, 'exit.json');
    await expect(runCli([], attester.address, output, ['--rollup', rollupAddress.toString()])).rejects.toThrow(
      'Chain ID 31337 comes only from L1_CHAIN_ID',
    );
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('signs for an exported L1_CHAIN_ID that the RPC confirms', async () => {
    process.env.L1_CHAIN_ID = String(testnetChainId);
    const rpc = await serveL1Rpc(testnetChainId);
    try {
      const output = join(directory, 'exit.json');
      await runCli([], attester.address, output, ['--l1-rpc-urls', rpc.url, '--rollup', rollupAddress.toString()]);
      await expectValidAuthorizationFor(output, attester.address, testnetChainId);
    } finally {
      await rpc.close();
    }
  });

  it('rejects an RPC on a different chain from --l1-chain-id when --rollup is given', async () => {
    const rpc = await serveL1Rpc(1);
    try {
      const output = join(directory, 'exit.json');
      await expect(
        runCli([], attester.address, output, [...offlineTarget, '--l1-rpc-urls', rpc.url]),
      ).rejects.toThrow(`The L1 RPC reports chain ID 1, but chain ID ${args.chainId} was requested`);
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rpc.close();
    }
  });

  it('rejects a named network with no published config even when an Anvil chain ID is exported', async () => {
    await writeFile(process.env.NETWORK_CONFIG_LOCATION!, '{}');
    process.env.L1_CHAIN_ID = '31337';
    const output = join(directory, 'exit.json');
    await expect(
      runCli([], attester.address, output, ['--network', 'testnet', '--rollup', rollupAddress.toString()]),
    ).rejects.toThrow('Network testnet has no published config');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('signs offline for the chain ID of --network when --rollup is given', async () => {
    const output = join(directory, 'exit.json');
    await runCli([], attester.address, output, ['--network', 'testnet', '--rollup', rollupAddress.toString()]);
    await expectValidAuthorizationFor(output, attester.address, testnetChainId);
  });

  it('signs for the canonical rollup published by --network', async () => {
    const canonicalRollup = EthAddress.fromString(`0x${'cd'.repeat(20)}`);
    const rpc = await serveL1Rpc(testnetChainId, canonicalRollup);
    try {
      const output = join(directory, 'canonical.json');
      await runCli([], attester.address, output, ['--network', 'testnet', '--l1-rpc-urls', rpc.url]);
      expect(rpc.registryCalls).toEqual([
        { to: testnetRegistry.toString(), data: toFunctionSelector('getCanonicalRollup()') },
      ]);
      await expectValidAuthorizationFor(output, attester.address, testnetChainId, canonicalRollup);
    } finally {
      await rpc.close();
    }
  });

  it('rejects an RPC on a different chain from --network', async () => {
    const rpc = await serveL1Rpc(1);
    try {
      await expect(
        runCli([], attester.address, join(directory, 'exit.json'), ['--l1-rpc-urls', rpc.url, '--network', 'testnet']),
      ).rejects.toThrow(`The L1 RPC reports chain ID 1, but chain ID ${testnetChainId} was requested`);
    } finally {
      await rpc.close();
    }
  });
});
