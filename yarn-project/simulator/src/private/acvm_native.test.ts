import { isRetryableError } from '@aztec-labs/foundation/error';
import type { NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';
import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NativeACVMSimulator } from './acvm_native.js';

/** Reaches the artifact cache without running `noir-execute`, which the unit suite has no binary for. */
type ArtifactWriter = { getArtifactPath(artifact: NoirCompiledCircuitWithName): Promise<string> };

/**
 * Holds every `fs.rename` until `participants` of them have been reached, then lets them all through.
 * Reaching a rename means that writer's `writeFile` has already returned, so this pins the interleaving
 * where every writer has written its aside file before the first rename runs.
 */
function holdRenamesUntilAllWritten(participants: number) {
  const rename = fs.rename.bind(fs);
  let allWritten!: () => void;
  const written = new Promise<void>(resolve => (allWritten = resolve));
  let release!: () => void;
  const released = new Promise<void>(resolve => (release = resolve));
  let arrived = 0;

  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (++arrived === participants) {
      allWritten();
    }
    await released;
    return rename(from, to);
  });

  return { written, release };
}

describe('NativeACVMSimulator', () => {
  let workingDirectory: string;

  /* eslint-disable camelcase */
  const artifact = {
    name: 'TestCircuit',
    hash: 42,
    abi: { parameters: [], return_type: null, error_types: {} },
    bytecode: 'H4sIAAAAAAAAA-test-bytecode',
    debug_symbols: '',
    file_map: {},
  } as unknown as NoirCompiledCircuitWithName;
  /* eslint-enable camelcase */

  beforeEach(async () => {
    workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'acvm-native-test-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  describe('artifact cache', () => {
    it('writes the artifact once for repeated executions of the same circuit', async () => {
      const simulator = new NativeACVMSimulator(workingDirectory, 'unused') as unknown as ArtifactWriter;

      const first = await simulator.getArtifactPath(artifact);
      // A second write would replace this sentinel, so its survival is what shows the cache reused the file.
      await fs.writeFile(first, 'sentinel');
      const second = await simulator.getArtifactPath(artifact);

      expect(second).toEqual(first);
      expect(await fs.readFile(second, 'utf8')).toEqual('sentinel');
    });

    it('writes the same circuit from simulators sharing a working directory', async () => {
      // Two prover nodes under one test share a working directory and each build their own simulator, and a
      // single prover builds one simulator per proof invocation, so the per-simulator cache does not dedupe
      // them: all of these write this circuit's artifact concurrently.
      const simulators = Array.from(
        { length: 8 },
        () => new NativeACVMSimulator(workingDirectory, 'unused') as unknown as ArtifactWriter,
      );

      const { written, release } = holdRenamesUntilAllWritten(simulators.length);
      const paths = Promise.all(simulators.map(simulator => simulator.getArtifactPath(artifact)));
      await written;
      release();

      expect(new Set(await paths).size).toEqual(1);
      expect(JSON.parse(await fs.readFile((await paths)[0], 'utf8'))).toMatchObject({
        hash: 42,
        bytecode: 'H4sIAAAAAAAAA-test-bytecode',
      });
      const leftovers = (await fs.readdir(path.join(workingDirectory, 'artifacts'))).filter(name =>
        name.endsWith('.tmp'),
      );
      expect(leftovers).toEqual([]);
    });
  });

  describe('failure classification', () => {
    /** Writes an executable shell script standing in for `noir-execute`, which receives the prover file as `$5`. */
    async function makeNoirExecute(body: string): Promise<string> {
      const scriptPath = path.join(workingDirectory, 'noir-execute.sh');
      await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return scriptPath;
    }

    async function executeWith(pathToNoirExecute: string): Promise<unknown> {
      const simulator = new NativeACVMSimulator(workingDirectory, pathToNoirExecute);
      try {
        await simulator.executeProtocolCircuit({}, artifact, undefined);
      } catch (err) {
        return err;
      }
      throw new Error('Expected the execution to fail');
    }

    it('retries a child killed by a signal', async () => {
      const err = await executeWith(await makeNoirExecute('kill -9 $$'));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('SIGKILL');
      expect(isRetryableError(err)).toBe(true);
    });

    it('retries a binary that cannot be spawned', async () => {
      const err = await executeWith(path.join(workingDirectory, 'missing-noir-execute'));
      expect(err).toBeInstanceOf(Error);
      expect(isRetryableError(err)).toBe(true);
    });

    it('does not retry a circuit that fails to solve', async () => {
      const err = await executeWith(
        await makeNoirExecute(`echo "Failed to solve program: 'Cannot satisfy constraint'" >&2\nexit 1`),
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Cannot satisfy constraint');
      expect(isRetryableError(err)).toBe(false);
    });

    it('retries a failure to write the inputs to disk', async () => {
      const writeFile = fs.writeFile.bind(fs);
      jest.spyOn(fs, 'writeFile').mockImplementation((file, data, options) => {
        if (typeof file === 'string' && file.endsWith('Prover.json')) {
          return Promise.reject(
            Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' }),
          );
        }
        return writeFile(file, data, options);
      });

      const err = await executeWith(await makeNoirExecute('exit 0'));
      expect(isRetryableError(err)).toBe(true);
    });

    it('does not retry a malformed return value', async () => {
      const err = await executeWith(await makeNoirExecute('echo "not json" > "$5"'));
      expect(err).toBeInstanceOf(SyntaxError);
      expect(isRetryableError(err)).toBe(false);
    });
  });
});
