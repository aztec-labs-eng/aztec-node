import { BackendType, Barretenberg, BarretenbergSync } from '@aztec-foundation/bb.js';
import { findBbBinary, findNapiBinary, findPackageRoot } from '@aztec-foundation/bb.js/platform';

import { CONTRACT_CLASS_LOG_SIZE_IN_FIELDS, PRIVATE_LOG_SIZE_IN_FIELDS } from '@aztec-labs/constants';
import { median } from '@aztec-labs/foundation/collection';
import * as crypto from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { type Fieldable, serializeToFields } from '@aztec-labs/foundation/serialize';
import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

let api: Barretenberg | BarretenbergSync;
let diagnostic: number[] | undefined;
let checkHashes = false;
const log = createLogger('stdlib:tx-effects-transport-bench');

async function hashFields(fields: Fr[]) {
  diagnostic?.push(fields.length);
  const command = { inputs: fields.map(field => field.toBuffer()) };
  const response = api instanceof BarretenbergSync ? api.poseidon2Hash(command) : await api.poseidon2Hash(command);
  const hash = Fr.fromBuffer(Buffer.from(response.hash));
  if (checkHashes) {
    expect(hash).toEqual(await crypto.poseidon2Hash(fields));
  }
  return hash;
}

function poseidon2Hash(input: Fieldable[]) {
  return hashFields(serializeToFields(input));
}

// Retain production serialization and Promise interfaces while selecting a real backend without singleton fallback.
jest.unstable_mockModule('@aztec-labs/foundation/crypto/poseidon', () => ({
  ...crypto,
  poseidon2Hash,
  poseidon2HashWithSeparator: (input: Fieldable[], separator: number) => {
    const fields = serializeToFields(input);
    fields.unshift(new Fr(separator));
    return hashFields(fields);
  },
}));

const { computeUnbalancedMerkleTreeRootAsync } = await import('@aztec-labs/foundation/trees');
const { AztecAddress } = await import('../aztec-address/index.js');
const { PublicDataWrite } = await import('../avm/public_data_write.js');
const { RevertCode } = await import('../avm/revert_code.js');
const { Body } = await import('../block/body.js');
const { ContractClassLog, ContractClassLogFields } = await import('../logs/contract_class_log.js');
const { PrivateLog } = await import('../logs/private_log.js');
const { PublicLog } = await import('../logs/public_log.js');
const { TxEffect } = await import('./tx_effect.js');
const { computeTxEffectsTreeData, txEffectsTreeNodeHash } = await import('./tx_effect_membership.js');
const { TxHash } = await import('./tx_hash.js');

const profiles = ['sparse', 'small-categories', 'log-heavy'] as const;
/** Deterministic effects distributions, rather than a claim about live traffic frequencies. */
type Profile = (typeof profiles)[number];

function makeEffects(profile: Profile, count: number) {
  let next = 1;
  const field = () => new Fr(next++);
  const fields = (length: number) => Array.from({ length }, field);
  return Array.from({ length: count }, () => {
    const sparse = profile === 'sparse';
    const heavy = profile === 'log-heavy';
    const privateFields = fields(heavy ? PRIVATE_LOG_SIZE_IN_FIELDS : 2);
    const classFields = heavy ? fields(CONTRACT_CLASS_LOG_SIZE_IN_FIELDS) : [];
    return new TxEffect(
      RevertCode.OK,
      new TxHash(field()),
      field(),
      sparse ? [] : fields(2),
      fields(1),
      sparse ? [] : fields(1),
      sparse ? [] : [new PublicDataWrite(field(), field())],
      sparse ? [] : [PrivateLog.fromBlobFields(privateFields.length, privateFields)],
      sparse ? [] : [new PublicLog(new AztecAddress(field()), fields(heavy ? 64 : 2))],
      heavy
        ? [new ContractClassLog(new AztecAddress(field()), new ContractClassLogFields(classFields), classFields.length)]
        : [],
    );
  });
}

/** A complete operation, with inputs and (for internal trees) leaves prepared outside timing. */
type Scenario = {
  name: string;
  run: () => Promise<unknown>;
  requests: number;
};

async function makeScenarios() {
  const inputs = Array.from({ length: 64 }, (_, i) => [new Fr(i + 1), new Fr(i + 2), new Fr(i + 3)]);
  const scenarios: Scenario[] = [
    {
      name: 'hash-3-fields/sequential-64',
      requests: 64,
      run: async () => {
        const hashes: Fr[] = [];
        for (const input of inputs) {
          hashes.push(await poseidon2Hash(input));
        }
        return hashes;
      },
    },
    { name: 'hash-3-fields/concurrent-64', requests: 64, run: () => Promise.all(inputs.map(poseidon2Hash)) },
  ];
  for (const count of [1, 3, 16, 64]) {
    for (const profile of profiles) {
      const effects = makeEffects(profile, count);
      const requests = count * (profile === 'sparse' ? 3 : profile === 'small-categories' ? 8 : 10);
      const data = await computeTxEffectsTreeData(effects);
      const leaves = data.leaves.map(leaf => leaf.toBuffer());
      scenarios.push(
        { name: `${profile}/${count}/leaves`, requests, run: () => computeTxEffectsTreeData(effects) },
        {
          name: `${profile}/${count}/complete`,
          requests: requests + count - 1,
          run: () => new Body(effects).computeTxEffectsTree(),
        },
      );
      if (profile === 'sparse' && count > 1) {
        scenarios.push({
          name: `internal-tree/${count}`,
          requests: count - 1,
          run: () => computeUnbalancedMerkleTreeRootAsync(leaves, txEffectsTreeNodeHash),
        });
      }
    }
  }
  return scenarios;
}

const warmups = 3;
const rounds = 3;
const samplesPerRound = 5;
const targetMs = 100;
const maxRepetitions = 1_000;

async function elapsed(run: Scenario['run'], repetitions: number) {
  const start = performance.now();
  for (let i = 0; i < repetitions; i++) {
    await run();
  }
  return performance.now() - start;
}

function summarize(samplesMs: number[], repetitions = 1) {
  const sorted = samplesMs.map(ms => ms / repetitions).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = median(sorted)!;
  const q1Ms = median(sorted.slice(0, middle))!;
  const q3Ms = median(sorted.slice(middle + (sorted.length % 2)))!;
  return { medianMs, q1Ms, q3Ms, iqrMs: q3Ms - q1Ms, operationsPerSecond: 1_000 / medianMs };
}

/** Samples remain grouped by round so order and drift can be inspected. */
type Result = {
  backend: string;
  scenario: string;
  pilotMs: number;
  repetitions: number;
  roundsMs: number[][];
};

/** Worker-generated ping round trips include time waiting for the main thread to service messages. */
type Ping = { sent: number; latencyMs: number };

async function responsiveness(run: Scenario['run']) {
  const ready = promiseWithResolvers<void>();
  const done = promiseWithResolvers<Ping[]>();
  const worker = new Worker(new URL('../../benchmarks/tx_effects_ping_worker.mjs', import.meta.url));
  worker.on('error', error => {
    ready.reject(error);
    done.reject(error);
  });
  worker.on('message', (message: { type: string; sent?: number; pings?: Ping[] }) => {
    if (message.type === 'ready') {
      ready.resolve();
    } else if (message.type === 'ping') {
      worker.postMessage(message);
    } else if (message.type === 'done' && message.pings) {
      done.resolve(message.pings);
    }
  });
  const timerDelays: number[] = [];
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    timerDelays.push(Math.max(0, now - lastTick - 5));
    lastTick = now;
  }, 5);
  try {
    await ready.promise;
    await delay(20);
    timerDelays.length = 0;
    lastTick = performance.now();
    const started = performance.now();
    let operations = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        do {
          await run();
          operations++;
        } while (performance.now() - started < 1_000);
      }),
    );
    const finished = performance.now();
    // Let delayed callbacks run before reading timer drift, including after sync microtask starvation.
    await delay(20);
    clearInterval(timer);
    worker.postMessage({ type: 'stop' });
    const pings = (await done.promise).filter(ping => ping.sent >= started && ping.sent < finished);
    expect(pings.length).toBeGreaterThan(0);
    const sorted = pings.map(ping => ping.latencyMs).sort((a, b) => a - b);
    return {
      operations,
      elapsedMs: finished - started,
      operationsPerSecond: (operations * 1_000) / (finished - started),
      pingP50Ms: median(sorted)!,
      pingP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      pingMaxMs: sorted[sorted.length - 1],
      timerMaxDelayMs: Math.max(...timerDelays),
      pings,
    };
  } finally {
    clearInterval(timer);
    await worker.terminate();
  }
}

const benchmark = process.env.TX_EFFECTS_BENCH === '1' ? it : it.skip;

benchmark(
  'compares transaction-effects hashing across explicit transports',
  async () => {
    const output = resolve(process.env.TX_EFFECTS_BENCH_OUTPUT ?? 'bench-out/tx-effects-transport');
    const bbPath = findBbBinary();
    const options = { threads: 1, skipSrsInit: true, ...(bbPath ? { bbPath } : {}) };
    const backends = [
      { name: 'UDS', create: () => Barretenberg.new({ ...options, backend: BackendType.NativeUnixSocket }) },
      { name: 'async SHM', create: () => Barretenberg.new({ ...options, backend: BackendType.NativeSharedMemory }) },
      { name: 'sync SHM', create: () => BarretenbergSync.new({ ...options, backend: BackendType.NativeSharedMemory }) },
    ];
    const packageRoot = findPackageRoot();
    if (!packageRoot || !bbPath) {
      throw new Error('Native bb binary and package metadata are required; no backend fallback is allowed');
    }
    const metadata = {
      startedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
      bbJsVersion: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version,
      nativeBinary: bbPath,
      nativeBinaryVersion: execFileSync(bbPath, ['--version'], { encoding: 'utf8' }).trim(),
      napiBinary: findNapiBinary(),
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      threads: 1,
      command:
        'TX_EFFECTS_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/stdlib test src/tx/tx_effects_transport.bench.test.ts',
      cwd: process.cwd(),
      output,
      overrides: { BB_BINARY_PATH: process.env.BB_BINARY_PATH, BB_WASM_PATH: process.env.BB_WASM_PATH },
      warmups,
      rounds,
      samplesPerRound,
      targetMs,
      maxRepetitions,
      order:
        'Calibration UDS/async SHM/sync SHM; round r rotates backend order by r and reverses scenario order on odd rounds',
    };
    const results: Result[] = [];
    const references = new Map<string, unknown>();
    const diagnostics: { scenario: string; fieldsPerRequest: number[] }[] = [];
    const probes: {
      backend: string;
      round: number;
      scenario: string;
      result: Awaited<ReturnType<typeof responsiveness>>;
    }[] = [];
    await mkdir(dirname(output), { recursive: true });

    for (const backend of backends) {
      api = await backend.create();
      try {
        checkHashes = true;
        const scenarios = await makeScenarios();
        expect(await Body.empty().computeTxEffectsTree()).toEqual({ root: Fr.ZERO, leaves: [], categoriesHashes: [] });
        for (const scenario of scenarios) {
          diagnostic = [];
          const result = await scenario.run();
          expect(diagnostic.length).toBe(scenario.requests);
          if (references.has(scenario.name)) {
            expect(result).toEqual(references.get(scenario.name));
            expect([...diagnostic].sort((a, b) => a - b)).toEqual(
              [...diagnostics.find(row => row.scenario === scenario.name)!.fieldsPerRequest].sort((a, b) => a - b),
            );
          } else {
            references.set(scenario.name, result);
            diagnostics.push({ scenario: scenario.name, fieldsPerRequest: diagnostic });
          }
          diagnostic = undefined;
        }
        checkHashes = false;
        await Barretenberg.destroySingleton();
        for (const scenario of scenarios) {
          await elapsed(scenario.run, warmups);
          results.push({
            backend: backend.name,
            scenario: scenario.name,
            pilotMs: (await elapsed(scenario.run, 3)) / 3,
            repetitions: 0,
            roundsMs: [],
          });
        }
      } finally {
        diagnostic = undefined;
        checkHashes = false;
        await Barretenberg.destroySingleton();
        await api.destroy();
      }
    }
    for (const row of results) {
      const fastest = Math.min(...results.filter(other => other.scenario === row.scenario).map(other => other.pilotMs));
      row.repetitions = Math.min(maxRepetitions, Math.max(1, Math.ceil(targetMs / fastest)));
    }

    for (let round = 0; round < rounds; round++) {
      const order = [...backends.slice(round), ...backends.slice(0, round)];
      for (const backend of order) {
        api = await backend.create();
        try {
          const scenarios = await makeScenarios();
          if (round % 2) {
            scenarios.reverse();
          }
          for (const scenario of scenarios) {
            expect(await scenario.run()).toEqual(references.get(scenario.name));
            await elapsed(scenario.run, warmups);
            const row = results.find(row => row.backend === backend.name && row.scenario === scenario.name)!;
            const samples: number[] = [];
            for (let sample = 0; sample < samplesPerRound; sample++) {
              samples.push(await elapsed(scenario.run, row.repetitions));
            }
            row.roundsMs.push(samples);
          }
          log.info('Completed timing round', { backend: backend.name, round });
        } finally {
          await api.destroy();
        }
      }
    }

    for (let round = 0; round < rounds; round++) {
      for (const backend of [...backends.slice(round), ...backends.slice(0, round)]) {
        api = await backend.create();
        try {
          const effects = makeEffects('small-categories', 64);
          const run = () => new Body(effects).computeTxEffectsTree();
          await elapsed(run, warmups);
          probes.push({
            backend: backend.name,
            round,
            scenario: 'small-categories/64/complete',
            result: await responsiveness(run),
          });
        } finally {
          await api.destroy();
        }
      }
    }

    const summaries = results.map(row => ({ ...row, ...summarize(row.roundsMs.flat(), row.repetitions) }));
    const format = (row: ReturnType<typeof summarize>) =>
      `${row.medianMs.toFixed(3)} [${row.q1Ms.toFixed(3)}, ${row.q3Ms.toFixed(3)}]`;
    const table = [
      '| Workload | UDS ms/op [Q1, Q3] | Async SHM ms/op [Q1, Q3] | Sync SHM ms/op [Q1, Q3] | UDS/sync | Saved ms/op |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      ...diagnostics.map(({ scenario }) => {
        const rows = backends.map(
          backend => summaries.find(row => row.backend === backend.name && row.scenario === scenario)!,
        );
        return `| ${scenario} | ${rows.map(format).join(' | ')} | ${(rows[0].medianMs / rows[2].medianMs).toFixed(2)}x | ${(rows[0].medianMs - rows[2].medianMs).toFixed(3)} |`;
      }),
    ].join('\n');
    const probeTable = [
      '| Backend | Round | Complete ops/s (4 concurrent loops) | Ping p50 ms | Ping p95 ms | Ping max ms | Timer max delay ms |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...probes.map(
        ({ backend, round, result }) =>
          `| ${backend} | ${round + 1} | ${result.operationsPerSecond.toFixed(1)} | ${result.pingP50Ms.toFixed(2)} | ${result.pingP95Ms.toFixed(2)} | ${result.pingMaxMs.toFixed(2)} | ${result.timerMaxDelayMs.toFixed(2)} |`,
      ),
    ].join('\n');
    await writeFile(
      `${output}.json`,
      JSON.stringify({ metadata, diagnostics, results: summaries, probes }, null, 2) + '\n',
    );
    await writeFile(
      `${output}.md`,
      `${metadata.cpu}; ${metadata.os} ${metadata.arch}; ${metadata.node}; bb.js ${metadata.bbJsVersion}; commit ${metadata.commit}.\n\n${table}\n\n${probeTable}\n`,
    );
    log.info('Wrote transport benchmark results', { output });
  },
  60 * 60 * 1_000,
);
