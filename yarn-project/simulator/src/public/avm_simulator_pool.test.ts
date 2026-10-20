import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { mock } from 'jest-mock-extended';

import { type AvmContractsDBContext, AvmProcessDiedError } from './avm_simulator.js';
import { type AvmProcessHandle, AvmSimulatorPool, type AvmSimulatorPoolOptions } from './avm_simulator_pool.js';
import type { PublicContractsDB } from './public_db_sources.js';

const RESULT = Uint8Array.from([42]);
const INPUT = Uint8Array.from([1, 2, 3]);

// Process-death failures are flagged retry: true by the generated service; the pool interprets the
// flag and nothing above it ever sees it.
const processDeathError = (message: string) => Object.assign(new Error(message), { retry: true });

class FakeAvmService implements AvmProcessHandle {
  public destroyed = false;

  constructor(private onSimulate: (service: FakeAvmService) => Promise<Uint8Array> = () => Promise.resolve(RESULT)) {}

  simulate(): Promise<Uint8Array> {
    return this.onSimulate(this);
  }

  simulateWithHints(): Promise<Uint8Array> {
    return this.onSimulate(this);
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

describe('AvmSimulatorPool', () => {
  const context: AvmContractsDBContext = { contractsDB: mock<PublicContractsDB>(), forkId: 1, timestamp: 0n };
  const pools: AvmSimulatorPool[] = [];

  const makePool = (
    spawnProcess: () => Promise<AvmProcessHandle>,
    options: Partial<AvmSimulatorPoolOptions> = {},
  ): AvmSimulatorPool => {
    const pool = new AvmSimulatorPool({
      wsdbIpcPath: '/tmp/unused-wsdb.sock',
      maxSize: 2,
      spawnRetryIntervalMs: 1,
      spawnProcess,
      ...options,
    });
    pools.push(pool);
    return pool;
  };

  afterEach(async () => {
    await Promise.all(pools.splice(0).map(pool => pool.destroy().catch(() => {})));
  });

  it('simulates on a pooled service', async () => {
    const pool = makePool(() => Promise.resolve(new FakeAvmService()));
    await expect(pool.simulate(INPUT, context)).resolves.toEqual(RESULT);
  });

  it('keeps retrying environmental spawn failures until one succeeds', async () => {
    let attempts = 0;
    const pool = makePool(() => {
      attempts++;
      return attempts < 8 ? Promise.reject(processDeathError('spawn failed')) : Promise.resolve(new FakeAvmService());
    });
    await expect(pool.simulate(INPUT, context)).resolves.toEqual(RESULT);
    expect(attempts).toBe(8);
  });

  it('stops the spawn retry loop when the caller aborts', async () => {
    let attempts = 0;
    const pool = makePool(() => {
      attempts++;
      return Promise.reject(processDeathError('spawn failed'));
    });
    const controller = new AbortController();
    const simulation = pool.simulate(INPUT, context, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    await expect(simulation).rejects.toThrow(/aborted/);
    const attemptsAtAbort = attempts;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(attempts).toBe(attemptsAtAbort);
  });

  it('propagates configuration spawn errors immediately instead of retrying', async () => {
    let attempts = 0;
    const pool = makePool(() => {
      attempts++;
      return Promise.reject(new Error('bb-avm-sim binary not found'));
    });
    await expect(pool.simulate(INPUT, context)).rejects.toThrow(/binary not found/);
    expect(attempts).toBe(1);
  });

  it('re-issues a simulation once when its process dies', async () => {
    // The service respawns its process under the hood, so the retry lands on the same handle.
    let calls = 0;
    const pool = makePool(() =>
      Promise.resolve(
        new FakeAvmService(() => {
          calls++;
          return calls === 1 ? Promise.reject(processDeathError('process died mid-call')) : Promise.resolve(RESULT);
        }),
      ),
    );
    await expect(pool.simulate(INPUT, context)).resolves.toEqual(RESULT);
    expect(calls).toBe(2);
  });

  it('fails with AvmProcessDiedError when the re-issued simulation also loses its process', async () => {
    let calls = 0;
    const pool = makePool(() =>
      Promise.resolve(
        new FakeAvmService(() => {
          calls++;
          return Promise.reject(processDeathError('process died mid-call'));
        }),
      ),
    );
    const err = await pool.simulate(INPUT, context).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(AvmProcessDiedError);
    // No retry flag, so nothing above the pool re-issues it a third time; the last death is kept as the cause.
    expect((err as Error & { retry?: unknown }).retry).toBeUndefined();
    expect((err?.cause as { retry?: unknown } | undefined)?.retry).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails with AvmProcessDiedError when the two deaths happen on two different processes', async () => {
    const VICTIM = Uint8Array.from([1]);
    const FILLER = Uint8Array.from([2]);
    const BLOCKER = Uint8Array.from([3]);
    const calls: { process: string; input: number }[] = [];
    const firstDeath = promiseWithResolvers<void>();
    const fillerDone = promiseWithResolvers<void>();
    const blockerDone = promiseWithResolvers<void>();

    /** A process that serves its calls from a script, one entry per call, recording which input it ran. */
    const scripted = (name: string, script: (() => Promise<Uint8Array>)[]): AvmProcessHandle => ({
      simulate: (input: Uint8Array) => {
        calls.push({ process: name, input: input[0] });
        return script.shift()!();
      },
      simulateWithHints: () => Promise.reject(new Error('unused')),
      destroy: () => Promise.resolve(),
    });

    // p0 serves the victim and dies, then serves the blocker until told to finish, so the next free process is p1.
    const p0 = scripted('p0', [
      async () => {
        await firstDeath.promise;
        throw processDeathError('bb-avm-sim exited unexpectedly (signal=SIGKILL)');
      },
      async () => {
        await blockerDone.promise;
        return RESULT;
      },
    ]);
    // p1 serves the filler, then the victim's retry, and dies under it.
    const p1 = scripted('p1', [
      async () => {
        await fillerDone.promise;
        return RESULT;
      },
      () => Promise.reject(processDeathError('bb-avm-sim exited unexpectedly (signal=SIGKILL)')),
    ]);
    const spawned = [p0, p1];
    const pool = makePool(() => Promise.resolve(spawned.shift()!), { maxSize: 2 });
    const tick = () => new Promise(resolve => setTimeout(resolve, 5));

    const victim = pool.simulate(VICTIM, context).then(
      () => undefined,
      (e: Error) => e,
    );
    await tick();
    const filler = pool.simulate(FILLER, context);
    await tick();
    // A queued waiter is handed the freed process before it goes back on the free list, so the victim's retry
    // cannot land on p0 again.
    const blocker = pool.simulate(BLOCKER, context);
    await tick();

    firstDeath.resolve();
    await tick();
    fillerDone.resolve();
    const err = await victim;
    blockerDone.resolve();

    await expect(filler).resolves.toEqual(RESULT);
    await expect(blocker).resolves.toEqual(RESULT);
    expect(calls.filter(call => call.input === VICTIM[0]).map(call => call.process)).toEqual(['p0', 'p1']);
    expect(err).toBeInstanceOf(AvmProcessDiedError);
  });

  it('does not re-issue simulations that fail on their own merits', async () => {
    let calls = 0;
    const pool = makePool(() =>
      Promise.resolve(
        new FakeAvmService(() => {
          calls++;
          return Promise.reject(new Error('simulation rejected the input'));
        }),
      ),
    );
    await expect(pool.simulate(INPUT, context)).rejects.toThrow(/rejected the input/);
    expect(calls).toBe(1);
  });

  it('rejects a checkout waiting on a full pool when the caller aborts', async () => {
    const blockedSim = promiseWithResolvers<Uint8Array>();
    const pool = makePool(() => Promise.resolve(new FakeAvmService(() => blockedSim.promise)), { maxSize: 1 });

    const sim1 = pool.simulate(INPUT, context);
    await new Promise(resolve => setTimeout(resolve, 10));

    const controller = new AbortController();
    const sim2 = pool.simulate(INPUT, context, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(sim2).rejects.toThrow(/aborted/);

    blockedSim.resolve(RESULT);
    await expect(sim1).resolves.toEqual(RESULT);
  });

  it('rejects queued checkouts when the pool is destroyed', async () => {
    const blockedSim = promiseWithResolvers<Uint8Array>();
    const pool = makePool(() => Promise.resolve(new FakeAvmService(() => blockedSim.promise)), { maxSize: 1 });

    const sim1 = pool.simulate(INPUT, context);
    await new Promise(resolve => setTimeout(resolve, 10));
    const sim2 = pool.simulate(INPUT, context);
    await new Promise(resolve => setTimeout(resolve, 10));

    const destroyPromise = pool.destroy();
    await expect(sim2).rejects.toThrow(/destroyed/);
    blockedSim.resolve(RESULT);
    await expect(sim1).resolves.toEqual(RESULT);
    await destroyPromise;
  });
});
