import { ProvingError } from '@aztec-labs/stdlib/errors';
import { makeInboxParityPrivateInputs } from '@aztec-labs/stdlib/testing';
import { getTelemetryClient } from '@aztec-labs/telemetry-client';
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
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  /**
   * Builds a prover whose `noir-execute` is a shell script, so witness generation fails before bb is ever started. The
   * bb path is never spawned.
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
});
