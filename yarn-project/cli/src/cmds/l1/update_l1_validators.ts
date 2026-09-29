import { RollupAbi, StakingAssetHandlerAbi, TestERC20Abi } from '@aztec-foundation/l1-artifacts';

import { createEthereumChain, isAnvilTestChain } from '@aztec-labs/ethereum/chain';
import { createExtendedL1Client, getPublicClient, makeL1HttpTransport } from '@aztec-labs/ethereum/client';
import { getL1ContractsConfigEnvVars } from '@aztec-labs/ethereum/config';
import {
  type AttesterExitAuthorization,
  GSEContract,
  RegistryContract,
  RollupContract,
} from '@aztec-labs/ethereum/contracts';
import { createL1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import { EthCheatCodes } from '@aztec-labs/ethereum/test';
import { getActiveNetworkName } from '@aztec-labs/foundation/config';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import type { LogFn, Logger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { ZkPassportProofParams } from '@aztec-labs/stdlib/zkpassport';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, encodeFunctionData, formatEther, getContract, isHex, maxUint256 } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { getNetworkConfig } from '../../config/network_config.js';
import { atomicUpdateFile } from '../../utils/commands.js';
import { deriveEthAttester } from '../validator_keys/shared.js';

export interface RollupCommandArgs {
  rpcUrls: string[];
  chainId: number;
  privateKey?: string;
  mnemonic?: string;
  rollupAddress: EthAddress;
  withdrawerAddress?: EthAddress;
}

/** Credentials and derivation indices for a local Ethereum signer. */
export type SignerAccountArgs = {
  privateKey?: string;
  mnemonic?: string;
  accountIndex?: number;
  addressIndex?: number;
};

export interface StakingAssetHandlerCommandArgs {
  rpcUrls: string[];
  chainId: number;
  privateKey?: string;
  mnemonic?: string;
  stakingAssetHandlerAddress: EthAddress;
}

export interface LoggerArgs {
  log: LogFn;
  debugLogger: Logger;
}

export function generateL1Account() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    privateKey,
    address: account.address,
  };
}

export async function addL1Validator({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  attesterAddress,
  withdrawerAddress,
  stakingAssetHandlerAddress,
  proofParams,
  blsSecretKey,
  log,
  debugLogger,
}: StakingAssetHandlerCommandArgs &
  LoggerArgs & {
    blsSecretKey: bigint; // scalar field element of BN254
    attesterAddress: EthAddress;
    withdrawerAddress: EthAddress;
    proofParams: Buffer;
  }) {
  const dualLog = makeDualLog(log, debugLogger);
  const account = getAccount(privateKey, mnemonic);
  const chain = createEthereumChain(rpcUrls, chainId);
  const l1Client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);

  const stakingAssetHandler = getContract({
    address: stakingAssetHandlerAddress.toString(),
    abi: StakingAssetHandlerAbi,
    client: l1Client,
  });

  const rollupAddress = await stakingAssetHandler.read.getRollup();
  dualLog(`Adding validator ${attesterAddress} to rollup ${rollupAddress.toString()}`);

  const rollup = getContract({
    address: rollupAddress,
    abi: RollupAbi,
    client: l1Client,
  });

  const gseAddress = await rollup.read.getGSE();
  const gse = new GSEContract(l1Client, gseAddress);
  const registrationTuple = await gse.makeRegistrationTuple(blsSecretKey);

  const l1TxUtils = createL1TxUtils(l1Client, { logger: debugLogger });
  const proofParamsObj = ZkPassportProofParams.fromBuffer(proofParams);

  // Step 1: Claim STK tokens from the faucet
  dualLog(`Claiming STK tokens from faucet`);
  const { receipt: claimReceipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: stakingAssetHandlerAddress.toString(),
    data: encodeFunctionData({
      abi: StakingAssetHandlerAbi,
      functionName: 'claim',
      args: [proofParamsObj.toViem()],
    }),
    abi: StakingAssetHandlerAbi,
  });
  dualLog(`Claim transaction hash: ${claimReceipt.transactionHash}`);
  await l1Client.waitForTransactionReceipt({ hash: claimReceipt.transactionHash });

  // Step 2: Approve the rollup to spend STK tokens
  const stakingAssetAddress = await stakingAssetHandler.read.STAKING_ASSET();
  dualLog(`Approving rollup to spend STK tokens`);
  const { receipt: approveReceipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: stakingAssetAddress,
    data: encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'approve',
      args: [rollupAddress, maxUint256],
    }),
    abi: TestERC20Abi,
  });
  await l1Client.waitForTransactionReceipt({ hash: approveReceipt.transactionHash });

  // Step 3: Deposit into the rollup to register as a validator
  dualLog(`Depositing into rollup to register validator`);
  const { receipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: rollupAddress,
    data: encodeFunctionData({
      abi: RollupAbi,
      functionName: 'deposit',
      args: [
        attesterAddress.toString(),
        withdrawerAddress.toString(),
        registrationTuple.publicKeyInG1,
        registrationTuple.publicKeyInG2,
        registrationTuple.proofOfPossession,
        false, // moveWithLatestRollup
      ],
    }),
    abi: RollupAbi,
  });
  dualLog(`Deposit transaction hash: ${receipt.transactionHash}`);
  await l1Client.waitForTransactionReceipt({ hash: receipt.transactionHash });

  if (isAnvilTestChain(chainId)) {
    dualLog(`Funding validator on L1`);
    const cheatCodes = new EthCheatCodes(rpcUrls, new DateProvider(), debugLogger);
    await cheatCodes.setBalance(attesterAddress, 10n ** 20n);
  } else {
    const balance = await l1Client.getBalance({ address: attesterAddress.toString() });
    dualLog(`Validator balance: ${formatEther(balance)} ETH`);
    if (balance === 0n) {
      dualLog(`WARNING: Proposer has no balance. Remember to fund it!`);
    }
  }
}

export async function addL1ValidatorViaRollup({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  attesterAddress,
  withdrawerAddress,
  blsSecretKey,
  moveWithLatestRollup,
  rollupAddress,
  log,
  debugLogger,
}: RollupCommandArgs &
  LoggerArgs & {
    blsSecretKey: bigint; // scalar field element of BN254
    attesterAddress: EthAddress;
    moveWithLatestRollup: boolean;
  }) {
  const dualLog = makeDualLog(log, debugLogger);
  const account = getAccount(privateKey, mnemonic);
  const chain = createEthereumChain(rpcUrls, chainId);
  const l1Client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);

  dualLog(`Adding validator ${attesterAddress} to rollup ${rollupAddress.toString()} via direct deposit`);

  if (!withdrawerAddress) {
    throw new Error(`Withdrawer address required`);
  }

  const rollup = getContract({
    address: rollupAddress.toString(),
    abi: RollupAbi,
    client: l1Client,
  });

  const gseAddress = await rollup.read.getGSE();

  const gse = new GSEContract(l1Client, gseAddress);

  const registrationTuple = await gse.makeRegistrationTuple(blsSecretKey);

  const l1TxUtils = createL1TxUtils(l1Client, { logger: debugLogger });

  const { receipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: rollupAddress.toString(),
    data: encodeFunctionData({
      abi: RollupAbi,
      functionName: 'deposit',
      args: [
        attesterAddress.toString(),
        withdrawerAddress.toString(),
        registrationTuple.publicKeyInG1,
        registrationTuple.publicKeyInG2,
        registrationTuple.proofOfPossession,
        moveWithLatestRollup,
      ],
    }),
    abi: StakingAssetHandlerAbi,
  });
  dualLog(`Transaction hash: ${receipt.transactionHash}`);
  await l1Client.waitForTransactionReceipt({ hash: receipt.transactionHash });
  if (isAnvilTestChain(chainId)) {
    dualLog(`Funding validator on L1`);
    const cheatCodes = new EthCheatCodes(rpcUrls, new DateProvider(), debugLogger);
    await cheatCodes.setBalance(attesterAddress, 10n ** 20n);
  } else {
    const balance = await l1Client.getBalance({ address: attesterAddress.toString() });
    dualLog(`Validator balance: ${formatEther(balance)} ETH`);
    if (balance === 0n) {
      dualLog(`WARNING: Proposer has no balance. Remember to fund it!`);
    }
  }
}

export async function removeL1Validator({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  validatorAddress,
  rollupAddress,
  log,
  debugLogger,
}: RollupCommandArgs & LoggerArgs & { validatorAddress: EthAddress }) {
  const dualLog = makeDualLog(log, debugLogger);
  const account = getAccount(privateKey, mnemonic);
  const chain = createEthereumChain(rpcUrls, chainId);
  const l1Client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);
  const l1TxUtils = createL1TxUtils(l1Client, { logger: debugLogger });

  dualLog(`Removing validator ${validatorAddress.toString()} from rollup ${rollupAddress.toString()}`);
  const { receipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: rollupAddress.toString(),
    data: encodeFunctionData({
      abi: RollupAbi,
      functionName: 'initiateWithdraw',
      args: [validatorAddress.toString(), validatorAddress.toString()],
    }),
  });
  dualLog(`Transaction hash: ${receipt.transactionHash}`);
}

/** Chain ID and registry published for a network; both are undefined when it publishes none, as for `local`. */
export type AttesterExitNetwork = {
  name: string;
  l1ChainId?: number;
  registryAddress?: EthAddress;
};

/** Loads the published config of the network selected with --network, which takes precedence over the environment. */
export async function getAttesterExitNetwork(name: string): Promise<AttesterExitNetwork> {
  const networkName = getActiveNetworkName(name);
  const cacheDir = process.env.DATA_DIRECTORY ? join(process.env.DATA_DIRECTORY, 'cache') : undefined;
  const config = networkName === 'local' ? undefined : await getNetworkConfig(networkName, cacheDir);
  if (networkName !== 'local' && !config) {
    throw new Error(`Network ${networkName} has no published config`);
  }
  return {
    name: networkName,
    l1ChainId: config?.l1ChainId,
    registryAddress: config ? EthAddress.fromString(config.registryAddress) : undefined,
  };
}

/** Inputs that select the chain and rollup an attester exit is signed for; each is undefined when not supplied. */
export type AttesterExitTargetArgs = {
  chainId?: number;
  /** Whether `chainId` came from the L1_CHAIN_ID environment variable rather than a flag. */
  chainIdFromEnv?: boolean;
  rpcUrls?: string[];
  network?: AttesterExitNetwork;
  rollupAddress?: EthAddress;
  log: LogFn;
};

/**
 * Resolves the chain ID and rollup an attester exit is signed for, without falling back to the Anvil chain ID.
 * Whenever an RPC is given, its chain ID must match. Without one, signing is offline and needs the chain ID from a flag
 * or --network; an L1_CHAIN_ID left in the environment alone is rejected because nothing confirms it.
 */
export async function resolveAttesterExitTarget({
  chainId,
  chainIdFromEnv = false,
  rpcUrls,
  network,
  rollupAddress,
  log,
}: AttesterExitTargetArgs): Promise<{ chainId: number; rollupAddress: EthAddress }> {
  if (!rollupAddress && !network) {
    throw new Error('Provide --rollup, or --network to use the canonical rollup from the network registry');
  }
  if (!rollupAddress && !network?.registryAddress) {
    throw new Error(`Network ${network?.name} publishes no registry address; provide --rollup`);
  }
  if (chainId !== undefined) {
    assertValidChainId(chainId);
    if (network?.l1ChainId !== undefined && chainId !== network.l1ChainId) {
      throw new Error(`Chain ID ${chainId} does not match ${network.name}, which uses chain ID ${network.l1ChainId}`);
    }
  }
  const expectedChainId = chainId ?? network?.l1ChainId;
  if (!rpcUrls) {
    if (expectedChainId === undefined) {
      throw new Error('Provide --l1-chain-id, --network, or --l1-rpc-urls to select the chain to sign for');
    }
    if (!rollupAddress) {
      throw new Error('Looking up the rollup in the network registry requires --l1-rpc-urls');
    }
    if (chainIdFromEnv && network?.l1ChainId === undefined) {
      throw new Error(
        `Chain ID ${expectedChainId} comes only from L1_CHAIN_ID; confirm it with --l1-chain-id, --network, or --l1-rpc-urls`,
      );
    }
    return { chainId: expectedChainId, rollupAddress };
  }
  const rpcChainId = await createPublicClient({ transport: makeL1HttpTransport(rpcUrls) }).getChainId();
  if (expectedChainId !== undefined && rpcChainId !== expectedChainId) {
    throw new Error(`The L1 RPC reports chain ID ${rpcChainId}, but chain ID ${expectedChainId} was requested`);
  }
  if (rollupAddress) {
    return { chainId: rpcChainId, rollupAddress };
  }
  const registryAddress = network!.registryAddress!;
  const client = getPublicClient({ l1RpcUrls: rpcUrls, l1ChainId: rpcChainId });
  const canonicalRollup = await new RegistryContract(client, registryAddress).getCanonicalAddress();
  log(`Using canonical rollup ${canonicalRollup} from the ${network!.name} registry ${registryAddress}`);
  return { chainId: rpcChainId, rollupAddress: canonicalRollup };
}

/** Signs an exit authorization locally and writes a JSON array accepted by the batch command. */
export async function signAttesterExit({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  accountIndex,
  addressIndex,
  rollupAddress,
  attesterAddress,
  deadline,
  output,
  append = false,
  log,
}: Omit<RollupCommandArgs, 'withdrawerAddress' | 'mnemonic' | 'privateKey'> &
  SignerAccountArgs & {
    attesterAddress: EthAddress;
    deadline: bigint;
    output: string;
    append?: boolean;
    log: LogFn;
  }) {
  assertValidChainId(chainId);
  const account = getSignerAccount({ privateKey, mnemonic, accountIndex, addressIndex });
  if (account.address.toLowerCase() !== attesterAddress.toString().toLowerCase()) {
    throw new Error('The signing account must match the attester address');
  }
  const chain = createEthereumChain(rpcUrls, chainId);
  const client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);
  const rollup = new RollupContract(client, rollupAddress);
  const authorization = await rollup.createAttesterExitAuthorization(attesterAddress, deadline, typedData =>
    account.signTypedData(typedData),
  );
  const existingAuthorizations = append
    ? await readAttesterExitAuthorizationJson(output).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== 'ENOENT') {
          throw error;
        }
        return undefined;
      })
    : undefined;
  const authorizations = existingAuthorizations ?? [];
  authorizations.push({
    attester: authorization.attester.toString(),
    deadline: authorization.deadline.toString(),
    signature: Signature.fromViemSignature(authorization.signature).toString(),
  });
  const json = JSON.stringify(authorizations, null, 2);
  if (existingAuthorizations) {
    await atomicUpdateFile(output, `${json}\n`);
  } else {
    await writeFile(output, `${json}\n`, { flag: 'wx' });
  }
  log(`Wrote attester exit authorization to ${output}`);
}

/** Reads relayed attester exit authorizations from a JSON array. */
export async function readAttesterExitAuthorizations(path: string): Promise<AttesterExitAuthorization[]> {
  const parsed = await readAttesterExitAuthorizationJson(path);
  if (parsed.length === 0) {
    throw new Error('Attester exit authorization file must contain a non-empty JSON array');
  }
  return parsed.map((value, index) => parseAttesterExitAuthorization(value, index));
}

async function readAttesterExitAuthorizationJson(path: string): Promise<unknown[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Attester exit authorization file must contain a JSON array');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAttesterExitAuthorization(value: unknown, index: number): AttesterExitAuthorization {
  if (!isRecord(value)) {
    throw new Error(`Attester exit authorization ${index} must be an object`);
  }

  const authorization = value;
  if (typeof authorization.attester !== 'string') {
    throw new Error(`Attester exit authorization ${index} has an invalid attester`);
  }
  if (typeof authorization.deadline !== 'string' || !/^\d+$/.test(authorization.deadline)) {
    throw new Error(`Attester exit authorization ${index} deadline must be a decimal string`);
  }
  if (
    typeof authorization.signature !== 'string' ||
    !isHex(authorization.signature) ||
    !Signature.isValidString(authorization.signature)
  ) {
    throw new Error(`Attester exit authorization ${index} has an invalid signature`);
  }

  return {
    attester: EthAddress.fromString(authorization.attester),
    deadline: BigInt(authorization.deadline),
    signature: Signature.fromString(authorization.signature).toViemSignature(),
  };
}

/** Relays a batch of attester-signed exits. */
export async function initiateWithdrawByAttesterBatch({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  accountIndex,
  addressIndex,
  authorizations,
  upToLimit,
  dryRun = false,
  rollupAddress,
  log,
  debugLogger,
}: Omit<RollupCommandArgs, 'withdrawerAddress' | 'mnemonic' | 'privateKey'> &
  SignerAccountArgs &
  LoggerArgs & {
    authorizations: AttesterExitAuthorization[];
    upToLimit: boolean;
    dryRun?: boolean;
  }) {
  if (dryRun) {
    assertValidChainId(chainId);
    // A dry run needs no key, but check any signer options given so the same command can later run without --dry-run.
    if (privateKey || mnemonic || accountIndex !== undefined || addressIndex !== undefined) {
      getSignerAccount({ privateKey, mnemonic, accountIndex, addressIndex });
    }
    const client = getPublicClient({ l1RpcUrls: rpcUrls, l1ChainId: chainId });
    const rollup = new RollupContract(client, rollupAddress);
    const processedCount = await rollup.simulateAttesterExitBatch(authorizations, upToLimit);
    log(
      `Dry run: would process ${processedCount} of ${authorizations.length} attester exit authorizations at current chain state.`,
    );
    logRemainingAttesterExits(log, processedCount, authorizations.length);
    return;
  }
  const account = getSignerAccount({ privateKey, mnemonic, accountIndex, addressIndex });
  const client = createExtendedL1Client(rpcUrls, account, createEthereumChain(rpcUrls, chainId).chainInfo);
  const rollup = new RollupContract(client, rollupAddress);
  const l1TxUtils = createL1TxUtils(client, { logger: debugLogger });
  const { receipt, processedCount, remainingCount } = await rollup.submitAttesterExitBatch(
    l1TxUtils,
    authorizations,
    upToLimit,
  );
  log(
    `Processed ${processedCount} of ${authorizations.length} attester exit authorizations. Transaction hash: ${receipt.transactionHash}`,
  );
  logRemainingAttesterExits(log, processedCount, authorizations.length);
  debugLogger.info('Attester exit batch processed', {
    authorizationCount: authorizations.length,
    processedCount,
    remainingCount,
    remainingStartIndex: remainingCount > 0 ? processedCount : undefined,
    remainingEndIndexExclusive: remainingCount > 0 ? authorizations.length : undefined,
    upToLimit,
    rollup: rollupAddress.toString(),
    transactionHash: receipt.transactionHash,
  });
  return receipt;
}

/** Initiates an attester exit without changing the registered withdrawer's control over the payout. */
export async function initiateWithdrawByAttester({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  accountIndex,
  addressIndex,
  attesterAddress,
  rollupAddress,
  log,
  debugLogger,
}: Omit<RollupCommandArgs, 'withdrawerAddress' | 'mnemonic' | 'privateKey'> &
  SignerAccountArgs &
  LoggerArgs & {
    attesterAddress: EthAddress;
  }) {
  const account = getSignerAccount({ privateKey, mnemonic, accountIndex, addressIndex });
  if (account.address.toLowerCase() !== attesterAddress.toString().toLowerCase()) {
    throw new Error('The transaction signer must match the attester address');
  }
  const chain = createEthereumChain(rpcUrls, chainId);
  const client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);
  const rollup = new RollupContract(client, rollupAddress);
  const l1TxUtils = createL1TxUtils(client, { logger: debugLogger });
  const { receipt } = await rollup.initiateWithdrawByAttester(l1TxUtils, attesterAddress);
  if (receipt.status !== 'success') {
    throw new Error(`Attester exit reverted: ${receipt.transactionHash}`);
  }
  log(`Attester exit initiated for ${attesterAddress}. Transaction hash: ${receipt.transactionHash}`);
  log('The registered withdrawer must select a recipient using initiateWithdraw before finalization.');
  debugLogger.info('Attester exit initiated', {
    attester: attesterAddress.toString(),
    rollup: rollupAddress.toString(),
    transactionHash: receipt.transactionHash,
  });
  return receipt;
}

export async function pruneRollup({
  rpcUrls,
  chainId,
  privateKey,
  mnemonic,
  rollupAddress,
  log,
  debugLogger,
}: RollupCommandArgs & LoggerArgs) {
  const dualLog = makeDualLog(log, debugLogger);
  const account = getAccount(privateKey, mnemonic);
  const chain = createEthereumChain(rpcUrls, chainId);
  const l1Client = createExtendedL1Client(rpcUrls, account, chain.chainInfo);
  const l1TxUtils = createL1TxUtils(l1Client, { logger: debugLogger });

  dualLog(`Trying prune`);
  const { receipt } = await l1TxUtils.sendAndMonitorTransaction({
    to: rollupAddress.toString(),
    data: encodeFunctionData({
      abi: RollupAbi,
      functionName: 'prune',
    }),
  });
  dualLog(`Transaction hash: ${receipt.transactionHash}`);
}

export async function fastForwardEpochs({
  rpcUrls,
  chainId,
  rollupAddress,
  numEpochs,
  log,
  debugLogger,
}: RollupCommandArgs & LoggerArgs & { numEpochs: bigint }) {
  const dualLog = makeDualLog(log, debugLogger);
  const publicClient = getPublicClient({ l1RpcUrls: rpcUrls, l1ChainId: chainId });
  const rollup = getContract({
    address: rollupAddress.toString(),
    abi: RollupAbi,
    client: publicClient,
  });

  const cheatCodes = new EthCheatCodes(rpcUrls, new DateProvider(), debugLogger);
  const currentSlot = await rollup.read.getCurrentSlot();
  const l2SlotsInEpoch = await rollup.read.getEpochDuration();
  const timestamp = await rollup.read.getTimestampForSlot([currentSlot + l2SlotsInEpoch * numEpochs]);
  dualLog(`Fast forwarding ${numEpochs} epochs to ${timestamp}`);
  try {
    await cheatCodes.warp(Number(timestamp), { resetBlockInterval: true });
    dualLog(`Fast forwarded ${numEpochs} epochs to ${timestamp}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("is lower than or equal to previous block's timestamp")) {
      dualLog(`Someone else fast forwarded the chain to a point after/equal to the target time`);
    } else {
      // Re-throw other errors
      throw error;
    }
  }
}

export async function debugRollup({ rpcUrls, chainId, rollupAddress, log }: RollupCommandArgs & LoggerArgs) {
  const config = getL1ContractsConfigEnvVars();
  const publicClient = getPublicClient({ l1RpcUrls: rpcUrls, l1ChainId: chainId });
  const rollup = new RollupContract(publicClient, rollupAddress);

  const pendingNum = await rollup.getCheckpointNumber();
  log(`Pending block num: ${pendingNum}`);
  const provenNum = await rollup.getProvenCheckpointNumber();
  log(`Proven block num: ${provenNum}`);
  const validators = await rollup.getAttesters();
  log(`Validators: ${validators.map(v => v.toString()).join(', ')}`);
  const committee = await rollup.getCurrentEpochCommittee();
  log(`Committee: ${committee?.map(v => v.toString()).join(', ')}`);
  const archive = await rollup.archive();
  log(`Archive: ${archive}`);
  const epochNum = await rollup.getCurrentEpochNumber();
  log(`Current epoch: ${epochNum}`);
  const slot = await rollup.getSlotNumber();
  log(`Current slot: ${slot}`);
  const proposerDuringPrevL1Block = await rollup.getCurrentProposer();
  log(`Proposer during previous L1 block: ${proposerDuringPrevL1Block}`);
  const nextBlockTS = BigInt((await publicClient.getBlock()).timestamp + BigInt(config.ethereumSlotDuration));
  const proposer = await rollup.getProposerAt(nextBlockTS);
  log(`Proposer NOW: ${proposer.toString()}`);
}

function logRemainingAttesterExits(log: LogFn, processedCount: number, authorizationCount: number) {
  const remainingCount = authorizationCount - processedCount;
  log(
    remainingCount > 0
      ? `Remaining authorizations: ${remainingCount}. Zero-based JSON array indices ${processedCount} through ${authorizationCount - 1} (inclusive).`
      : 'Remaining authorizations: 0 (none).',
  );
}

function makeDualLog(log: LogFn, debugLogger: Logger) {
  return (msg: string) => {
    log(msg);
    debugLogger.info(msg);
  };
}

/** `createEthereumChain` maps a falsy chain ID to Anvil, so reject it before a chain is built from it. */
function assertValidChainId(chainId: number) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('Chain ID must be a positive safe integer');
  }
}

function getSignerAccount({ privateKey, mnemonic, accountIndex, addressIndex }: SignerAccountArgs) {
  if (Boolean(privateKey) === Boolean(mnemonic)) {
    throw new Error('Provide either a private key or a mnemonic for the signer');
  }
  if (privateKey) {
    if (accountIndex !== undefined || addressIndex !== undefined) {
      throw new Error('Account and address indices require a mnemonic');
    }
    return getAccount(privateKey, undefined);
  }
  const selectedAccountIndex = accountIndex ?? 0;
  const selectedAddressIndex = addressIndex ?? 0;
  if (
    !Number.isSafeInteger(selectedAccountIndex) ||
    selectedAccountIndex < 0 ||
    !Number.isSafeInteger(selectedAddressIndex) ||
    selectedAddressIndex < 0
  ) {
    throw new Error('Account and address indices must be non-negative safe integers');
  }
  const derivedKey = deriveEthAttester(mnemonic!, selectedAccountIndex, selectedAddressIndex);
  if (typeof derivedKey !== 'string') {
    throw new Error('Expected a local signer private key');
  }
  return privateKeyToAccount(derivedKey);
}

function getAccount(privateKey: string | undefined, mnemonic: string | undefined) {
  if (!privateKey && !mnemonic) {
    throw new Error('Either privateKey or mnemonic must be provided to create a wallet client');
  }
  const account = !privateKey
    ? mnemonicToAccount(mnemonic!)
    : privateKeyToAccount(`${privateKey.startsWith('0x') ? '' : '0x'}${privateKey}` as `0x${string}`);
  return account;
}
