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
});
