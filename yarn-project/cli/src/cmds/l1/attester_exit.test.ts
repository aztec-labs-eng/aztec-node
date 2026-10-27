import { getPublicClient } from '@aztec-labs/ethereum/client';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { jest } from '@jest/globals';
import { Buffer } from 'buffer';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HDAccount, mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { injectCommands } from './index.js';
import { serveL1Rpc } from './l1_rpc_test_utils.js';
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
  const rollupAddress = EthAddress.fromString('0x1234567890123456789012345678901234567890');
  // January 1, 2100 (Unix seconds), so the test authorizations stay valid as time passes.
  const deadline = 4102444800n;
  const sign = (account: HDAccount, chainId: number = foundry.id) =>
    new RollupContract(
      getPublicClient({ l1RpcUrls: ['http://127.0.0.1:1'], l1ChainId: chainId }),
      rollupAddress,
    ).createAttesterExitAuthorization(EthAddress.fromString(account.address), deadline, data =>
      account.signTypedData(data),
    );
  const dryRunArgs = {
    rpcUrls: ['http://127.0.0.1:1'],
    chainId: foundry.id,
    rollupAddress,
    authorizations: [
      {
        attester: EthAddress.fromString(attester.address),
        deadline,
        signature: Signature.random().toViemSignature(),
      },
    ],
    upToLimit: false,
    dryRun: true,
    log: () => {},
    debugLogger: logger,
  };

  let rpc: Awaited<ReturnType<typeof serveL1Rpc>> | undefined;
  afterEach(async () => {
    await rpc?.close();
    rpc = undefined;
  });

  it.each([false, true])('dry-runs without a relayer key with up-to-limit=%s', async upToLimit => {
    rpc = await serveL1Rpc(foundry.id);
    const directory = await mkdtemp(join(tmpdir(), 'attester-exit-dry-run-'));
    const path = join(directory, 'authorizations.json');
    const messages: string[] = [];
    const simulation = jest
      .spyOn(RollupContract.prototype, 'simulateAttesterExitBatch')
      .mockImplementation((authorizations, upToLimit) => Promise.resolve(upToLimit ? 2 : authorizations.length));
    try {
      const authorizations = await Promise.all(
        [attester, withdrawer, mnemonicToAccount(mnemonic, { addressIndex: 2 })].map(account => sign(account)),
      );
      await writeFile(
        path,
        JSON.stringify(
          authorizations.map(({ attester, deadline, signature }) => ({
            attester: attester.toString(),
            deadline: deadline.toString(),
            signature: Signature.fromViemSignature(signature).toString(),
          })),
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
          rollupAddress.toString(),
          '--l1-chain-id',
          String(foundry.id),
          '--l1-rpc-urls',
          rpc.url,
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

  it.each([true, false])('rejects an RPC on another chain than --l1-chain-id with dry-run=%s', async dryRun => {
    rpc = await serveL1Rpc(11155111);
    const simulation = jest.spyOn(RollupContract.prototype, 'simulateAttesterExitBatch').mockResolvedValue(1);
    try {
      await expect(
        initiateWithdrawByAttesterBatch({
          ...dryRunArgs,
          rpcUrls: [rpc.url],
          authorizations: [await sign(attester)],
          dryRun,
          privateKey: relayerKey,
        }),
      ).rejects.toThrow(`The L1 RPC reports chain ID 11155111, but chain ID ${foundry.id} was requested`);
    } finally {
      simulation.mockRestore();
    }
  });

  it.each([
    [
      'a yParity v',
      async () => {
        const entry = await sign(withdrawer);
        return { ...entry, signature: { ...entry.signature, v: 0 } };
      },
      'Invalid v in authorization 1',
    ],
    ['a signature for another chain', () => sign(withdrawer, 1), 'Invalid signature in authorization 1'],
  ])('rejects %s in an imported entry and names its index', async (_label, makeSecond, message) => {
    rpc = await serveL1Rpc(foundry.id);
    const simulation = jest.spyOn(RollupContract.prototype, 'simulateAttesterExitBatch').mockResolvedValue(2);
    try {
      await expect(
        initiateWithdrawByAttesterBatch({
          ...dryRunArgs,
          rpcUrls: [rpc.url],
          authorizations: [await sign(attester), await makeSecond()],
        }),
      ).rejects.toThrow(message);
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
