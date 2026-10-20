import { ProvingError } from '@aztec-labs/stdlib/errors';
import { makeInboxParityPrivateInputs } from '@aztec-labs/stdlib/testing';
import { getTelemetryClient } from '@aztec-labs/telemetry-client';
import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BBNativeRollupProver } from './bb_prover.js';

describe('BBNativeRollupProver', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-prover-test-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  /**
   * Builds a prover whose `noir-execute` is a shell script, so proving fails during witness generation, before bb is
   * ever started. The script receives the prover file as `$5`, the output directory as `$8` and the witness name as
   * `${10}`.
   */
  async function makeProver(noirExecuteBody: string): Promise<BBNativeRollupProver> {
    const noirExecuteBinaryPath = path.join(workingDirectory, 'noir-execute.sh');
    await fs.writeFile(noirExecuteBinaryPath, `#!/bin/sh\n${noirExecuteBody}\n`, { mode: 0o755 });
    const noirExecuteWorkingDirectory = path.join(workingDirectory, 'acvm');
    const bbWorkingDirectory = path.join(workingDirectory, 'bb');
    await fs.mkdir(noirExecuteWorkingDirectory);
    await fs.mkdir(bbWorkingDirectory);
    return new BBNativeRollupProver(
      {
        bbBinaryPath: path.join(workingDirectory, 'unused-bb'),
        bbWorkingDirectory,
        bbSkipCleanup: false,
        numConcurrentIVCVerifiers: 1,
        bbIVCConcurrency: 1,
        bbChonkVerifyMaxBatch: 1,
        bbChonkVerifyConcurrency: 1,
        noirExecuteBinaryPath,
        noirExecuteWorkingDirectory,
      },
      getTelemetryClient(),
    );
  }

  async function proveWith(prover: BBNativeRollupProver): Promise<unknown> {
    try {
      await prover.getInboxParityProof(makeInboxParityPrivateInputs());
    } catch (err) {
      return err;
    }
    throw new Error('Expected proving to fail');
  }

  it('retries a witness generation process killed by a signal', async () => {
    const err = await proveWith(await makeProver('kill -9 $$'));
    expect(err).toBeInstanceOf(ProvingError);
    expect(err).toMatchObject({ retry: true });
  });

  it('does not retry a circuit that fails to solve', async () => {
    const err = await proveWith(
      await makeProver(`echo "Failed to solve program: 'Cannot satisfy constraint'" >&2\nexit 1`),
    );
    expect(err).toBeInstanceOf(ProvingError);
    expect(err).toMatchObject({ retry: false, message: expect.stringContaining('Cannot satisfy constraint') });
  });

  it('retries a failure to read the generated witness', async () => {
    const parityReturn = {
      /* eslint-disable camelcase */
      start_rolling_hash: '0x00',
      end_rolling_hash: '0x00',
      end_sponge: {
        sponge: {
          cache: ['0x00', '0x00', '0x00'],
          state: ['0x00', '0x00', '0x00', '0x00'],
          cache_size: '0x00',
          squeeze_mode: false,
        },
        num_absorbed: '0x00',
      },
      prover_id: '0x00',
      /* eslint-enable camelcase */
    };
    const prover = await makeProver(`echo '${JSON.stringify({ return: parityReturn })}' > "$5"\ntouch "$8/\${10}.gz"`);
    const readFile = fs.readFile.bind(fs);
    jest.spyOn(fs, 'readFile').mockImplementation((file, options) => {
      if (typeof file === 'string' && file.endsWith('partial-witness.gz')) {
        return Promise.reject(
          Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE', syscall: 'open' }),
        );
      }
      return readFile(file, options);
    });

    const err = await proveWith(prover);
    expect(err).toBeInstanceOf(ProvingError);
    expect(err).toMatchObject({ retry: true, message: expect.stringContaining('EMFILE') });
  });
});
