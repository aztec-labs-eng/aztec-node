import { GovernanceAbi, RollupAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { getContract, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { createExtendedL1Client, getPublicClient } from '../client.js';
import { DefaultL1ContractsConfig } from '../config.js';
import { deployAztecL1Contracts } from '../deploy_aztec_l1_contracts.js';
import { createL1TxUtils } from '../l1_tx_utils/index.js';
import { type Anvil, EthCheatCodes, startAnvil } from '../test/index.js';
import { AttesterStatus, RollupContract } from './index.js';

const mnemonic = 'test test test test test test test test test test test junk';
const attesters = [0, 3, 4].map(addressIndex => mnemonicToAccount(mnemonic, { addressIndex }));
const withdrawer = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const recipient = mnemonicToAccount(mnemonic, { addressIndex: 2 }).address;
// Accounts 0–4 are the attesters, withdrawer, and recipient; keep the deployer separate from those roles.
const deployer = mnemonicToAccount(mnemonic, { addressIndex: 5 });
const deployerPrivateKey = toHex(deployer.getHdKey().privateKey!);
const logger = createLogger('ethereum:test:attester-exit');

describe('attester exit client integration', () => {
  let anvil: Anvil;

  afterEach(async () => {
    await anvil?.stop();
  });

  async function setupExit(validatorCount: number, initialAllowance: number) {
    const { anvil: startedAnvil, rpcUrl } = await startAnvil();
    anvil = startedAnvil;
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
    const attesterClient = createExtendedL1Client([rpcUrl], attesters[0], foundry);
    const withdrawerClient = createExtendedL1Client([rpcUrl], withdrawer, foundry);
    const rollup = new RollupContract(attesterClient, l1ContractAddresses.rollupAddress);
    const publicRollup = new RollupContract(
      getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id }),
      l1ContractAddresses.rollupAddress,
    );
    const target = EthAddress.fromString(attesters[0].address);
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
      allowance: BigInt(initialAllowance),
      canExit: true,
    });
    expect(await rollup.getAttesterExitWindow()).toBe(before.window);

    return {
      rpcUrl,
      validatorCount,
      initialAllowance,
      attesterClient,
      withdrawerClient,
      rollup,
      publicRollup,
      target,
      token,
      governance,
      ownerRollup,
      original,
      recipientBalance,
    };
  }

  type ExitContext = Awaited<ReturnType<typeof setupExit>>;

  async function createAuthorizations({ rollup, attesterClient }: ExitContext) {
    const deadline = (await attesterClient.getBlock()).timestamp + 3600n;
    const authorizations = await Promise.all(
      attesters.map(account =>
        rollup.createAttesterExitAuthorization(EthAddress.fromString(account.address), deadline, data =>
          account.signTypedData(data),
        ),
      ),
    );
    return { deadline, authorizations };
  }

  async function expectPendingExit(
    { rollup, target, token, original, recipientBalance, validatorCount, initialAllowance }: ExitContext,
    exitCount: number,
  ) {
    const pending = await rollup.getAttesterView(target);
    expect(pending.status).toBe(AttesterStatus.ZOMBIE);
    expect(pending.exit).toMatchObject({
      exists: true,
      isRecipient: false,
      recipientOrWithdrawer: EthAddress.fromString(withdrawer.address),
      amount: original.effectiveBalance,
    });
    expect(await token.read.balanceOf([recipient])).toBe(recipientBalance);
    expect(await rollup.getAttesterExitLimitState()).toMatchObject({
      validatorCount: BigInt(validatorCount - exitCount),
      used: BigInt(exitCount),
      allowance: BigInt(initialAllowance - 1),
      canExit: false,
    });
    return pending;
  }

  async function expectBatchExits(context: ExitContext) {
    const { rollup, original } = context;
    const second = await rollup.getAttesterView(EthAddress.fromString(attesters[1].address));
    expect(second.status).toBe(AttesterStatus.ZOMBIE);
    expect(second.exit).toMatchObject({
      exists: true,
      isRecipient: false,
      recipientOrWithdrawer: EthAddress.fromString(withdrawer.address),
      amount: original.effectiveBalance,
    });
    expect(await rollup.getAttesterView(EthAddress.fromString(attesters[2].address))).toMatchObject({
      exit: { exists: false },
      status: original.status,
    });
    await expectPendingExit(context, 2);
  }

  it('lets the attester start a direct exit and the withdrawer select a recipient after both delays', async () => {
    const context = await setupExit(21, 1);
    const {
      rpcUrl,
      attesterClient,
      withdrawerClient,
      rollup,
      target,
      governance,
      ownerRollup,
      token,
      recipientBalance,
    } = context;

    const notRollup = new RollupContract(attesterClient, EthAddress.fromString(deployer.address));
    const nonce = await attesterClient.getTransactionCount({ address: attesters[0].address });
    await expect(
      notRollup.initiateWithdrawByAttester(createL1TxUtils(attesterClient, { logger }), target),
    ).rejects.toThrow('No rollup');
    expect(await attesterClient.getTransactionCount({ address: attesters[0].address })).toBe(nonce);

    const { receipt } = await rollup.initiateWithdrawByAttester(createL1TxUtils(attesterClient, { logger }), target);
    expect(receipt.status).toBe('success');
    const pending = await expectPendingExit(context, 1);
    const withdrawal = await governance.read.getWithdrawal([pending.exit.withdrawalId]);

    await expect(
      attesterClient.simulateContract({
        address: rollup.address,
        abi: RollupAbi,
        functionName: 'initiateWithdraw',
        args: [attesters[0].address, recipient],
      }),
    ).rejects.toThrow('Staking__NotWithdrawer');

    const selection = await ownerRollup.write.initiateWithdraw([attesters[0].address, recipient]);
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
        args: [attesters[0].address],
      }),
    ).rejects.toThrow();
    await cheatCodes.warp(unlock);
    const finalized = await ownerRollup.write.finalizeWithdraw([attesters[0].address]);
    expect((await withdrawerClient.waitForTransactionReceipt({ hash: finalized })).status).toBe('success');
    expect(await token.read.balanceOf([recipient])).toBe(recipientBalance + pending.exit.amount);
    expect((await rollup.getAttesterView(target)).exit.exists).toBe(false);
  }, 240_000);

  it('relays a signed exit and leaves the other attesters untouched', async () => {
    const context = await setupExit(21, 1);
    const { rollup, withdrawerClient } = context;
    const { authorizations } = await createAuthorizations(context);

    const { receipt } = await rollup.initiateWithdrawByAttesterWithSignature(
      createL1TxUtils(withdrawerClient, { logger }),
      authorizations[0],
    );
    expect(receipt.status).toBe('success');
    await expectPendingExit(context, 1);
    for (const account of attesters.slice(1)) {
      const untouched = await rollup.getAttesterView(EthAddress.fromString(account.address));
      expect(untouched.exit.exists).toBe(false);
      expect(untouched.status).toBe(context.original.status);
    }
  }, 240_000);

  it('rejects invalid atomic batches and submits a valid batch', async () => {
    const context = await setupExit(42, 2);
    const { rollup, publicRollup, withdrawerClient, target } = context;
    const { deadline, authorizations } = await createAuthorizations(context);
    const authorization = authorizations[0];
    const typedData = rollup.buildAttesterExitTypedData(target, deadline);
    const wrongChain = Signature.fromString(
      await attesters[0].signTypedData({
        ...typedData,
        domain: { ...typedData.domain, chainId: 1 },
      }),
    ).toViemSignature();
    const wrongRollup = Signature.fromString(
      await attesters[0].signTypedData({
        ...typedData,
        domain: { ...typedData.domain, verifyingContract: deployer.address },
      }),
    ).toViemSignature();
    const highS = {
      ...authorization.signature,
      s: toHex(secp256k1.CURVE.n - BigInt(authorization.signature.s), { size: 32 }),
      v: authorization.signature.v === 27 ? 28 : 27,
    };
    const ineligible = await rollup.createAttesterExitAuthorization(
      EthAddress.fromString(deployer.address),
      deadline,
      data => deployer.signTypedData(data),
    );
    for (const [invalid, error] of [
      [{ ...authorization, signature: wrongChain }, 'SignatureLib__InvalidSignature'],
      [{ ...authorization, signature: wrongRollup }, 'SignatureLib__InvalidSignature'],
      [{ ...authorization, signature: highS }, 'ECDSAInvalidSignatureS'],
      [{ ...authorization, deadline: 0n }, 'Staking__AttesterExitAuthorizationExpired'],
      [ineligible, 'Staking__NothingToExit'],
    ] as const) {
      await expect(publicRollup.simulateAttesterExitBatch([invalid])).rejects.toThrow(error);
    }
    await expect(publicRollup.simulateAttesterExitBatch([authorization, authorization])).rejects.toThrow(
      'Staking__AlreadyExiting',
    );
    await expect(publicRollup.simulateAttesterExitBatch(authorizations)).rejects.toThrow(
      'Staking__AttesterExitLimitExceeded',
    );
    for (const account of attesters) {
      expect((await rollup.getAttesterView(EthAddress.fromString(account.address))).exit.exists).toBe(false);
    }
    expect(await rollup.getAttesterExitLimitState()).toMatchObject({ used: 0n });

    const batch = authorizations.slice(0, 2);
    const notRollup = new RollupContract(withdrawerClient, EthAddress.fromString(deployer.address));
    const nonce = await withdrawerClient.getTransactionCount({ address: withdrawer.address });
    for (const upToLimit of [false, true]) {
      await expect(notRollup.simulateAttesterExitBatch(batch, upToLimit)).rejects.toThrow('No rollup');
      await expect(
        notRollup.submitAttesterExitBatch(createL1TxUtils(withdrawerClient, { logger }), batch, upToLimit),
      ).rejects.toThrow('No rollup');
    }
    expect(await withdrawerClient.getTransactionCount({ address: withdrawer.address })).toBe(nonce);

    expect(await publicRollup.simulateAttesterExitBatch(batch)).toBe(2);
    expect(await rollup.getAttesterExitLimitState()).toMatchObject({ used: 0n });
    expect((await rollup.getAttesterView(target)).exit.exists).toBe(false);
    const result = await rollup.submitAttesterExitBatch(createL1TxUtils(withdrawerClient, { logger }), batch);
    expect(result).toMatchObject({
      receipt: { status: 'success' },
      processedCount: 2,
      remainingCount: 0,
      remainingStartIndex: undefined,
      remainingEndIndexExclusive: undefined,
    });
    await expectBatchExits(context);
  }, 240_000);

  it('submits only the permitted prefix and reports the unprocessed suffix', async () => {
    const context = await setupExit(42, 2);
    const { rollup, publicRollup, withdrawerClient, target } = context;
    const { authorizations } = await createAuthorizations(context);

    expect(await publicRollup.simulateAttesterExitBatch(authorizations, true)).toBe(2);
    expect(await rollup.getAttesterExitLimitState()).toMatchObject({ used: 0n });
    expect((await rollup.getAttesterView(target)).exit.exists).toBe(false);
    const result = await rollup.submitAttesterExitBatch(
      createL1TxUtils(withdrawerClient, { logger }),
      authorizations,
      true,
    );
    expect(result).toMatchObject({
      receipt: { status: 'success' },
      processedCount: 2,
      remainingCount: 1,
      remainingStartIndex: 2,
      remainingEndIndexExclusive: 3,
    });
    await expectBatchExits(context);

    expect(await publicRollup.simulateAttesterExitBatch(authorizations.slice(2), true)).toBe(0);
    const retryNonce = await withdrawerClient.getTransactionCount({ address: withdrawer.address });
    const retry = await rollup.submitAttesterExitBatch(
      createL1TxUtils(withdrawerClient, { logger }),
      authorizations.slice(2),
      true,
    );
    expect(await withdrawerClient.getTransactionCount({ address: withdrawer.address })).toBe(retryNonce + 1);
    expect(retry).toMatchObject({
      receipt: { status: 'success' },
      processedCount: 0,
      remainingCount: 1,
      remainingStartIndex: 0,
      remainingEndIndexExclusive: 1,
    });
  }, 240_000);
});
