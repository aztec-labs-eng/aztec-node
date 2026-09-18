import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes a verifiable batch authorization without RPC', async () => {
    const account = attester;
    const output = join(directory, 'exit.json');
    const program = new Command();
    injectCommands(program, () => {}, createLogger('test:sign-attester-exit'));
    await program.parseAsync([
      'node',
      'aztec',
      'sign-attester-exit',
      '--l1-rpc-urls',
      args.rpcUrls[0],
      '--l1-chain-id',
      String(args.chainId),
      '--rollup',
      rollupAddress.toString(),
      '--attester',
      account.address,
      '--deadline',
      deadline.toString(),
      '--output',
      output,
      '--private-key',
      privateKey,
    ]);
    const [authorization] = await readAttesterExitAuthorizations(output);
    expect(authorization.attester).toEqual(EthAddress.fromString(account.address));
    expect(authorization.deadline).toBe(deadline);
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Aztec Rollup',
        version: '1',
        chainId: args.chainId,
        verifyingContract: rollupAddress.toString(),
      },
      types: {
        AttesterExit: [
          { name: 'attester', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'AttesterExit',
      message: { attester: account.address, deadline },
      signature: { ...authorization.signature, v: BigInt(authorization.signature.v) },
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
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
    const program = new Command().exitOverride();
    injectCommands(program, () => {}, createLogger('test:sign-attester-exit'));
    await program.parseAsync([
      'node',
      'aztec',
      'sign-attester-exit',
      '--private-key',
      secondPrivateKey,
      '--attester',
      account.address,
      '--rollup',
      rollupAddress.toString(),
      '--l1-chain-id',
      String(args.chainId),
      '--deadline',
      deadline.toString(),
      '--output',
      output,
      '--append',
    ]);
    const entries = await readAttesterExitAuthorizations(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(original[0]);
    expect(entries[1].attester).toEqual(options.attesterAddress);
  });

  it('creates then appends with the same loop flags', async () => {
    const output = join(directory, 'loop.json');
    for (const key of [privateKey, secondPrivateKey]) {
      const account = privateKeyToAccount(key);
      const program = new Command().exitOverride();
      injectCommands(program, () => {}, createLogger('test:sign-attester-exit'));
      await program.parseAsync([
        'node',
        'aztec',
        'sign-attester-exit',
        '--private-key',
        key,
        '--attester',
        account.address,
        '--rollup',
        rollupAddress.toString(),
        '--l1-chain-id',
        String(args.chainId),
        '--deadline',
        deadline.toString(),
        '--output',
        output,
        '--append',
        '--create-if-missing',
      ]);
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

  it('appends duplicate attesters and rejects them only during validation', async () => {
    const output = join(directory, 'batch.json');
    await signAttesterExit({ ...args, output });
    await signAttesterExit({ ...args, output, append: true });
    expect(await readAttesterExitAuthorizations(output)).toHaveLength(2);
    const program = new Command().exitOverride();
    injectCommands(program, () => {}, createLogger('test:validate-attester-exits'));
    await expect(
      program.parseAsync([
        'node',
        'aztec',
        'validate-attester-exits',
        '--authorizations',
        output,
        '--rollup',
        rollupAddress.toString(),
        '--l1-chain-id',
        String(args.chainId),
      ]),
    ).rejects.toThrow('Duplicate attester');
  });

  it.each(['chain', 'rollup'])('allows append from another %s but rejects it during validation', async domain => {
    const output = join(directory, 'batch.json');
    await signAttesterExit({ ...args, output });
    const account = privateKeyToAccount(secondPrivateKey);
    await signAttesterExit({
      ...args,
      output,
      append: true,
      privateKey: secondPrivateKey,
      attesterAddress: EthAddress.fromString(account.address),
      ...(domain === 'chain' ? { chainId: 1 } : { rollupAddress: EthAddress.ZERO }),
    });
    expect(await readAttesterExitAuthorizations(output)).toHaveLength(2);
    const program = new Command().exitOverride();
    injectCommands(program, () => {}, createLogger('test:validate-attester-exits'));
    await expect(
      program.parseAsync([
        'node',
        'aztec',
        'validate-attester-exits',
        '--authorizations',
        output,
        '--rollup',
        rollupAddress.toString(),
        '--l1-chain-id',
        String(args.chainId),
      ]),
    ).rejects.toThrow('Invalid signature');
  });

  it('validates a completed batch locally without modifying it', async () => {
    const output = join(directory, 'valid.json');
    await signAttesterExit({ ...args, output });
    const account = privateKeyToAccount(secondPrivateKey);
    await signAttesterExit({
      ...args,
      output,
      append: true,
      privateKey: secondPrivateKey,
      attesterAddress: EthAddress.fromString(account.address),
    });
    const before = await readFile(output, 'utf8');
    const messages: string[] = [];
    const program = new Command().exitOverride();
    injectCommands(program, message => messages.push(message), createLogger('test:validate-attester-exits'));
    await program.parseAsync([
      'node',
      'aztec',
      'validate-attester-exits',
      '--authorizations',
      output,
      '--rollup',
      rollupAddress.toString(),
      '--l1-chain-id',
      String(args.chainId),
      '--l1-rpc-urls',
      'http://127.0.0.1:1',
    ]);
    expect(messages.join('')).toContain('Validated 2 attester exit authorizations');
    expect(await readFile(output, 'utf8')).toBe(before);
  });

  it.each(['expired', 'malformed'])(
    'appends without checking an existing %s entry, then fails validation',
    async kind => {
      const output = join(directory, 'invalid-entry.json');
      await signAttesterExit({ ...args, output });
      const entries = JSON.parse(await readFile(output, 'utf8'));
      entries[0] = kind === 'expired' ? { ...entries[0], deadline: '1' } : { malformed: true };
      await writeFile(output, JSON.stringify(entries));
      const account = privateKeyToAccount(secondPrivateKey);
      await signAttesterExit({
        ...args,
        output,
        append: true,
        privateKey: secondPrivateKey,
        attesterAddress: EthAddress.fromString(account.address),
      });
      const after = JSON.parse(await readFile(output, 'utf8'));
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(entries[0]);
      const program = new Command().exitOverride();
      injectCommands(program, () => {}, createLogger('test:validate-attester-exits'));
      await expect(
        program.parseAsync([
          'node',
          'aztec',
          'validate-attester-exits',
          '--authorizations',
          output,
          '--rollup',
          rollupAddress.toString(),
          '--l1-chain-id',
          String(args.chainId),
        ]),
      ).rejects.toThrow(kind === 'expired' ? 'Invalid or expired deadline' : 'invalid attester');
    },
  );

  it('rejects a mismatched signer', async () => {
    await expect(
      signAttesterExit({ ...args, output: join(directory, 'exit.json'), attesterAddress: EthAddress.ZERO }),
    ).rejects.toThrow('The signing account must match the attester address');
  });

  it.each([0n, -1n, 1n << 256n])('rejects an invalid deadline %s', async deadline => {
    await expect(signAttesterExit({ ...args, deadline, output: join(directory, 'exit.json') })).rejects.toThrow(
      'Deadline must be a future Unix timestamp',
    );
  });

  it('preserves an existing output file', async () => {
    const output = join(directory, 'exit.json');
    await writeFile(output, 'existing authorization');
    await expect(signAttesterExit({ ...args, output })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe('existing authorization');
  });
});
