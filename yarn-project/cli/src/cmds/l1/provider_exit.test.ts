import { GovernanceAbi, RollupAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import { DefaultL1ContractsConfig } from '@aztec-labs/ethereum/config';
import { AttesterStatus, RollupContract } from '@aztec-labs/ethereum/contracts';
import { deployAztecL1Contracts } from '@aztec-labs/ethereum/deploy-aztec-l1-contracts';
import { type Anvil, EthCheatCodes, startAnvil } from '@aztec-labs/ethereum/test';
import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { Command } from 'commander';
import { getContract } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { injectCommands } from './index.js';
import { initiateProviderExit } from './update_l1_validators.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attester = mnemonicToAccount(mnemonic);
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const logger = createLogger('cli:test:provider-exit');

describe('initiate-provider-exit command', () => {
  it('requires a rollup and attester and accepts no recipient', () => {
    const program = new Command();
    injectCommands(program, () => {}, logger);
    const command = program.commands.find(command => command.name() === 'initiate-provider-exit');
    expect(command).toBeDefined();
    expect(command?.options.find(option => option.long === '--rollup')?.mandatory).toBe(true);
    expect(command?.options.find(option => option.long === '--attester')?.mandatory).toBe(true);
    expect(command?.options.some(option => /recipient|withdrawer/.test(option.long ?? ''))).toBe(false);
  });

  it('rejects a signer that does not match the attester before contacting L1', async () => {
    await expect(
      initiateProviderExit({
        rpcUrls: ['http://127.0.0.1:1'],
        chainId: foundry.id,
        mnemonic,
        attesterAddress: EthAddress.fromString(withdrawer.address),
        rollupAddress: EthAddress.ZERO,
        log: () => {},
        debugLogger: logger,
      }),
    ).rejects.toThrow('The transaction signer must match the attester address');
  });
});

describe('provider exit through the client and CLI', () => {
  let anvil: Anvil;
  let rpcUrl: string;

  afterAll(async () => {
    await anvil?.stop();
  });

  it('deploys, exits as the attester, and pays only the withdrawer-selected recipient after both delays', async () => {
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
        entryQueueBootstrapValidatorSetSize: 21,
        entryQueueBootstrapFlushSize: 21,
        entryQueueMaxFlushSize: 21,
        initialValidators: Array.from({ length: 21 }, (_, index) => ({
          attester:
            index === 0
              ? EthAddress.fromString(attester.address)
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

    const before = await rollup.getProviderExitLimitState();
    expect(before).toMatchObject({ validatorCount: 21n, committeeSize: 4n, used: 0n, allowance: 1n, canExit: true });
    expect(await rollup.getProviderExitWindow()).toBe(before.window);

    const receipt = await initiateProviderExit({
      rpcUrls: [rpcUrl],
      chainId: foundry.id,
      mnemonic,
      attesterAddress: target,
      rollupAddress: l1ContractAddresses.rollupAddress,
      log: () => {},
      debugLogger: logger,
    });
    expect(receipt.status).toBe('success');
    const pending = await rollup.getAttesterView(target);
    expect(pending.status).toBe(AttesterStatus.ZOMBIE);
    expect(pending.exit.exists).toBe(true);
    expect(pending.exit.isRecipient).toBe(false);
    expect(pending.exit.recipientOrWithdrawer).toEqual(EthAddress.fromString(withdrawer.address));
    expect(pending.exit.amount).toBe(original.effectiveBalance);
    expect(await token.read.balanceOf([recipient])).toBe(recipientBalance);
    expect(await rollup.getProviderExitLimitState()).toMatchObject({
      validatorCount: 20n,
      used: 1n,
      allowance: 0n,
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
  }, 240_000);
});
