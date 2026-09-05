import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import type { FieldsOf } from '@aztec-labs/foundation/types';
import { fileURLToPath } from '@aztec-labs/foundation/url';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { type CircuitSimulator, NativeACVMSimulator, WASMSimulatorWithBlobs } from '@aztec-labs/simulator/server';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { CheckpointConstantData } from '@aztec-labs/stdlib/rollup';
import { GlobalVariables } from '@aztec-labs/stdlib/tx';
import { promises as fs } from 'fs';
import path from 'path';

const {
  TEMP_DIR = '/tmp',
  BB_BINARY_PATH = '',
  BB_WORKING_DIRECTORY = '',
  BB_SKIP_CLEANUP = '',
  NOIR_EXECUTE_BINARY_PATH = '',
  NOIR_EXECUTE_WORKING_DIRECTORY = '',
} = process.env;

// Determines if we have access to the bb binary and a tmp folder for temp files
export const getEnvironmentConfig = async (logger: Logger) => {
  try {
    const expectedBBPath = BB_BINARY_PATH
      ? BB_BINARY_PATH
      : `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../labs-aztec-toolchain/bin')}/bb-avm`;
    await fs.access(expectedBBPath, fs.constants.R_OK);
    const tempWorkingDirectory = `${TEMP_DIR}/${randomBytes(4).toString('hex')}`;
    const bbWorkingDirectory = BB_WORKING_DIRECTORY ? BB_WORKING_DIRECTORY : `${tempWorkingDirectory}/bb`;
    await fs.mkdir(bbWorkingDirectory, { recursive: true });
    logger.info(`Found native BB binary at ${expectedBBPath} with working directory ${bbWorkingDirectory}`);

    const expectedNoirExecutePath = NOIR_EXECUTE_BINARY_PATH
      ? NOIR_EXECUTE_BINARY_PATH
      : `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../labs-aztec-toolchain/bin')}/noir-execute`;
    await fs.access(expectedNoirExecutePath, fs.constants.R_OK);
    const noirExecuteWorkingDirectory = NOIR_EXECUTE_WORKING_DIRECTORY
      ? NOIR_EXECUTE_WORKING_DIRECTORY
      : `${tempWorkingDirectory}/noir-execute`;
    await fs.mkdir(noirExecuteWorkingDirectory, { recursive: true });
    logger.info(`Found noir-execute binary at ${expectedNoirExecutePath}`, {
      noirExecuteBinaryPath: expectedNoirExecutePath,
      noirExecuteWorkingDirectory,
    });

    const bbSkipCleanup = ['1', 'true'].includes(BB_SKIP_CLEANUP);
    bbSkipCleanup && logger.verbose(`Not going to clean up BB working directory ${bbWorkingDirectory} after run`);

    return {
      noirExecuteWorkingDirectory,
      bbWorkingDirectory,
      expectedNoirExecutePath,
      expectedBBPath,
      directoryToCleanup: NOIR_EXECUTE_WORKING_DIRECTORY && BB_WORKING_DIRECTORY ? undefined : tempWorkingDirectory,
      bbSkipCleanup,
    };
  } catch (err) {
    logger.info(`Native BB not available: ${err}`);
    return undefined;
  }
};

export async function getSimulator(
  config: { noirExecuteWorkingDirectory: string | undefined; noirExecuteBinaryPath: string | undefined },
  logger?: Logger,
): Promise<CircuitSimulator> {
  if (config.noirExecuteBinaryPath && config.noirExecuteWorkingDirectory) {
    try {
      await fs.access(config.noirExecuteBinaryPath, fs.constants.R_OK);
      await fs.mkdir(config.noirExecuteWorkingDirectory, { recursive: true });
      logger?.info(`Using noir-execute at ${config.noirExecuteBinaryPath}`, {
        noirExecuteBinaryPath: config.noirExecuteBinaryPath,
        noirExecuteWorkingDirectory: config.noirExecuteWorkingDirectory,
      });
      const noirExecuteLogger = logger?.createChild('noir-execute');
      return new NativeACVMSimulator(
        config.noirExecuteWorkingDirectory,
        config.noirExecuteBinaryPath,
        undefined,
        noirExecuteLogger,
      );
    } catch {
      logger?.warn(`Failed to access noir-execute at ${config.noirExecuteBinaryPath}, falling back to WASM`, {
        noirExecuteBinaryPath: config.noirExecuteBinaryPath,
      });
    }
  }
  logger?.info('Using WASM ACVM simulation');
  return new WASMSimulatorWithBlobs();
}

export const makeGlobals = (
  blockNumber: number,
  slotNumber = blockNumber,
  overrides: Partial<FieldsOf<GlobalVariables> & FieldsOf<CheckpointConstantData>> = {},
) => {
  const checkpointConstants = makeCheckpointConstants(slotNumber, overrides);
  return GlobalVariables.from({
    chainId: checkpointConstants.chainId,
    version: checkpointConstants.version,
    blockNumber: BlockNumber(blockNumber) /** block number */,
    slotNumber: SlotNumber(slotNumber) /** slot number */,
    timestamp: BigInt(blockNumber * 123) /** block number * 123 as pseudo-timestamp for testing */,
    coinbase: checkpointConstants.coinbase,
    feeRecipient: checkpointConstants.feeRecipient,
    gasFees: checkpointConstants.gasFees,
    ...overrides,
  });
};

export const makeCheckpointConstants = (
  slotNumber: number,
  overrides: Partial<FieldsOf<CheckpointConstantData>> = {},
) => {
  return CheckpointConstantData.from({
    chainId: Fr.ZERO,
    version: Fr.ZERO,
    vkTreeRoot: getVKTreeRoot(),
    protocolContractsHash,
    proverId: Fr.ZERO,
    slotNumber: SlotNumber(slotNumber),
    coinbase: EthAddress.ZERO,
    feeRecipient: AztecAddress.ZERO,
    gasFees: GasFees.empty(),
    ...overrides,
  });
};
