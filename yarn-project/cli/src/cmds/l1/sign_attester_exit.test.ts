import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { jest } from '@jest/globals';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { injectCommands } from './index.js';
import { readAttesterExitAuthorizations, signAttesterExit, validateAttesterExits } from './update_l1_validators.js';

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
  let directory: string;
  let previousKey: string | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sign-attester-exit-signed-'));
    previousKey = process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY = privateKey;
  });
  afterEach(async () => {
    if (previousKey === undefined) {
      delete process.env.PRIVATE_KEY;
    } else {
      process.env.PRIVATE_KEY = previousKey;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const runCli = (credentials: string[], attesterAddress: string, output: string) => {
    const program = new Command().name('aztec').exitOverride();
    injectCommands(program, () => {}, createLogger('cli:test:signer'));
    return program.parseAsync(
      [
        'sign-attester-exit',
        ...credentials,
        '--attester',
        attesterAddress,
        '--rollup',
        rollupAddress.toString(),
        '--deadline',
        deadline.toString(),
        '--output',
        output,
      ],
      { from: 'user' },
    );
  };

  const expectValidAuthorizationFor = async (output: string, signer: string) => {
    const [entry] = await readAttesterExitAuthorizations(output);
    expect(entry.attester).toEqual(EthAddress.fromString(signer));
    await expect(
      validateAttesterExits({
        rpcUrls: args.rpcUrls,
        chainId: args.chainId,
        rollupAddress,
        authorizationsPath: output,
        log: () => {},
      }),
    ).resolves.toBeUndefined();
  };

  it.each([
    [
      'the mnemonic over the exported PRIVATE_KEY',
      ['--mnemonic', mnemonic, '--account-index', '1', '--address-index', '2'],
      mnemonicToAccount(mnemonic, { accountIndex: 1, addressIndex: 2 }).address,
    ],
    ['the exported PRIVATE_KEY', [], privateKeyToAccount(privateKey).address],
    [
      'an explicit key over the exported PRIVATE_KEY',
      ['--private-key', secondPrivateKey],
      privateKeyToAccount(secondPrivateKey).address,
    ],
  ])('signs with %s', async (_label, credentials, signer) => {
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
    [0, 0],
    [2, 3],
  ])('signs with the mnemonic key at account index %s and address index %s', async (accountIndex, addressIndex) => {
    const signer = mnemonicToAccount(mnemonic, { accountIndex, addressIndex }).address;
    const output = join(directory, 'mnemonic.json');
    await signAttesterExit({
      ...args,
      privateKey: undefined,
      mnemonic,
      accountIndex,
      addressIndex,
      attesterAddress: EthAddress.fromString(signer),
      output,
    });
    await expectValidAuthorizationFor(output, signer);
  });
});
