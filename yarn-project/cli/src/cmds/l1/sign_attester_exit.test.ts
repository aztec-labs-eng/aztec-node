import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

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
        createIfMissing: true,
      });
    }
    const entries = await readAttesterExitAuthorizations(output);
    expect(entries.map(entry => entry.attester.toString().toLowerCase())).toEqual(
      [privateKey, secondPrivateKey].map(key => privateKeyToAccount(key).address.toLowerCase()),
    );
  });

  it('still requires an existing file when only append is supplied', async () => {
    await expect(
      signAttesterExit({ ...args, output: join(directory, 'missing.json'), append: true }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('leaves invalid batch JSON unchanged with create-if-missing=%s', async createIfMissing => {
    const output = join(directory, 'batch.json');
    await writeFile(output, 'invalid');
    const options = { ...args, output, append: true, createIfMissing };
    await expect(signAttesterExit(options)).rejects.toThrow();
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
