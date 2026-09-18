import { BackendType, Barretenberg, BarretenbergSync } from '@aztec-foundation/bb.js';
import { findBbBinary, findNapiBinary, findPackageRoot } from '@aztec-foundation/bb.js/platform';

import { median } from '@aztec-labs/foundation/collection';
import * as crypto from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { type Fieldable, serializeToFields } from '@aztec-labs/foundation/serialize';
import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

let api: Barretenberg | BarretenbergSync;
const log = createLogger('blob-lib:sponge-bench');

// Keep foundation's field serialization, but bypass its singleton/backend selection inside this benchmark only.
jest.unstable_mockModule('@aztec-labs/foundation/crypto/poseidon', () => ({
  ...crypto,
  poseidon2Permutation: async (input: Fieldable[]) => {
    const command = { inputs: serializeToFields(input).map(field => field.toBuffer()) };
    const response =
      api instanceof BarretenbergSync ? api.poseidon2Permutation(command) : await api.poseidon2Permutation(command);
    return response.outputs.map(field => Fr.fromBuffer(Buffer.from(field)));
  },
  poseidon2AbsorbChain: async (state: Fr[], inputs: Fr[]) => {
    const flat = Buffer.allocUnsafe(inputs.length * 32);
    for (let i = 0; i < inputs.length; i++) {
      flat.set(inputs[i].toBuffer(), i * 32);
    }
    const command = { state: state.map(field => field.toBuffer()), inputs: flat };
    const response =
      api instanceof BarretenbergSync ? api.poseidon2AbsorbChain(command) : await api.poseidon2AbsorbChain(command);
    return response.state.map(field => Fr.fromBuffer(Buffer.from(field)));
  },
}));

const { Poseidon2Sponge, SpongeBlob } = await import('./sponge_blob.js');

/** The field-by-field baseline from sponge_blob.test.ts, retaining the async absorption interface. */
async function absorbPerField(this: InstanceType<typeof Poseidon2Sponge>, fields: Fr[]) {
  if (this.squeezeMode) {
    throw new Error('Poseidon sponge is not able to absorb more inputs.');
  }
  for (const field of fields) {
    if (this.cacheSize === this.cache.length) {
      await this.performDuplex();
      this.cache[0] = field;
      this.cacheSize = 1;
    } else {
      this.cache[this.cacheSize++] = field;
    }
  }
}

const algorithms = ['old', 'new'] as const;
/** Which absorption implementation to install on a fresh production sponge. */
type Algorithm = (typeof algorithms)[number];

function createSponge(algorithm: Algorithm) {
  const sponge = SpongeBlob.init();
  sponge.sponge.absorb = algorithm === 'old' ? absorbPerField : Poseidon2Sponge.prototype.absorb;
  return sponge;
}

const scenarios = [
  { fields: 3, chunkSize: 3 },
  { fields: 30, chunkSize: 30 },
  { fields: 300, chunkSize: 300 },
  { fields: 3_000, chunkSize: 3_000 },
  { fields: 24_576, chunkSize: 24_576 },
  { fields: 24_576, chunkSize: 50 },
  { fields: 24_576, chunkSize: 500 },
];
const boundaryLengths = [
  [],
  [0],
  [5],
  [4],
  [7],
  [3, 1],
  [3, 2],
  [3, 5],
  [2, 2],
  [1, 1, 1, 1, 1],
  [1, 4, 6],
  [0, 3, 0, 4],
  [10, 11, 3, 7],
];
const warmups = 3;
const sampleCount = 15;
const targetMs = 100;
const maxRepetitions = 1_000;

function makeChunks(lengths: number[]) {
  let next = 123;
  return lengths.map(length => Array.from({ length }, () => new Fr(next++)));
}

async function operation(algorithm: Algorithm, chunks: Fr[][]) {
  const sponge = createSponge(algorithm);
  for (const chunk of chunks) {
    await sponge.absorb(chunk);
  }
  return await sponge.squeeze();
}

async function elapsed(algorithm: Algorithm, chunks: Fr[][], repetitions: number) {
  const start = performance.now();
  for (let i = 0; i < repetitions; i++) {
    await operation(algorithm, chunks);
  }
  return performance.now() - start;
}

/** Complete serialized sponge states and final hash, retained for cross-backend comparison. */
type Trace = { states: string[][]; hash: string; finalState: string[] };

async function validate(chunks: Fr[][]): Promise<Trace> {
  const old = createSponge('old');
  const current = createSponge('new');
  const states: string[][] = [];
  expect(current.toFields()).toEqual(old.toFields());
  for (const chunk of chunks) {
    await old.absorb(chunk);
    await current.absorb(chunk);
    expect(current.toFields()).toEqual(old.toFields());
    states.push(old.toFields().map(field => field.toString()));
  }
  const hash = await old.squeeze();
  expect(await current.squeeze()).toEqual(hash);
  expect(current.toFields()).toEqual(old.toFields());
  return { states, hash: hash.toString(), finalState: old.toFields().map(field => field.toString()) };
}

function summarize(samples: number[], repetitions: number) {
  const sorted = samples.map(ms => ms / repetitions).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const q1 = median(sorted.slice(0, middle))!;
  const q3 = median(sorted.slice(middle + 1))!;
  return { medianMs: median(sorted)!, q1Ms: q1, q3Ms: q3, iqrMs: q3 - q1 };
}

/** Raw elapsed sample times and per-operation summaries for one paired comparison. */
type Result = {
  backend: string;
  fields: number;
  chunkSize: number;
  repetitions: number;
  pilotMs: Record<Algorithm, number>;
  samplesMs: Record<Algorithm, number[]>;
  old: ReturnType<typeof summarize>;
  new: ReturnType<typeof summarize>;
  speedup: number;
};

const benchmark = process.env.SPONGE_BENCH === '1' ? it : it.skip;

benchmark(
  'compares sponge absorption across explicit bb transports',
  async () => {
    const output = resolve(process.env.SPONGE_BENCH_OUTPUT ?? 'bench-out/sponge');
    const bbPath = findBbBinary();
    const options = { threads: 1, skipSrsInit: true, ...(bbPath ? { bbPath } : {}) };
    const backends = [
      { name: 'native UDS', create: () => Barretenberg.new({ ...options, backend: BackendType.NativeUnixSocket }) },
      {
        name: 'native async SHM',
        create: () => Barretenberg.new({ ...options, backend: BackendType.NativeSharedMemory }),
      },
      {
        name: 'native sync SHM',
        create: () => BarretenbergSync.new({ ...options, backend: BackendType.NativeSharedMemory }),
      },
      { name: 'sync Wasm', create: () => BarretenbergSync.new({ ...options, backend: BackendType.Wasm }) },
    ];
    const cases = scenarios.map(scenario => ({
      ...scenario,
      chunks: makeChunks(
        Array.from({ length: Math.ceil(scenario.fields / scenario.chunkSize) }, (_, i) =>
          Math.min(scenario.chunkSize, scenario.fields - i * scenario.chunkSize),
        ),
      ),
    }));
    const validationCases = [...boundaryLengths.map(makeChunks), ...cases.map(scenario => scenario.chunks)];
    const reference: Trace[] = [];
    const results: Result[] = [];
    const failures: { backend: string; error: string }[] = [];
    const packageRoot = findPackageRoot();
    if (!packageRoot) {
      throw new Error('Cannot locate bb.js package metadata');
    }
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const command =
      'SPONGE_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.bench.test.ts';
    const metadata = {
      startedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
      bbJsVersion: packageJson.version,
      nativeBinary: bbPath,
      nativeBinaryVersion: bbPath ? execFileSync(bbPath, ['--version'], { encoding: 'utf8' }).trim() : 'unavailable',
      napiBinary: findNapiBinary(),
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      threads: 1,
      command,
      cwd: process.cwd(),
      output,
      overrides: { BB_BINARY_PATH: process.env.BB_BINARY_PATH, BB_WASM_PATH: process.env.BB_WASM_PATH },
      warmups,
      sampleCount,
      targetMs,
      maxRepetitions,
      order: 'Serial backends/scenarios; even samples old/new, odd samples new/old',
      quartiles: 'Medians of lower/upper halves, excluding the median (Tukey hinges)',
    };
    await mkdir(dirname(output), { recursive: true });
    for (const backend of backends) {
      try {
        api = await backend.create();
      } catch (error) {
        failures.push({ backend: backend.name, error: String(error) });
        continue;
      }
      try {
        for (const [index, chunks] of validationCases.entries()) {
          const trace = await validate(chunks);
          if (reference[index]) {
            expect(trace).toEqual(reference[index]);
          } else {
            reference[index] = trace;
          }
        }
        for (const { fields, chunkSize, chunks } of cases) {
          for (let i = 0; i < warmups; i++) {
            for (const algorithm of algorithms) {
              await operation(algorithm, chunks);
            }
          }
          const pilotMs = { old: (await elapsed('old', chunks, 3)) / 3, new: (await elapsed('new', chunks, 3)) / 3 };
          const repetitions = Math.min(
            maxRepetitions,
            Math.max(1, Math.ceil(targetMs / Math.min(pilotMs.old, pilotMs.new))),
          );
          const samplesMs: Record<Algorithm, number[]> = { old: [], new: [] };
          for (let sample = 0; sample < sampleCount; sample++) {
            const order = sample % 2 === 0 ? algorithms : [...algorithms].reverse();
            for (const algorithm of order) {
              samplesMs[algorithm].push(await elapsed(algorithm, chunks, repetitions));
            }
          }
          const old = summarize(samplesMs.old, repetitions);
          const current = summarize(samplesMs.new, repetitions);
          results.push({
            backend: backend.name,
            fields,
            chunkSize,
            repetitions,
            pilotMs,
            samplesMs,
            old,
            new: current,
            speedup: old.medianMs / current.medianMs,
          });
          log.info('Completed sponge comparison', {
            backend: backend.name,
            fields,
            chunkSize,
            speedup: old.medianMs / current.medianMs,
          });
        }
      } finally {
        await api.destroy();
      }
    }
    const format = (summary: ReturnType<typeof summarize>) =>
      `${summary.medianMs.toFixed(4)} [${summary.q1Ms.toFixed(4)}, ${summary.q3Ms.toFixed(4)}]`;
    const table = [
      '| Backend | Fields | Chunk | Old ms/op [Q1, Q3] | New ms/op [Q1, Q3] | Old/new | Repetitions |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...results.map(
        row =>
          `| ${row.backend} | ${row.fields} | ${row.chunkSize} | ${format(row.old)} | ${format(row.new)} | ${row.speedup.toFixed(2)}x | ${row.repetitions} |`,
      ),
    ].join('\n');
    const report =
      [
        `Commit: ${metadata.commit}; bb.js: ${metadata.bbJsVersion}; native: ${metadata.nativeBinaryVersion}.`,
        `${metadata.node}; ${metadata.os} ${metadata.arch}; ${metadata.cpu}; one backend thread.`,
        `Run from yarn-project: \`${command}\`. Output prefix: \`${output}\`.`,
        'Fresh sponge through squeeze, including field serialization. Startup, input generation, validation and reporting excluded.',
        'Three warmups per pair; three-operation pilot selects a common repetition count targeting 100 ms for the faster algorithm, capped at 1,000. Fifteen samples alternate old/new order. No dependent permutations are pipelined.',
        'Times are medians with interquartile ranges [Q1, Q3]; raw sample totals, IQR widths and pilot timings are in JSON. The cap and timing variation can leave samples below 100 ms. No speedup threshold is enforced.',
        table,
        ...failures.map(failure => `Unavailable (results pending): ${failure.backend}: ${failure.error}`),
      ].join('\n\n') + '\n';
    await writeFile(
      `${output}.json`,
      JSON.stringify({ metadata, results, failures, validationCases: validationCases.length }, null, 2) + '\n',
    );
    await writeFile(`${output}.md`, report);
    log.info(report);
    expect(failures).toEqual([]);
  },
  60 * 60 * 1_000,
);
