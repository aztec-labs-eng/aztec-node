import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { jest } from '@jest/globals';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { injectCommands } from './index.js';
import {
  initiateWithdrawByAttester,
  initiateWithdrawByAttesterBatch,
  readAttesterExitAuthorizations,
} from './update_l1_validators.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attester = mnemonicToAccount(mnemonic);
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const logger = createLogger('cli:test:attester-exit');

describe('initiate-withdraw-by-attester command', () => {
  it('rejects a mnemonic signer from the wrong validator-key index before contacting L1', async () => {
    const selected = mnemonicToAccount(mnemonic, { accountIndex: 1, addressIndex: 2 });
    await expect(
      initiateWithdrawByAttester({
        rpcUrls: ['http://127.0.0.1:1'],
        chainId: foundry.id,
        mnemonic,
        accountIndex: 1,
        addressIndex: 3,
        attesterAddress: EthAddress.fromString(selected.address),
        rollupAddress: EthAddress.ZERO,
        log: () => {},
        debugLogger: logger,
      }),
    ).rejects.toThrow('The transaction signer must match the attester address');
  });

  it('rejects a signer that does not match the attester before contacting L1', async () => {
    await expect(
      initiateWithdrawByAttester({
        rpcUrls: ['http://127.0.0.1:1'],
        chainId: foundry.id,
        privateKey: `0x${Buffer.from(attester.getHdKey().privateKey!).toString('hex')}`,
        attesterAddress: EthAddress.fromString(withdrawer.address),
        rollupAddress: EthAddress.ZERO,
        log: () => {},
        debugLogger: logger,
      }),
    ).rejects.toThrow('The transaction signer must match the attester address');
  });
});

describe('initiate-withdraw-by-attester-batch command', () => {
  const relayerKey = `0x${Buffer.from(withdrawer.getHdKey().privateKey!).toString('hex')}`;
  const dryRunArgs = {
    rpcUrls: ['http://127.0.0.1:1'],
    chainId: foundry.id,
    rollupAddress: EthAddress.ZERO,
    authorizations: [
      {
        attester: EthAddress.fromString(attester.address),
        deadline: 4102444800n,
        signature: Signature.random().toViemSignature(),
      },
    ],
    upToLimit: false,
    dryRun: true,
    log: () => {},
    debugLogger: logger,
  };

  it.each([false, true])('dry-runs without a relayer key with up-to-limit=%s', async upToLimit => {
    const directory = await mkdtemp(join(tmpdir(), 'attester-exit-dry-run-'));
    const path = join(directory, 'authorizations.json');
    const messages: string[] = [];
    const simulation = jest
      .spyOn(RollupContract.prototype, 'simulateAttesterExitBatch')
      .mockImplementation((authorizations, upToLimit) => Promise.resolve(upToLimit ? 2 : authorizations.length));
    try {
      await writeFile(
        path,
        JSON.stringify(
          [attester.address, withdrawer.address, mnemonicToAccount(mnemonic, { addressIndex: 2 }).address].map(
            attester => ({ attester, deadline: '4102444800', signature: Signature.random().toString() }),
          ),
        ),
      );
      const program = new Command().name('aztec').exitOverride();
      injectCommands(program, message => messages.push(message), logger);
      await program.parseAsync(
        [
          'initiate-withdraw-by-attester-batch',
          '--dry-run',
          ...(upToLimit ? ['--up-to-limit'] : []),
          '--authorizations',
          path,
          '--rollup',
          attester.address,
          '--l1-chain-id',
          String(foundry.id),
          '--l1-rpc-urls',
          'http://127.0.0.1:1',
        ],
        { from: 'user' },
      );
      expect(messages).toEqual([
        `Dry run: would process ${upToLimit ? 2 : 3} of 3 attester exit authorizations at current chain state.`,
        upToLimit
          ? 'Remaining authorizations: 1. Zero-based JSON array indices 2 through 2 (inclusive).'
          : 'Remaining authorizations: 0 (none).',
      ]);
    } finally {
      simulation.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a contract simulation failure without requiring a key', async () => {
    const simulation = jest
      .spyOn(RollupContract.prototype, 'simulateAttesterExitBatch')
      .mockRejectedValue(new Error('Staking__AttesterExitLimitExceeded'));
    const messages: string[] = [];
    try {
      await expect(
        initiateWithdrawByAttesterBatch({
          rpcUrls: ['http://127.0.0.1:1'],
          chainId: foundry.id,
          rollupAddress: EthAddress.ZERO,
          authorizations: [],
          upToLimit: false,
          dryRun: true,
          log: message => messages.push(message),
          debugLogger: logger,
        }),
      ).rejects.toThrow('Staking__AttesterExitLimitExceeded');
      expect(messages).toEqual([]);
    } finally {
      simulation.mockRestore();
    }
  });

  it.each([
    [{ privateKey: relayerKey, mnemonic }, 'Provide either a private key or a mnemonic'],
    [{ privateKey: relayerKey, addressIndex: 1 }, 'Account and address indices require a mnemonic'],
    [{ accountIndex: 1 }, 'Provide either a private key or a mnemonic'],
  ])('rejects invalid signer options in a dry run: %p', async (credentials, message) => {
    const simulation = jest.spyOn(RollupContract.prototype, 'simulateAttesterExitBatch').mockResolvedValue(1);
    try {
      await expect(initiateWithdrawByAttesterBatch({ ...dryRunArgs, ...credentials })).rejects.toThrow(message);
    } finally {
      simulation.mockRestore();
    }
  });

  it('dry-runs with a valid relayer key', async () => {
    const simulation = jest.spyOn(RollupContract.prototype, 'simulateAttesterExitBatch').mockResolvedValue(1);
    const messages: string[] = [];
    try {
      await initiateWithdrawByAttesterBatch({
        ...dryRunArgs,
        privateKey: relayerKey,
        log: message => messages.push(message),
      });
      expect(messages[0]).toBe('Dry run: would process 1 of 1 attester exit authorizations at current chain state.');
    } finally {
      simulation.mockRestore();
    }
  });

  it.each(['0x', '0x12', `0x${'11'.repeat(64)}`, '0xnothex'])(
    'rejects malformed signature %s with its authorization index',
    async signature => {
      const directory = await mkdtemp(join(tmpdir(), 'attester-exit-invalid-'));
      const path = join(directory, 'authorizations.json');
      try {
        await writeFile(
          path,
          JSON.stringify([
            { attester: attester.address, deadline: '123456789', signature: Signature.random().toString() },
            { attester: withdrawer.address, deadline: '123456789', signature },
          ]),
        );
        await expect(readAttesterExitAuthorizations(path)).rejects.toThrow(
          'Attester exit authorization 1 has an invalid signature',
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
});
