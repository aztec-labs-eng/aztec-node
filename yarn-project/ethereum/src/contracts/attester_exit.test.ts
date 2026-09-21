import { GovernanceAbi, RollupAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { getContract, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { createExtendedL1Client } from '../client.js';
import { DefaultL1ContractsConfig } from '../config.js';
import { deployAztecL1Contracts } from '../deploy_aztec_l1_contracts.js';
import { createL1TxUtils } from '../l1_tx_utils/index.js';
import { type Anvil, EthCheatCodes, startAnvil } from '../test/index.js';
import { AttesterStatus, RollupContract } from './index.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attester = mnemonicToAccount(mnemonic);
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
// Accounts 0–4 are the attesters, withdrawer, and recipient; keep the deployer separate from those roles.
const deployer = mnemonicToAccount(mnemonic, { addressIndex: 5 });
const deployerPrivateKey = toHex(deployer.getHdKey().privateKey!);
const logger = createLogger('ethereum:test:attester-exit');

describe('attester exit client integration', () => {
  let anvil: Anvil;
  let rpcUrl: string;

  afterEach(async () => {
    await anvil?.stop();
  });

  it.each(['direct', 'signed', 'batch', 'up-to-limit'] as const)(
    '%s exits preserve withdrawer control and account for processed authorizations',
    async mode => {
      const isBatch = mode === 'batch' || mode === 'up-to-limit';
      // These validator counts allow one single exit or two batch exits, leaving a third request over capacity.
      const validatorCount = isBatch ? 42 : 21;
      const exitCount = isBatch ? 2 : 1;
      const attesters = [attester, ...[3, 4].map(addressIndex => mnemonicToAccount(mnemonic, { addressIndex }))];
      ({ anvil, rpcUrl } = await startAnvil());
      const { l1ContractAddresses } = await deployAztecL1Contracts(rpcUrl, deployerPrivateKey, foundry.id, {
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
      });
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

      // Signed exits use the withdrawer as a separate relayer; only the direct path sends from the attester.
      if (mode === 'direct') {
        const { receipt } = await rollup.initiateWithdrawByAttester(
          createL1TxUtils(attesterClient, { logger }),
          target,
        );
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
          // Atomic batches must fit in full; up-to-limit receives all three so we can check the unprocessed suffix.
          const batch = mode === 'batch' ? authorizations.slice(0, exitCount) : authorizations;
          const result = await rollup.submitAttesterExitBatch(
            createL1TxUtils(withdrawerClient, { logger }),
            batch,
            mode === 'up-to-limit',
          );
          expect(result.receipt.status).toBe('success');
          expect(result).toMatchObject({
            processedCount: exitCount,
            remainingCount: batch.length - exitCount,
            remainingStartIndex: mode === 'up-to-limit' ? exitCount : undefined,
            remainingEndIndexExclusive: mode === 'up-to-limit' ? batch.length : undefined,
          });
          if (mode === 'up-to-limit') {
            // Capacity is exhausted in this window: retrying the suffix must report zero processed exits.
            const retry = await rollup.submitAttesterExitBatch(
              createL1TxUtils(withdrawerClient, { logger }),
              batch.slice(exitCount),
              true,
            );
            expect(retry).toMatchObject({
              processedCount: 0,
              remainingCount: 1,
              remainingStartIndex: 0,
              remainingEndIndexExclusive: 1,
            });
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
      // Every endpoint reaches the same pending-exit state
      if (mode !== 'direct') {
        return;
      }
      const withdrawal = await governance.read.getWithdrawal([pending.exit.withdrawalId]);

      await expect(
        attesterClient.simulateContract({
          address: rollup.address,
          abi: RollupAbi,
          functionName: 'initiateWithdraw',
          args: [attester.address, recipient],
        }),
      ).rejects.toThrow();

      // Recipient selection belongs to the withdrawer and must preserve the existing withdrawal and its delays.
      const selection = await ownerRollup.write.initiateWithdraw([attester.address, recipient]);
      expect((await withdrawerClient.waitForTransactionReceipt({ hash: selection })).status).toBe('success');
      const selected = await rollup.getAttesterView(target);
      expect(selected.exit.withdrawalId).toBe(pending.exit.withdrawalId);
      expect(selected.exit.exitableAt).toBe(pending.exit.exitableAt);
      expect(selected.exit.recipientOrWithdrawer).toEqual(EthAddress.fromString(recipient));
      expect(selected.exit.isRecipient).toBe(true);
      expect(await governance.read.getWithdrawal([pending.exit.withdrawalId])).toEqual(withdrawal);

      // Finalization must wait for both the rollup exit delay and the governance withdrawal delay.
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
