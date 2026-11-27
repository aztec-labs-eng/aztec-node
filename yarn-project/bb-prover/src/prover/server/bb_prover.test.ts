import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ProvingError } from '@aztec-labs/stdlib/errors';
import { InboxParityPrivateInputs } from '@aztec-labs/stdlib/parity';
import { makeInboxParityPrivateInputs } from '@aztec-labs/stdlib/testing';
import { Attributes, Metrics, getTelemetryClient } from '@aztec-labs/telemetry-client';
import { InMemoryMetrics } from '@aztec-labs/telemetry-client/test';
import { jest } from '@jest/globals';
import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BBJsInstance } from '../../bb/bb_js_backend.js';
import { BBNativeRollupProver, type BBProverConfig } from './bb_prover.js';

describe('BBNativeRollupProver', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-prover-test-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  function makeProverConfig(noirExecuteBinaryPath: string): BBProverConfig {
    return {
      bbBinaryPath: path.join(workingDirectory, 'unused-bb'),
      bbWorkingDirectory: path.join(workingDirectory, 'bb'),
      bbSkipCleanup: false,
      numConcurrentIVCVerifiers: 1,
      bbIVCConcurrency: 1,
      bbChonkVerifyMaxBatch: 1,
      bbChonkVerifyConcurrency: 1,
      noirExecuteBinaryPath,
      noirExecuteWorkingDirectory: path.join(workingDirectory, 'acvm'),
    };
  }

  /**
   * Builds a prover whose `noir-execute` is a shell script, so proving fails during witness generation, before bb is
   * ever started. The script receives the prover file as `$5`, the output directory as `$8` and the witness name as
   * `${10}`.
   */
  async function makeProver(noirExecuteBody: string): Promise<BBNativeRollupProver> {
    const noirExecuteBinaryPath = path.join(workingDirectory, 'noir-execute.sh');
    await fs.writeFile(noirExecuteBinaryPath, `#!/bin/sh\n${noirExecuteBody}\n`, { mode: 0o755 });
    const config = makeProverConfig(noirExecuteBinaryPath);
    await fs.mkdir(config.noirExecuteWorkingDirectory);
    await fs.mkdir(config.bbWorkingDirectory);
    return new BBNativeRollupProver(config, getTelemetryClient());
  }

  async function proveWith(prover: BBNativeRollupProver): Promise<unknown> {
    try {
      await prover.getInboxParityProof(makeInboxParityPrivateInputs());
    } catch (err) {
      return err;
    }
    throw new Error('Expected proving to fail');
  }

  describe('stable bb fallback', () => {
    let config: BBProverConfig;
    let telemetry: InMemoryMetrics;
    const inputs = InboxParityPrivateInputs.fromMessages([Fr.ONE], Fr.ZERO, Fr.ONE);

    beforeEach(async () => {
      telemetry = new InMemoryMetrics();
      const binDirectory = path.resolve('../../labs-aztec-toolchain/bin');
      const bbBinaryPath = path.resolve(process.env.BB_BINARY_PATH || path.join(binDirectory, 'bb-avm'));
      const bbBoostedBinaryPath = path.join(workingDirectory, 'boosted-bb');
      await fs.symlink(bbBinaryPath, bbBoostedBinaryPath);
      config = {
        ...makeProverConfig(process.env.NOIR_EXECUTE_BINARY_PATH || path.join(binDirectory, 'noir-execute')),
        bbBinaryPath,
        bbBoostedBinaryPath,
      };
    });

    afterEach(async () => {
      await telemetry.stop();
    });

    it('returns a valid stable proof after rejecting an invalid boosted proof', async () => {
      const create = BBJsInstance.create.bind(BBJsInstance);
      jest.spyOn(BBJsInstance, 'create').mockImplementation(async (binaryPath, ...options) => {
        const instance = await create(binaryPath, ...options);
        if (binaryPath === config.bbBoostedBinaryPath) {
          const generate = instance.generateProof.bind(instance);
          jest.spyOn(instance, 'generateProof').mockImplementation(async (...args) => {
            const result = await generate(...args);
            const i = Math.floor(result.proofFields.length / 2);
            result.proofFields[i] = Fr.fromBuffer(Buffer.from(result.proofFields[i])).add(Fr.ONE).toBuffer();
            return result;
          });
        }
        return instance;
      });

      const prover = await BBNativeRollupProver.new(config, telemetry);
      const { proof } = await prover.getInboxParityProof(inputs);
      await expect(prover.verifyProof('InboxParity4Artifact', proof.binaryProof)).resolves.toBeUndefined();
      expect((await telemetry.collect())[Metrics.CIRCUIT_PROVING_FALLBACK_COUNT.name]).toEqual([
        { value: 1, attributes: { [Attributes.PROTOCOL_CIRCUIT_NAME]: 'inbox-parity-4' } },
      ]);
    });

    it('propagates a retryable stable verifier startup failure without proving again', async () => {
      const startupError = new ProvingError('Failed to start bb process', undefined, true);
      const create = BBJsInstance.create.bind(BBJsInstance);
      jest.spyOn(BBJsInstance, 'create').mockImplementation((binaryPath, ...options) => {
        return binaryPath === config.bbBinaryPath ? Promise.reject(startupError) : create(binaryPath, ...options);
      });

      const prover = await BBNativeRollupProver.new(config, telemetry);
      await expect(prover.getInboxParityProof(inputs)).rejects.toMatchObject({
        retry: true,
        cause: startupError,
        message: expect.stringMatching(/^Failed to verify proof\b/),
      });
      expect((await telemetry.collect())[Metrics.CIRCUIT_PROVING_FALLBACK_COUNT.name]).toBeUndefined();
    });
  });

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
