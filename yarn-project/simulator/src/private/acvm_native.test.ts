import type { NoirCompiledCircuitWithName } from '@aztec-labs/stdlib/noir';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NativeACVMSimulator } from './acvm_native.js';

/** Reaches the artifact cache without running `noir-execute`, which the unit suite has no binary for. */
type ArtifactWriter = { getArtifactPath(artifact: NoirCompiledCircuitWithName): Promise<string> };

describe('NativeACVMSimulator', () => {
  let workingDirectory: string;

  const artifact = {
    name: 'TestCircuit',
    hash: 42,
    abi: { parameters: [], return_type: null, error_types: {} },
    bytecode: 'H4sIAAAAAAAAA-test-bytecode',
    debug_symbols: '',
    file_map: {},
  } as unknown as NoirCompiledCircuitWithName;

  beforeEach(async () => {
    workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'acvm-native-test-'));
  });

  afterEach(async () => {
    await fs.rm(workingDirectory, { recursive: true, force: true });
  });

  describe('artifact cache', () => {
    it('writes the artifact once for repeated executions of the same circuit', async () => {
      const simulator = new NativeACVMSimulator(workingDirectory, 'unused') as unknown as ArtifactWriter;

      const first = await simulator.getArtifactPath(artifact);
      const second = await simulator.getArtifactPath(artifact);

      expect(second).toEqual(first);
    });

    it('writes the same circuit from simulators sharing a working directory', async () => {
      // Two prover nodes under one test share a working directory and each build their own simulator, so
      // the per-simulator cache does not dedupe them: both write this circuit's artifact concurrently.
      const simulators = Array.from(
        { length: 8 },
        () => new NativeACVMSimulator(workingDirectory, 'unused') as unknown as ArtifactWriter,
      );

      const paths = await Promise.all(simulators.map(simulator => simulator.getArtifactPath(artifact)));

      expect(new Set(paths).size).toEqual(1);
      expect(JSON.parse(await fs.readFile(paths[0], 'utf8'))).toMatchObject({
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
