import type { Logger } from '@aztec-labs/aztec.js/log';
import { parseBooleanEnv } from '@aztec-labs/foundation/config';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { tryRmDir } from '@aztec-labs/foundation/fs';
import { promises as fs } from 'fs';

export { deployAndInitializeTokenAndBridgeContracts } from '../shared/cross_chain_test_harness.js';

const {
  TEMP_DIR = '/tmp',
  NOIR_EXECUTE_BINARY_PATH = '',
  NOIR_EXECUTE_WORKING_DIRECTORY = '',
  ACVM_FORCE_WASM = '',
} = process.env;

// Determines if we have access to the noir-execute binary and a tmp folder for temp files
export async function getNoirExecuteConfig(logger: Logger): Promise<
  | {
      noirExecuteWorkingDirectory: string;
      noirExecuteBinaryPath: string;
      cleanup: () => Promise<void>;
    }
  | undefined
> {
  try {
    if (parseBooleanEnv(ACVM_FORCE_WASM)) {
      return undefined;
    }
    const binaryPath = NOIR_EXECUTE_BINARY_PATH || `../../labs-aztec-toolchain/bin/noir-execute`;
    await fs.access(binaryPath, fs.constants.R_OK);
    const tempWorkingDirectory = `${TEMP_DIR}/${randomBytes(4).toString('hex')}`;
    const workingDirectory = NOIR_EXECUTE_WORKING_DIRECTORY || `${tempWorkingDirectory}/noir-execute`;
    await fs.mkdir(workingDirectory, { recursive: true });
    logger.verbose(`Using noir-execute binary at ${binaryPath}`, { binaryPath, workingDirectory });

    const directoryToCleanup = NOIR_EXECUTE_WORKING_DIRECTORY ? undefined : tempWorkingDirectory;

    const cleanup = () => tryRmDir(directoryToCleanup, logger);

    return {
      noirExecuteWorkingDirectory: workingDirectory,
      noirExecuteBinaryPath: binaryPath,
      cleanup,
    };
  } catch (err) {
    logger.verbose(`noir-execute not available, error: ${err}`);
    return undefined;
  }
}
