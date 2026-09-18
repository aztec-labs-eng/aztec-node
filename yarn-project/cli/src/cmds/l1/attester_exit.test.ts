import { GovernanceAbi, RollupAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import { DefaultL1ContractsConfig } from '@aztec-labs/ethereum/config';
import { AttesterStatus, RollupContract } from '@aztec-labs/ethereum/contracts';
import { deployAztecL1Contracts } from '@aztec-labs/ethereum/deploy-aztec-l1-contracts';
import { createL1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import { type Anvil, EthCheatCodes, startAnvil } from '@aztec-labs/ethereum/test';
import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContract } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { injectCommands } from './index.js';
import { initiateWithdrawByAttester, readAttesterExitAuthorizations } from './update_l1_validators.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attester = mnemonicToAccount(mnemonic);
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const logger = createLogger('cli:test:attester-exit');

describe('initiate-withdraw-by-attester command', () => {
  it('requires a rollup and attester and accepts no recipient', () => {
    const program = new Command();
    injectCommands(program, () => {}, logger);
    const command = program.commands.find(command => command.name() === 'initiate-withdraw-by-attester');
    expect(command).toBeDefined();
    expect(command?.options.find(option => option.long === '--rollup')?.mandatory).toBe(true);
    expect(command?.options.find(option => option.long === '--attester')?.mandatory).toBe(true);
    expect(command?.options.some(option => /recipient|withdrawer/.test(option.long ?? ''))).toBe(false);
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
  it('requires a rollup and authorization file and exposes the up-to-limit mode', () => {
    const program = new Command();
    injectCommands(program, () => {}, logger);
    const command = program.commands.find(command => command.name() === 'initiate-withdraw-by-attester-batch');
    expect(command).toBeDefined();
    expect(command?.options.find(option => option.long === '--rollup')?.mandatory).toBe(true);
    expect(command?.options.find(option => option.long === '--authorizations')?.mandatory).toBe(true);
    expect(command?.options.find(option => option.long === '--up-to-limit')).toBeDefined();
  });

  it('reads the JSON authorization format used by the batch command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'attester-exit-'));
    const path = join(directory, 'authorizations.json');
    const signature = Signature.random();
    await writeFile(
      path,
      JSON.stringify([{ attester: attester.address, deadline: '123456789', signature: signature.toString() }]),
    );

    try {
      await expect(readAttesterExitAuthorizations(path)).resolves.toEqual([
        {
          attester: EthAddress.fromString(attester.address),
          deadline: 123456789n,
          signature: signature.toViemSignature(),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true });
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

describe('attester exit through the client and CLI', () => {
  let anvil: Anvil;
  let rpcUrl: string;

  afterEach(async () => {
    await anvil?.stop();
  });

  it.each(['direct', 'signed', 'batch', 'up-to-limit'] as const)(
    '%s exits preserve withdrawer control and both delays',
    async mode => {
      const isBatch = mode === 'batch' || mode === 'up-to-limit';
      const validatorCount = isBatch ? 42 : 21;
      const exitCount = isBatch ? 2 : 1;
      const attesters = [attester, ...[3, 4].map(addressIndex => mnemonicToAccount(mnemonic, { addressIndex }))];
      ({ anvil, rpcUrl } = await startAnvil());
      const { l1ContractAddresses } = await deployAztecL1Contracts(
        rpcUrl,
        '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
        foundry.id,
        {
          ...DefaultL1ContractsConfig,
          vkTreeRoot: Fr.random(),
          protocolContractsHash: Fr.random(),
          genesisArchiveRoot: Fr.random(),
          realVerifier: false,
          aztecTargetCommitteeSize: 4,
          entryQueueBootstrapValidatorSetSize: validatorCount,
          entryQueueBootstrapFlushSize: validatorCount,
          entryQueueMaxFlushSize: validatorCount,
          initialValidators: Array.from({ length: validatorCount }, (_, index) => ({
            attester:
              index < attesters.length
                ? EthAddress.fromString(attesters[index].address)
                : EthAddress.fromString(`0x${(1000 + index).toString(16).padStart(40, '0')}`),
            withdrawer: EthAddress.fromString(withdrawer.address),
            bn254SecretKey: new SecretValue(BigInt(index + 1)),
          })),
        },
      );
      const attesterClient = createExtendedL1Client([rpcUrl], attester, foundry);
      const withdrawerClient = createExtendedL1Client([rpcUrl], withdrawer, foundry);
      const rollup = new RollupContract(attesterClient, l1ContractAddresses.rollupAddress);
      const target = EthAddress.fromString(attester.address);
      const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 }).address;
      const token = getContract({
        address: (await rollup.getStakingAsset()).toString(),
        abi: TestERC20Abi,
        client: attesterClient,
      });
      const governance = getContract({
        address: l1ContractAddresses.governanceAddress.toString(),
        abi: GovernanceAbi,
        client: attesterClient,
      });
      const ownerRollup = getContract({ address: rollup.address, abi: RollupAbi, client: withdrawerClient });
      const original = await rollup.getAttesterView(target);
      const recipientBalance = await token.read.balanceOf([recipient]);

      const before = await rollup.getAttesterExitLimitState();
      expect(before).toMatchObject({
        validatorCount: BigInt(validatorCount),
        committeeSize: 4n,
        used: 0n,
        allowance: BigInt(exitCount),
        canExit: true,
      });
      expect(await rollup.getAttesterExitWindow()).toBe(before.window);

      if (mode === 'direct') {
        const receipt = await initiateWithdrawByAttester({
          rpcUrls: [rpcUrl],
          chainId: foundry.id,
          privateKey: `0x${Buffer.from(attester.getHdKey().privateKey!).toString('hex')}`,
          attesterAddress: target,
          rollupAddress: l1ContractAddresses.rollupAddress,
          log: () => {},
          debugLogger: logger,
        });
        expect(receipt.status).toBe('success');
      } else {
        const deadline = (await attesterClient.getBlock()).timestamp + 3600n;
        const authorizations = await Promise.all(
          attesters.map(account =>
            rollup.createAttesterExitAuthorization(EthAddress.fromString(account.address), deadline, data =>
              account.signTypedData(data),
            ),
          ),
        );
        if (mode === 'signed') {
          const { receipt } = await rollup.initiateWithdrawByAttesterWithSignature(
            createL1TxUtils(withdrawerClient, { logger }),
            authorizations[0],
          );
          expect(receipt.status).toBe('success');
        } else {
          const toViem = (authorization: (typeof authorizations)[number]) => ({
            ...authorization,
            attester: authorization.attester.toString(),
          });
          if (mode === 'batch') {
            await expect(
              withdrawerClient.simulateContract({
                address: rollup.address,
                abi: RollupAbi,
                functionName: 'initiateWithdrawByAttesterBatch',
                args: [authorizations.map(toViem)],
              }),
            ).rejects.toThrow('Staking__AttesterExitLimitExceeded');
            for (const account of attesters) {
              expect((await rollup.getAttesterView(EthAddress.fromString(account.address))).exit.exists).toBe(false);
            }
            expect(await rollup.getAttesterExitLimitState()).toMatchObject({ used: 0n });
          }
          const directory = await mkdtemp(join(tmpdir(), 'attester-exit-batch-'));
          const path = join(directory, 'authorizations.json');
          const batch = mode === 'batch' ? authorizations.slice(0, exitCount) : authorizations;
          try {
            await writeFile(
              path,
              JSON.stringify(
                batch.map(authorization => ({
                  attester: authorization.attester.toString(),
                  deadline: authorization.deadline.toString(),
                  signature: Signature.fromViemSignature(authorization.signature).toString(),
                })),
              ),
            );
            const program = new Command().exitOverride();
            const messages: string[] = [];
            injectCommands(program, message => messages.push(message), logger);
            await program.parseAsync([
              'node',
              'aztec',
              'initiate-withdraw-by-attester-batch',
              '--l1-rpc-urls',
              rpcUrl,
              '--l1-chain-id',
              String(foundry.id),
              '--private-key',
              `0x${Buffer.from(withdrawer.getHdKey().privateKey!).toString('hex')}`,
              '--rollup',
              rollup.address,
              '--authorizations',
              path,
              ...(mode === 'up-to-limit' ? ['--up-to-limit'] : []),
            ]);
            expect(messages).toContainEqual(
              expect.stringContaining(`Processed ${exitCount} of ${batch.length} attester exit authorizations.`),
            );
            expect(messages).toContain(
              mode === 'up-to-limit'
                ? 'Remaining authorizations: 1. Zero-based JSON array indices 2 through 2 (inclusive).'
                : 'Remaining authorizations: 0 (none).',
            );
            if (mode === 'up-to-limit') {
              const remaining = JSON.parse(await readFile(path, 'utf8')).slice(exitCount);
              await writeFile(path, JSON.stringify(remaining));
              messages.length = 0;
              const retry = new Command().exitOverride();
              injectCommands(retry, message => messages.push(message), logger);
              await retry.parseAsync([
                'node',
                'aztec',
                'initiate-withdraw-by-attester-batch',
                '--l1-rpc-urls',
                rpcUrl,
                '--l1-chain-id',
                String(foundry.id),
                '--private-key',
                `0x${Buffer.from(withdrawer.getHdKey().privateKey!).toString('hex')}`,
                '--rollup',
                rollup.address,
                '--authorizations',
                path,
                '--up-to-limit',
              ]);
              expect(messages).toContainEqual(
                expect.stringContaining('Processed 0 of 1 attester exit authorizations.'),
              );
              expect(messages).toContain(
                'Remaining authorizations: 1. Zero-based JSON array indices 0 through 0 (inclusive).',
              );
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
          const second = await rollup.getAttesterView(EthAddress.fromString(attesters[1].address));
          expect(second.status).toBe(AttesterStatus.ZOMBIE);
          expect(second.exit).toMatchObject({
            exists: true,
            isRecipient: false,
            recipientOrWithdrawer: EthAddress.fromString(withdrawer.address),
            amount: original.effectiveBalance,
          });
        }
        const untouched = await rollup.getAttesterView(EthAddress.fromString(attesters[2].address));
        expect(untouched.exit.exists).toBe(false);
        expect(untouched.status).toBe(original.status);
      }
      const pending = await rollup.getAttesterView(target);
      expect(pending.status).toBe(AttesterStatus.ZOMBIE);
      expect(pending.exit.exists).toBe(true);
      expect(pending.exit.isRecipient).toBe(false);
      expect(pending.exit.recipientOrWithdrawer).toEqual(EthAddress.fromString(withdrawer.address));
      expect(pending.exit.amount).toBe(original.effectiveBalance);
      expect(await token.read.balanceOf([recipient])).toBe(recipientBalance);
      expect(await rollup.getAttesterExitLimitState()).toMatchObject({
        validatorCount: BigInt(validatorCount - exitCount),
        used: BigInt(exitCount),
        allowance: isBatch ? 1n : 0n,
        canExit: false,
      });
      const withdrawal = await governance.read.getWithdrawal([pending.exit.withdrawalId]);

      await expect(
        attesterClient.simulateContract({
          address: rollup.address,
          abi: RollupAbi,
          functionName: 'initiateWithdraw',
          args: [attester.address, recipient],
        }),
      ).rejects.toThrow();

      const selection = await ownerRollup.write.initiateWithdraw([attester.address, recipient]);
      expect((await withdrawerClient.waitForTransactionReceipt({ hash: selection })).status).toBe('success');
      const selected = await rollup.getAttesterView(target);
      expect(selected.exit.withdrawalId).toBe(pending.exit.withdrawalId);
      expect(selected.exit.exitableAt).toBe(pending.exit.exitableAt);
      expect(selected.exit.recipientOrWithdrawer).toEqual(EthAddress.fromString(recipient));
      expect(selected.exit.isRecipient).toBe(true);
      expect(await governance.read.getWithdrawal([pending.exit.withdrawalId])).toEqual(withdrawal);

      const unlock = pending.exit.exitableAt > withdrawal.unlocksAt ? pending.exit.exitableAt : withdrawal.unlocksAt;
      const cheatCodes = new EthCheatCodes([rpcUrl], new DateProvider());
      await cheatCodes.warp(unlock - 1n);
      await expect(
        attesterClient.simulateContract({
          address: rollup.address,
          abi: RollupAbi,
          functionName: 'finalizeWithdraw',
          args: [attester.address],
        }),
      ).rejects.toThrow();
      await cheatCodes.warp(unlock);
      const finalized = await ownerRollup.write.finalizeWithdraw([attester.address]);
      expect((await withdrawerClient.waitForTransactionReceipt({ hash: finalized })).status).toBe('success');
      expect(await token.read.balanceOf([recipient])).toBe(recipientBalance + pending.exit.amount);
      expect((await rollup.getAttesterView(target)).exit.exists).toBe(false);
    },
    240_000,
  );
});
